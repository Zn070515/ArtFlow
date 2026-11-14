# Plus Release and Recovery Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close every finding from the `341c36a..7403ec4` deep review: fail before migration on provenance mismatch, make published image names and release gates coherent, and make Plus backup/restore verify every runtime image and database content evidence.

**Architecture:** Keep release provenance as a pure runtime assertion, invoked before any database connection work that can migrate. Keep release publishing tag-only, but make the existing Plus gates reusable by the publish workflow. Extend the Plus backup manifest with immutable local image IDs and exact row-count evidence; restore the database and all three runtime targets in an isolated network and compare those invariants before passing.

**Tech Stack:** Node 24, TypeScript/Vitest, Bash, Docker Compose, PostgreSQL/`psql`, Python 3.12, GitHub Actions, PyYAML contract gates.

**Spec:** `docs/invariants/deployment.md`, `docs/artflow-plus/backup-restore.md`, and the findings recorded in the immediately preceding review of `341c36a..7403ec4`.

## Global Constraints

- Production provenance is a full 40-character hexadecimal Git commit SHA; empty, placeholder, or arbitrary strings are rejected.
- API and Worker must reject provenance before `migrate(db)` can change a database.
- Published Plus API, Worker, and Web images use one documented GHCR naming convention and the same tagged commit.
- Tag publishing cannot proceed without the Plus type checks, tests, build, structural gates, golden checks, and web journey.
- Backup/restore never resets source Compose services or volumes.
- Restore verification runs against an isolated database and isolated API, Worker, and Web containers.
- Existing backup artifacts remain `database.dump`, `archives.tar.gz`, and `media.tar.gz`; new manifest fields are additive.
- Do not run the v1 full test suite; run the Plus suite and focused gates requested by the user.

---

### Task 1: Make runtime provenance fail closed before migrations

**Files:**
- Modify: `plus/packages/runtime/src/release-provenance.ts`
- Modify: `plus/packages/runtime/test/release-provenance.test.ts`
- Modify: `plus/apps/api/src/main.ts`
- Modify: `plus/apps/worker/src/main.ts`
- Test: `scripts/tests/test_plus_backup_contract.py`

**Interfaces:**
- Keep `assertReleaseProvenance(options?: ReleaseProvenanceOptions): void`.
- Add a private full-SHA normalization/validation helper; both configured and baked values must normalize to the same 40-hex lowercase value.
- API and Worker call `assertReleaseProvenance()` before `createDb()`/`migrate()`.

- [ ] **Step 1: Write failing provenance tests**

Add Vitest cases for a matching 40-character SHA, a missing SHA, a mismatch, a short arbitrary value, and a placeholder value in production. Add a source-order contract asserting the provenance call appears before `migrate` in both entrypoints.

- [ ] **Step 2: Run the focused tests and verify RED**

Run:

```powershell
pnpm -C plus --filter @artflow-plus/runtime test -- release-provenance.test.ts
uv run pytest scripts/tests/test_plus_backup_contract.py -q
```

Expected: the new format/order assertions fail against the current implementation.

- [ ] **Step 3: Implement the minimal validation and reorder startup**

Validate `/^[0-9a-f]{40}$/i`, reject placeholders through the same format check, normalize case, and move the assertion before database creation/migration in both processes.

- [ ] **Step 4: Run the focused tests and verify GREEN**

Run the same two commands and require all tests to pass.

- [ ] **Step 5: Commit**

```powershell
git add plus/packages/runtime/src/release-provenance.ts plus/packages/runtime/test/release-provenance.test.ts plus/apps/api/src/main.ts plus/apps/worker/src/main.ts scripts/tests/test_plus_backup_contract.py
git commit -m "fix: reject invalid plus release provenance before migration"
```

### Task 2: Align GHCR names and gate tag publishing

**Files:**
- Modify: `.github/workflows/publish.yml`
- Modify: `.github/workflows/gates.yml`
- Modify: `.env.production.example`
- Modify: `tests/gates/test_release_artifacts.py`

**Interfaces:**
- `gates.yml` remains runnable on `push` and `pull_request` and additionally exposes `workflow_call`.
- `publish.yml` calls the reusable gates workflow and both `publish` jobs depend on that gate job.
- Canonical published names are `ghcr.io/<owner>/artflow-plus-api`, `artflow-plus-worker`, and `artflow-plus-web`.

- [ ] **Step 1: Write failing workflow contract tests**

Add assertions that the template suffixes match the three publish image names and that both publish jobs have `needs: gates`; assert `gates.yml` exposes `workflow_call`.

- [ ] **Step 2: Run the focused gate and verify RED**

Run:

```powershell
uv run pytest tests/gates/test_release_artifacts.py -q
```

Expected: the new naming/needs assertions fail against the current workflow.

- [ ] **Step 3: Implement the workflow and template alignment**

Use `GITHUB_REPOSITORY_OWNER` as the GHCR namespace, append the `artflow-plus-*` names, add `workflow_call` to `gates.yml`, and add a reusable `gates` job in `publish.yml` with `publish` and `publish-plus` depending on it.

- [ ] **Step 4: Run the focused gate and verify GREEN**

Run the same command plus YAML parsing through the existing gate test; require all assertions to pass.

- [ ] **Step 5: Commit**

```powershell
git add .github/workflows/publish.yml .github/workflows/gates.yml .env.production.example tests/gates/test_release_artifacts.py
git commit -m "fix: gate plus publishing and align image names"
```

### Task 3: Extend the Plus backup manifest with all runtime identity and row evidence

**Files:**
- Modify: `scripts/backup_plus.sh`
- Modify: `scripts/tests/test_plus_backup_contract.py`
- Modify: `docs/artflow-plus/backup-restore.md`

**Interfaces:**
- The backup script requires running `plus-db`, `plus-api`, `plus-worker`, and `plus-web`.
- The manifest adds `worker_image`, `web_image`, `database_image_id`, `api_image_id`, `worker_image_id`, `web_image_id`, and `database_table_counts`.
- The script records exact counts for every non-system, non-partition-child ordinary/partitioned table while the database write barrier is held.

- [ ] **Step 1: Write failing contract tests**

Assert the backup script checks Worker/Web, records image IDs and all three runtime image fields, emits table-count evidence, and documents the expanded manifest.

- [ ] **Step 2: Run the focused contract test and verify RED**

```powershell
uv run pytest scripts/tests/test_plus_backup_contract.py -q
```

Expected: the new manifest and service assertions fail.

- [ ] **Step 3: Implement the manifest additions**

Inspect the service IDs and OCI revisions, require each service to be running and on the same release SHA, generate deterministic table-count output with `psql`/`\gexec`, include it in the manifest, and remove temporary evidence files in the existing exit cleanup.

- [ ] **Step 4: Run focused shell and contract checks**

```powershell
bash -n scripts/backup_plus.sh
uv run pytest scripts/tests/test_plus_backup_contract.py -q
```

- [ ] **Step 5: Commit**

```powershell
git add scripts/backup_plus.sh scripts/tests/test_plus_backup_contract.py docs/artflow-plus/backup-restore.md
git commit -m "feat: record complete plus backup provenance"
```

### Task 4: Restore and verify API, Worker, Web, and database content evidence

**Files:**
- Modify: `scripts/restore_plus_verify.sh`
- Modify: `scripts/tests/test_plus_backup_contract.py`
- Modify: `docs/artflow-plus/backup-restore.md`

**Interfaces:**
- Restore validates the additive manifest fields before creating containers.
- The isolated API uses the recorded immutable API image ID; the Worker uses the recorded Worker image ID; the Web uses the recorded Web image ID.
- Restore compares actual table counts to `database_table_counts` before readiness is accepted.
- Cleanup removes all temporary containers and extraction directories on success and failure.

- [ ] **Step 1: Write failing restore contract tests**

Assert the restore script parses image IDs and table counts, creates and cleans API/Worker/Web containers, checks Worker readiness, probes Web health, and compares database counts.

- [ ] **Step 2: Run the focused contract test and verify RED**

```powershell
uv run pytest scripts/tests/test_plus_backup_contract.py -q
```

Expected: the new restore assertions fail.

- [ ] **Step 3: Implement isolated multi-service restore verification**

Add manifest validation, container names, cleanup, database-count comparison, Worker startup/log readiness, and Web health probing. Keep source-image and source-volume checks in place; never use `down --volumes`, source `DROP DATABASE`, or source volume deletion.

- [ ] **Step 4: Run focused shell and contract checks**

```powershell
bash -n scripts/restore_plus_verify.sh
uv run pytest scripts/tests/test_plus_backup_contract.py -q
```

- [ ] **Step 5: Commit**

```powershell
git add scripts/restore_plus_verify.sh scripts/tests/test_plus_backup_contract.py docs/artflow-plus/backup-restore.md
git commit -m "fix: verify complete plus restore topology"
```

### Task 5: Full in-scope verification and direct delivery

**Files:**
- No new production files; inspect all changes and update the plan checkboxes.

- [ ] **Step 1: Run the Plus checks**

```powershell
pnpm -C plus run check
$env:ARTFLOW_PLUS_DATABASE_URL = "postgresql://artflow:artflow_dev@127.0.0.1:5433/artflow_plus"
$env:REQUIRE_DB = "1"
pnpm -C plus run test
uv run pytest scripts/tests/test_plus_backup_contract.py scripts/tests/test_posix_operations_contract.py tests/gates/test_release_artifacts.py -q
pwsh -NoProfile -File scripts/check_docs.ps1
```

- [ ] **Step 2: Run real Docker backup/restore**

Start only the disposable Plus Compose project, create a backup, restore it through the isolated API/Worker/Web checks, tamper one artifact and verify exit code 64, then remove only the disposable project/volumes and temporary directory. Confirm `artflow-plus-postgres` remains running.

- [ ] **Step 3: Perform final review**

Review `git diff --check`, inspect the final diff for destructive source operations, verify the full Plus test count, verify no v1 full suite was run, and confirm the worktree is clean.

- [ ] **Step 4: Commit, merge, and push**

```powershell
git switch artflow-plus
git pull --ff-only origin artflow-plus
git merge --no-ff fix/plus-release-recovery-hardening -m "Merge branch 'fix/plus-release-recovery-hardening' into artflow-plus"
git push origin artflow-plus
```

- [ ] **Step 5: Verify remote parity and delete the feature branch**

```powershell
git fetch origin artflow-plus
git rev-parse HEAD
git rev-parse origin/artflow-plus
git status --short --branch
git branch -d fix/plus-release-recovery-hardening
```

## Self-review checklist

- [ ] Startup mismatch cannot run migrations.
- [ ] Published image names match the operator template.
- [ ] Tag publishing has an explicit Plus gates dependency.
- [ ] Backup records API/Worker/Web and immutable image identities.
- [ ] Restore starts and verifies API/Worker/Web in isolation.
- [ ] Restore compares exact database table counts.
- [ ] No source reset/destructive command was introduced.
- [ ] Plus checks, focused gates, documentation checks, and Docker black-box verification are fresh and green.
