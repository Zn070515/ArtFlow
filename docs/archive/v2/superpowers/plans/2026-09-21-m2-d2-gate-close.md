# M2-D2 Gate Close Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Re-run and close the M2-D2 public-result release authority gate with explicit replay, rejection, visibility, audit, cleanup, and current remote-CI evidence.

**Architecture:** Keep `PublicPost.PUBLISHED` as editorial state and `ResultRelease.ACTIVE` as the only public result authority. Exercise the existing service and HTTP boundaries through Django regression tests and the bounded localhost Docker rehearsal; do not add a second publication path or weaken current activity/result locking.

**Tech Stack:** Django `TestCase`, PostgreSQL Docker Compose, Node.js rehearsal script, PowerShell gate scripts, pytest, Ruff, mypy, Pyright, TypeScript client checks, GitHub Actions.

**Spec:** `docs/m2-d2-result-release-matrix.md`

## Global Constraints

- The rehearsal accepts only localhost HTTP and is bounded to 32 requests with a 5-second request timeout.
- Never use `docker compose down --volumes`, reset the source database, or delete source volumes.
- Public result visibility must be derived from the current active `ResultRelease` authority, not editorial `PUBLISHED` state alone.
- Release, revoke, supersede, and unlock transitions require an audited non-empty reason where the command is operator-driven.
- Preserve result version, ruleset version, input fingerprint, activity binding, and release history; do not expose private authority fields or bearer values.
- Every logical change is a small conventional commit with its focused gate run before commit.

---

### Task 1: Close the active-release model boundary

**Files:**
- Modify: `C:/Users/16275/Desktop/ArtFlow/public_portal/tests.py`
- Modify: `C:/Users/16275/Desktop/ArtFlow/staff_panel/tests.py`

**Interfaces:**
- Consumes: `release_result_post()`, `revoke_result_release()`, `ResultReleaseHttpTests`, and the existing public visibility query boundary.
- Produces: regression coverage proving an active release cannot attach to a non-result post or to an unpublished result post; service and HTTP replay behavior remains covered by the existing tests and rehearsal.

- [ ] **Step 1: Write the failing tests**

Add two model tests: construct an active `ResultRelease` against a same-activity announcement and against a same-activity draft result post, call `full_clean()`, and assert `ValidationError` in both cases. These tests must exercise model validation rather than only the service path.

- [ ] **Step 2: Run the focused tests to verify the new assertions expose the missing contract**

Run:

```powershell
uv run python manage.py test public_portal.tests.ResultReleaseServiceTests staff_panel.tests.ResultReleaseHttpTests
```

Expected: both new tests fail with `ValidationError not raised`; existing tests remain green.

- [ ] **Step 3: Implement only the minimum boundary behavior required by the failing tests**

In `ResultRelease.clean()`, when the row is `ACTIVE`, require `post_type == RESULT_PUBLICATION` and `post.status == PUBLISHED`, while preserving the existing activity-match validation and allowing historical revoked/superseded rows to remain attached to later-edited posts. Do not introduce a generic publication helper or change `PublicPost` semantics.

- [ ] **Step 4: Run the focused tests again**

Run the same command and require all selected tests to pass with no warning or error output.

- [ ] **Step 5: Commit the test/behavior unit**

```powershell
git diff --check
git add public_portal/tests.py public_portal/models.py
git commit -m "fix: close active result release model boundary"
```

### Task 2: Run the bounded Docker PostgreSQL release rehearsal

**Files:**
- Modify: `docs/m2-d2-result-release-matrix.md`
- Modify: `docs/production-readiness.md`

**Interfaces:**
- Consumes: `common.prepare_result_release_rehearsal`, `scripts/m2_d2_result_release_rehearsal.mjs`, and the running Compose web/PostgreSQL services.
- Produces: a current quantitative report with all release matrix checks, HTTP metrics, audit counts, cleanup evidence, and source-volume safety evidence.

- [ ] **Step 1: Start or verify Compose without destructive volume operations**

Run:

```powershell
docker compose up -d --build --wait
```

Confirm the web service is reachable on the configured localhost port and do not run any volume reset command.

- [ ] **Step 2: Create the private fixture and execute the rehearsal**

Create the fixture with `prepare_result_release_rehearsal` inside the web container, copy only the `0600` fixture file to a temporary local path, set `ARTFLOW_RESULT_RELEASE_FIXTURE_PATH`, and run:

```powershell
node scripts/m2_d2_result_release_rehearsal.mjs
```

Require zero failed checks, zero 5xx responses, zero timeouts, no leaked cookie/CSRF/token/private fingerprint data, and successful exact cleanup. Remove only the temporary fixture file afterward.

- [ ] **Step 3: Record the measured evidence**

Append one dated entry to `docs/m2-d2-result-release-matrix.md` and `docs/production-readiness.md` containing the current commit SHA, request/status counts, p50/p95/p99/max latency, audit counts, history/active counts, final stage state, and explicit `source database reset: false` / `source volumes reset: false` statements. Keep public-network, DDoS, school IdP/MFA, TLS/WAF, retention, and deployment ownership as external `HOLD` items.

- [ ] **Step 4: Commit the rehearsal evidence**

```powershell
git diff --check
git add docs/m2-d2-result-release-matrix.md docs/production-readiness.md
git commit -m "docs: record m2-d2 release gate rehearsal"
```

### Task 3: Verify the complete M2-D2 gate and merge

**Files:**
- Verify: all repository files and the two M2-D2 evidence documents.

**Interfaces:**
- Consumes: the committed regression tests and rehearsal evidence.
- Produces: a clean feature branch, green local gates, green remote gates, and a non-fast-forward merge to `main`.

- [ ] **Step 1: Run the focused and static gates**

Run:

```powershell
python manage.py check
python manage.py makemigrations --check --dry-run
uv run ruff check .
uv run ruff format --check .
uv run mypy
npm run check:pyright
npm run check:pyright:entry-access
npm run check:client
npm run test:client
pwsh -NoProfile -File scripts/check_docs.ps1
```

- [ ] **Step 2: Run the complete local application and PostgreSQL gates**

Run:

```powershell
python manage.py test
pwsh -NoProfile -File scripts/verify_postgres_acceptance.ps1 -StartCompose -VerifyResetSafety
```

Require zero failures and leave the source services and volumes intact.

- [ ] **Step 3: Perform two self-review passes**

First compare every `RELEASE-*` matrix invariant with code, tests, script output, and documentation. Then inspect the final diff for authority bypasses, cross-activity access, replay behavior, transaction ordering, secret/private-field exposure, unsafe Docker commands, stale SHA/count claims, and contract wording drift.

- [ ] **Step 4: Commit, push, and wait for branch gates**

```powershell
git diff --check
git status --short
git push -u origin test/m2-d2-gate-close
```

If direct push times out, retry with the repository proxy rule at `127.0.0.1:12334`; wait for CI, PostgreSQL integration, Security, and Workflow lint to finish successfully.

- [ ] **Step 5: Merge non-fast-forward and push `main`**

```powershell
git switch main
git pull --ff-only origin main
git merge --no-ff test/m2-d2-gate-close -m "merge: close m2-d2 release gate"
git push origin main
git status --short --branch
```

If push times out, use the configured local proxy. Do not delete the feature branch until `main`, `origin/main`, and the final remote gate results have been verified.

## Plan self-review

- Spec coverage: RELEASE-01/02/03/04/05/06/07/08 are exercised by the existing rehearsal and existing Django tests; Task 1 adds explicit revoke replay and blank-note HTTP coverage; Task 2 records current quantitative evidence; Task 3 verifies all repository and remote gates.
- Placeholder scan: no `TBD`, `TODO`, or unspecified test command is used; every task names files, commands, and expected outcomes.
- Type/authority consistency: the plan keeps `ResultRelease.ACTIVE` as public authority, preserves the existing service signatures, and does not relabel score/result provenance.
