# M2-D2 Result Release Authority Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make public result visibility depend on an explicit, audited release of the current closed `StageResult`, while preserving the existing editorial workflow for non-result posts.

**Architecture:** Keep `PublicPost.Status.PUBLISHED` as editorial state and add a historical `ResultRelease` authority owned by `public_portal`. Release commands validate the M2-D1 closure, exact current stage result, formal activity, current ruleset, post version, admin re-authentication, and audit reason. A single fail-closed public queryset gates posts and media; stage unlock/re-resolution supersedes releases in the same transaction.

**Tech Stack:** Django ORM and migrations, Django `TestCase`/PostgreSQL `TransactionTestCase`, PowerShell Docker rehearsal scripts, existing admin re-authentication and authority-write scopes, openpyxl archive exports, Ruff/mypy/Pyright/Playwright.

**Spec:** `docs/superpowers/specs/2026-09-21-m2-d2-result-release-authority-design.md`

## Global Constraints

- `PublicPost.Status.PUBLISHED` remains an editorial/content state and never substitutes for `RELEASED`.
- Only an explicit active `ResultRelease` can expose a `RESULT_PUBLICATION` post.
- Result release mutation must pass the existing `ActivityAction.PUBLISH_RESULT` policy and `require_current_admin`; no new parallel permission rule may replace it.
- Release provenance is internal; public output contains no raw credentials, tokens, full fingerprints, or private student data.
- Unlocking a released stage result supersedes its active releases in the same transaction; re-confirmation never auto-releases.
- Existing announcement, showcase, registration, voting, and normal article publication behavior remains unchanged.
- Every logical change is a small conventional commit with its focused gate run before commit.
- Work stays inline in `C:\Users\16275\Desktop\ArtFlow`; no `.worktree/`, linked worktree, or subagent.
- Docker verification must retain source services and volumes; never run `docker compose down --volumes` or reset the source database.

---

### Task 0: Repair the reproducible isolated PostgreSQL restore gate

**Files:**
- Create: `scripts/restore_database_wait.ps1`
- Modify: `scripts/verify_app_backup_restore.ps1`
- Modify: `scripts/verify_postgres_backup_restore.ps1`
- Create: `scripts/tests/test_restore_database_wait_contract.py`
- Modify: `docs/production-readiness.md`

**Interfaces:**
- Produces `Wait-ForStableRestoreDatabase -DockerExecutable -ContainerName -DatabaseName -TimeoutSeconds`, which returns only after the official Postgres entrypoint has completed initialization and two consecutive SQL probes succeed.
- Produces `Write-RestoreContainerDiagnostics -DockerExecutable -ContainerName`, which reports safe container status and tail logs without printing credentials.

- [x] **Step 1: Write the failing contract test.**

Add tests that require both restore scripts to dot-source the shared helper, call the stable wait function after `docker run`, and call diagnostics from the failure path. Require the helper to look for the official init-complete marker and execute `psql` probes rather than trusting one `pg_isready` result.

- [x] **Step 2: Run the contract test and confirm RED.**

Run:

```powershell
uv run python -m pytest scripts/tests/test_restore_database_wait_contract.py -q
```

Expected: FAIL because the helper and stable wait call do not exist yet.

- [x] **Step 3: Implement the shared wait and diagnostics helper.**

In `scripts/restore_database_wait.ps1`:

1. Poll `docker inspect` until the named container is running.
2. Poll `docker logs --tail 80` until it contains `PostgreSQL init process complete; ready for start up.`.
3. Run `docker exec <container> psql --username postgres --dbname <database> --tuples-only --no-align --command SELECT 1;` twice with a one-second interval, requiring both commands to exit zero.
4. On timeout or stopped container, print status and the last 80 log lines, then throw a deterministic error.
5. Validate the container and database inputs with the same safe identifier contract already used by the scripts.

Replace each script's one-shot `pg_isready` loop with the helper. Invoke it immediately after `docker run` and before copying/restoring the dump. In each `finally` block, preserve the existing explicit temporary-container cleanup.

- [x] **Step 4: Run the contract test and local reproduction.**

Run:

```powershell
uv run python -m pytest scripts/tests/test_restore_database_wait_contract.py -q
pwsh -NoProfile -File scripts/verify_app_backup_restore.ps1 -ComposeProjectName artflow -OutputDirectory (Join-Path $env:TEMP 'artflow-m2-d2-backup')
```

Expected: contract tests pass; the application backup, isolated `pg_restore`, Django check, manifest, and media verification pass without changing source volumes.

- [x] **Step 5: Record the gate evidence and commit.**

Update the production-readiness evidence with the stable-init wait and diagnostics behavior, then run:

```powershell
git diff --check
git add scripts/restore_database_wait.ps1 scripts/verify_app_backup_restore.ps1 scripts/verify_postgres_backup_restore.ps1 scripts/tests/test_restore_database_wait_contract.py docs/production-readiness.md
git commit -m "fix: stabilize isolated postgres restore gate"
```

### Task 1: Add the release authority model and audit actions

**Files:**
- Modify: `public_portal/models.py`
- Create: `public_portal/migrations/0004_resultrelease.py`
- Modify: `common/models.py`
- Create: `common/migrations/0014_alter_auditlog_action_type.py`
- Test: `public_portal/tests.py`
- Test: `common/tests.py`

**Interfaces:**
- Produces `ResultRelease.Status.ACTIVE`, `REVOKED`, and `SUPERSEDED`.
- Produces `ResultRelease(post, stage_result, post_version, result_version, ruleset_version, authority_hash, input_fingerprint, status, released_by, released_at, transition_by, transition_at, note)`.
- Produces distinct `AuditLog.ActionType.RELEASE_RESULT`, `REVOKE_RESULT`, and `SUPERSEDE_RESULT_RELEASE` values.

- [ ] **Step 1: Add model-focused failing tests.**

Cover status values, active uniqueness per post/stage result, provenance field persistence, and rejection of an active release whose post activity differs from the stage result activity. Assert that provenance fields are not included in public serializer/query context.

- [ ] **Step 2: Run the model tests and confirm RED.**

Run:

```powershell
uv run python -m pytest public_portal/tests.py common/tests.py -k "ResultRelease or release_authority" -q
```

Expected: FAIL because `ResultRelease` and the new action values do not exist.

- [ ] **Step 3: Implement the model and migrations.**

Use string relations for `core.Activity`, `singer_contest.StageResult`, and `ruleset.RulesetVersion`. Add conditional unique constraints for one active release per post and per exact stage result. Keep historical rows; do not delete releases during revoke or supersede. Add the three audit choices and generate the migration with Django.

- [ ] **Step 4: Run focused model/migration checks and commit.**

Run:

```powershell
uv run python manage.py makemigrations --check --dry-run
uv run python manage.py test public_portal common
git diff --check
git add public_portal/models.py public_portal/migrations/0004_resultrelease.py common/models.py common/migrations/0014_alter_auditlog_action_type.py public_portal/tests.py common/tests.py
git commit -m "feat: add result release authority record"
```

### Task 2: Build the single fail-closed public visibility boundary

**Files:**
- Modify: `public_portal/models.py`
- Modify: `public_portal/views.py`
- Modify: `public_portal/tests.py`
- Modify: `templates/public_portal/home.html`
- Modify: `templates/public_portal/result_list.html`

**Interfaces:**
- `PublicPost.published_public()` remains the only public-post queryset entry point.
- Result posts are visible only when an active release matches the post version, exact stage result, activity, current result version, confirmed status, and current frozen ruleset.

- [ ] **Step 1: Write failing visibility tests.**

Add tests proving: a result post with only `PUBLISHED` is 404/private; an active release is visible through home/detail/result list; revoked/superseded/unlocked/stale/cross-activity/test-activity releases are absent; and media attached to an unreleased result post is absent from `activity_photos`.

- [ ] **Step 2: Run visibility tests and confirm RED.**

Run:

```powershell
uv run python -m pytest public_portal/tests.py -k "result or media" -q
```

Expected: the direct-published result post is currently visible or the new release fixture cannot be created, proving the missing boundary.

- [ ] **Step 3: Implement the exact visibility queryset.**

Keep non-result posts on the existing `status=PUBLISHED` plus TEST exclusion path. For result posts, require active `ResultRelease`, matching `post.version`, matching activity IDs, confirmed stage result, frozen/current ruleset, and a `result_version` equal to the latest stage result version for that activity/stage. Use the same queryset for public home, detail, result list, and media selection; remove the direct `post__status=PUBLISHED` bypass.

- [ ] **Step 4: Run the focused visibility suite and commit.**

Run:

```powershell
uv run python -m pytest public_portal/tests.py -q
git diff --check
git add public_portal/models.py public_portal/views.py public_portal/tests.py templates/public_portal/home.html templates/public_portal/result_list.html
git commit -m "fix: gate public result visibility on active release"
```

### Task 3: Implement transactional release, revoke, and supersede services

**Files:**
- Create: `public_portal/services.py`
- Modify: `singer_contest/services.py`
- Modify: `public_portal/tests.py`
- Modify: `singer_contest/tests.py`
- Modify: `staff_panel/tests.py`

**Interfaces:**
- `release_result_post(post: PublicPost, stage_result: StageResult, operator, *, note: str) -> ResultRelease`
- `revoke_result_release(post: PublicPost, operator, *, note: str) -> ResultRelease`
- `supersede_releases_for_stage_result(stage_result: StageResult, operator, *, note: str) -> int`

- [ ] **Step 1: Write service-level failing tests.**

Cover formal/current/confirmed/closure-pass release success; rejection of TEST, stale, non-current ruleset, unrelated activity, disallowed `ActivityAction.PUBLISH_RESULT` phase, missing note, non-admin, and non-published post; idempotent duplicate release behavior; revoke history; post edit blocked while active; and unlock superseding the release in the same transaction. Add a PostgreSQL-only concurrent release/revoke test with one active row and one valid audit outcome.

- [ ] **Step 2: Run the service tests and confirm RED.**

Run:

```powershell
uv run python -m pytest public_portal/tests.py singer_contest/tests.py staff_panel/tests.py -k "release or supersede or unlock" -q
```

Expected: FAIL because the service commands and unlock integration do not exist.

- [ ] **Step 3: Implement the service transaction and validation.**

Acquire locks in `Activity -> StageResult -> PublicPost -> active ResultRelease` order. Call `lock_activity_for_action(activity, ActivityAction.PUBLISH_RESULT)` before mutating, then require `require_current_admin`, formal lifecycle, exact related activity, current frozen ruleset, latest confirmed stage result, `build_result_closure(activity, stage_key=...)` closeable, post status `PUBLISHED`, and a non-empty note. The HTTP view separately validates `admin_verification_is_valid(request.session)`. Capture the post/result versions and internal provenance. Use distinct audit actions. Revoke and supersede update historical rows rather than deleting them.

- [ ] **Step 4: Integrate unlock and new-result invalidation.**

Call `supersede_releases_for_stage_result` from the existing audited `unlock_stage_result` transaction after the stage changes to `READY_TO_CONFIRM`. Ensure a newly persisted newer result version supersedes older active releases before commit. Keep public reads fail-closed even if a historical transition is incomplete.

- [ ] **Step 5: Run the focused service and PostgreSQL tests, then commit.**

Run:

```powershell
uv run python -m pytest public_portal/tests.py singer_contest/tests.py staff_panel/tests.py -k "release or supersede or unlock" -q
pwsh -NoProfile -File scripts/verify_postgres_acceptance.ps1 -StartCompose -VerifyResetSafety
git diff --check
git add public_portal/services.py singer_contest/services.py public_portal/tests.py singer_contest/tests.py staff_panel/tests.py
git commit -m "feat: add transactional result release commands"
```

### Task 4: Add Staff release/revoke endpoints and UI without a publish bypass

**Files:**
- Modify: `staff_panel/forms.py`
- Modify: `staff_panel/views.py`
- Modify: `staff_panel/urls.py`
- Modify: `templates/staff_panel/post_list.html`
- Modify: `templates/staff_panel/post_form.html`
- Create: `templates/staff_panel/result_release_form.html`
- Modify: `staff_panel/tests.py`

**Interfaces:**
- POST-only `staff:result_release` with path-owned `post_id` and form `stage_result_id`, `note`.
- POST-only `staff:result_release_revoke` with path-owned `post_id` and non-empty `note`.

- [ ] **Step 1: Write failing HTTP tests.**

Assert anonymous/staff/forged activity and query IDs cannot release; GET returns 405; missing admin re-auth redirects; non-empty note is required; successful release/revoke produces the expected status and audit; and direct `post_create/post_edit` with `RESULT_PUBLICATION + PUBLISHED` does not make the post public.

- [ ] **Step 2: Run the HTTP tests and confirm RED.**

Run:

```powershell
uv run python -m pytest staff_panel/tests.py -k "result_release or published_result" -q
```

Expected: FAIL because the URLs, forms, views, and service calls are absent.

- [ ] **Step 3: Implement path-scoped POST endpoints.**

Load the post from the URL, derive its activity from the locked post, ignore query-string IDs, require CSRF and staff access, revalidate the current admin session, and call the service. Render stable error messages without exception details, tokens, fingerprints, or private fields. Do not add release controls to the generic status mutation path.

- [ ] **Step 4: Add staff release state and frozen-content behavior.**

Show active/revoked/superseded state and target result version in the staff list. Reject post edit/reparent while an active release exists; require revoke first. Keep preview available to staff and ensure it does not alter public visibility.

- [ ] **Step 5: Run focused HTTP/browser checks and commit.**

Run:

```powershell
uv run python -m pytest staff_panel/tests.py -k "result_release or published_result" -q
npm run check:pyright:entry-access
npx playwright test --grep "result release"
git diff --check
git add staff_panel/forms.py staff_panel/views.py staff_panel/urls.py templates/staff_panel/post_list.html templates/staff_panel/post_form.html templates/staff_panel/result_release_form.html staff_panel/tests.py
git commit -m "feat: add staff result release controls"
```

### Task 5: Align archive/export metadata and public-data safety tests

**Files:**
- Modify: `exports/services.py`
- Modify: `exports/tests.py`
- Modify: `public_portal/tests.py`
- Modify: `docs/school-onboarding.md`
- Modify: `docs/m2-d1-result-closure-matrix.md`
- Modify: `docs/production-readiness.md`

**Interfaces:**
- Archive `public_content_index.xlsx` reports editorial `Status` and separate `Result Release Status`, target result version, and release timestamp.
- Public result output remains content-only and excludes student IDs, phone, WeChat, raw scores, tokens, full fingerprints, and private file paths.

- [ ] **Step 1: Write failing archive and leakage tests.**

Assert a `PUBLISHED` but unreleased result is recorded as editorial-only, an active release is recorded separately, and public responses/archives do not contain private canaries or provenance secrets.

- [ ] **Step 2: Run the tests and confirm RED.**

Run:

```powershell
uv run python -m pytest exports/tests.py public_portal/tests.py -k "public_content or release or leakage" -q
```

Expected: FAIL because the archive index has no release columns and no release-aware fixture behavior.

- [ ] **Step 3: Implement metadata and documentation.**

Join the active/current release history in the archive builder without changing the authoritative award query. Document that M2-D2 does not replace school SSO/MFA/TLS/WAF/DDoS/retention evidence and that release content is an explicitly reviewed public payload.

- [ ] **Step 4: Run focused tests and commit.**

Run:

```powershell
uv run python -m pytest exports/tests.py public_portal/tests.py -q
pwsh -NoProfile -File scripts/check_docs.ps1
git diff --check
git add exports/services.py exports/tests.py public_portal/tests.py docs/school-onboarding.md docs/m2-d1-result-closure-matrix.md docs/production-readiness.md
git commit -m "docs: record result release provenance"
```

### Task 6: Run the full two-round self-review and production rehearsal

**Files:**
- Create: `docs/m2-d2-result-release-matrix.md`
- Modify: `docs/production-readiness.md`
- Create: `scripts/m2_d2_result_release_rehearsal.mjs`
- Create: `scripts/tests/test_m2_d2_result_release_contract.py`

- [ ] **Step 1: Add the bounded malicious rehearsal.**

The localhost-only Node rehearsal must exercise direct `PUBLISHED` without release, release, duplicate release, forged stage/activity IDs, result unlock, old-public URL access, media access, revoke, and re-release. It must use a 5-second request timeout, no more than 32 requests, no printed credentials, no public host, and no database/volume reset.

- [ ] **Step 2: Run the rehearsal contract test and rehearsal.**

Run:

```powershell
uv run python -m pytest scripts/tests/test_m2_d2_result_release_contract.py -q
node scripts/m2_d2_result_release_rehearsal.mjs
```

Expected: zero unauthorized public visibility, zero 5xx/timeouts, one active release at most, old release inaccessible after unlock/revoke, and no secret/PII canary leakage.

- [ ] **Step 3: Perform self-review round one.**

Re-read the spec and this plan; verify every contract has a task, every named file/interface exists, no task relies on `PublicPost.PUBLISHED` as release authority, and all public read paths use the common queryset. Run:

```powershell
rg -n "PUBLISHED|published_public|RESULT_PUBLICATION|ResultRelease|release_result" public_portal staff_panel exports templates docs
```

Record any gap in the matrix and fix it before proceeding.

- [ ] **Step 4: Perform self-review round two.**

Audit security and semantic consistency: path authority vs query parameters, activity/stage ownership, old-version fail-closed behavior, admin re-authentication, audit reason, lock order, direct ORM bypasses, public media bypasses, archive labels, test-data exclusion, and school external HOLD boundaries. Run the focused malicious suite again after each correction.

- [ ] **Step 5: Run the complete local gates.**

Run:

```powershell
python manage.py check
python manage.py makemigrations --check --dry-run
python manage.py test
npm run check:client
npm run test:client
npm run check:pyright
npm run check:pyright:entry-access
uv run mypy
pwsh -NoProfile -File scripts/check_docs.ps1
pwsh -NoProfile -File scripts/verify_postgres_acceptance.ps1 -StartCompose -VerifyResetSafety
pwsh -NoProfile -File scripts/verify_app_backup_restore.ps1 -ComposeProjectName artflow -OutputDirectory (Join-Path $env:TEMP 'artflow-m2-d2-final-backup')
npm run test:e2e
```

- [ ] **Step 6: Commit rehearsal evidence, merge, and verify remote gates.**

Run:

```powershell
git diff --check
git status --short
git add docs/m2-d2-result-release-matrix.md docs/production-readiness.md scripts/m2_d2_result_release_rehearsal.mjs scripts/tests/test_m2_d2_result_release_contract.py
git commit -m "test: rehearse m2-d2 result release authority"
git switch main
git pull --ff-only origin main
git merge --no-ff feat/m2-d2-result-release -m "merge: add m2-d2 result release authority"
git push origin main
```

After the push, verify `git rev-parse HEAD`, `git rev-parse origin/main`, clean status, and all four workflows for that exact SHA. If direct push times out, retry with the repository-approved proxy command from `AGENTS.md`.
