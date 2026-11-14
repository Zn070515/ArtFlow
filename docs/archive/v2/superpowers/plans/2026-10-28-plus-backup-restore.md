# Plus Backup and Isolated Restore Verification Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give ArtFlow-Plus an operator-runnable backup and isolated restore verification loop covering PostgreSQL, sealed archives, and private material bytes without touching source services or volumes.

**Architecture:** Add two POSIX scripts at the deployment boundary. The backup script discovers the running Plus containers and their mounted volume names, dumps the Plus database with `pg_dump`, streams both persistent file volumes to tarballs, and writes a hash-bearing manifest. The restore script verifies the manifest before starting anything, safely extracts file tarballs, restores PostgreSQL into a temporary container on the existing internal network, starts the exact recorded API image against that isolated database and restored file roots, and then removes only the temporary resources.

**Tech Stack:** Bash, Docker Compose profiles, PostgreSQL `pg_dump`/`pg_restore`, Python standard-library JSON/tarfile validation, SHA-256, pytest contract tests, Markdown runbooks.

**Spec:** `docs/artflow-plus/cutover-runbook.md` and the Plus production topology in `deploy/compose.production.yml`.

## Global Constraints

- Plus backup scope is exactly `plus_postgres_data`, `plus_archive_data`, and `plus_media_data`; the v1 `media_data` bridge is read-only source material and is not silently folded into the Plus backup.
- The backup and restore commands must use the Compose `plus` profile and must require the running `plus-db` and `plus-api` services.
- Restore is isolated: never reset, drop, or recreate source databases or source volumes; only temporary restore containers and temporary extraction directories may be removed.
- The manifest must bind the database dump and both file tarballs to SHA-256 hashes and the deployed release SHA/image identity.
- Restore must reject malformed manifests, hash mismatches, unsafe tar members, release/image mismatches, and an unstable temporary database before running application checks.
- No real activity rehearsal is part of this work; verification uses the running deployment’s data and disposable restore resources only.
- Do not run the v1 full test suite; run Plus checks and focused scripts/gates only.

---

### Task 1: Define the backup/restore contract tests

**Files:**
- Create: `scripts/tests/test_plus_backup_contract.py`

**Interfaces:**
- Consumes: the future `scripts/backup_plus.sh`, `scripts/restore_plus_verify.sh`, `docs/artflow-plus/backup-restore.md`, and `docs/artflow-plus/cutover-runbook.md`.
- Produces: static contract checks that fail if the scripts omit the Plus profile, one of the three persisted data surfaces, manifest hashes, isolated restore, safe extraction, or source-volume protection.

- [ ] **Step 1: Write the failing tests**

  Add pytest tests that load the two shell scripts and the two docs and assert:

  ```python
  def test_backup_covers_plus_database_archive_and_media():
      script = read("scripts/backup_plus.sh")
      assert "--profile plus" in script
      assert "plus-db" in script and "plus-api" in script
      assert "pg_dump" in script
      assert "plus_archive_data" in script
      assert "plus_media_data" in script
      assert "manifest.json" in script
      assert "sha256sum" in script

  def test_restore_isolated_and_never_resets_source():
      script = read("scripts/restore_plus_verify.sh")
      assert "--profile plus" in script
      assert "pg_restore" in script
      assert "kysely_migration" in script
      assert "tarfile" in script
      assert "symlink" in script
      assert "docker compose down --volumes" not in script
      assert "plus_postgres_data" not in script.split("cleanup()", 1)[-1]

  def test_docs_describe_plus_media_and_isolated_restore():
      for document in (backup_restore_doc, cutover_runbook):
          assert "plus_postgres_data" in document
          assert "plus_archive_data" in document
          assert "plus_media_data" in document
          assert "backup_plus.sh" in document
          assert "restore_plus_verify.sh" in document
      assert "真实活动彩排" not in backup_restore_doc
  ```

  Also assert that both scripts begin with `set -Eeuo pipefail`, require `docker`, use a manifest field for `git_sha`, and contain no `DROP DATABASE` or `docker volume rm` command.

- [ ] **Step 2: Run the focused tests to verify they fail**

  Run:

  ```powershell
  uv run pytest scripts/tests/test_plus_backup_contract.py -q
  ```

  Expected: FAIL because the Plus scripts and backup/restore document do not yet exist.

- [ ] **Step 3: Commit the red contract**

  ```powershell
  git add scripts/tests/test_plus_backup_contract.py
  git commit -m "test: define plus backup restore contract"
  ```

### Task 2: Implement Plus backup creation

**Files:**
- Create: `scripts/backup_plus.sh`

**Interfaces:**
- Consumes: production Compose file, `.env.production` or `ARTFLOW_ENV_FILE`, running `plus-db` and `plus-api`, and the three Plus persistent mounts.
- Produces: `<backup-root>/<UTC timestamp>-<release-sha>/manifest.json`, `database.dump`, `archives.tar.gz`, and `media.tar.gz`.

- [ ] **Step 1: Add the minimal script structure**

  Implement strict Bash argument parsing with one optional output root (default `backups/artflow-plus`), validated Compose project name, Compose file, and env file. Build the Compose command as:

  ```bash
  compose=(docker compose --env-file "$env_file" -p "$compose_project" -f "$compose_file" --profile plus)
  ```

  Require `plus-db` and `plus-api` container IDs from `"${compose[@]}" ps -q ...`, and fail before creating output if either is absent. Read the API image and `ARTFLOW_RELEASE_SHA` from the API container and reject a missing/non-40-hex release SHA.

- [ ] **Step 2: Implement database and volume capture**

  Discover the source volume names from the API container mount destinations `/app/var/archives` and `/app/var/media`, and require both to resolve. Run `pg_dump --format=custom --no-owner` inside `plus-db`, copy the dump out, and remove only the temporary dump file inside `plus-db`. Stream each discovered volume through the recorded API image with a read-only mount and `tar -czf - -C /data .` into its corresponding host tarball. Fail on any missing volume, command error, or empty output.

  Record the source database image, API image, Compose project, volume names, filenames, release SHA, and UTC creation time. Compute `database_sha256`, `archives_sha256`, and `media_sha256` using `sha256sum`; record byte sizes and regular-file counts for all three artifacts. Write JSON through Python’s standard library to avoid shell escaping errors, using an explicit schema marker `artflow-plus-backup/v1`.

- [ ] **Step 3: Add cleanup and safety behavior**

  Use a trap to remove only the temporary database dump from the source `plus-db` container and temporary local staging paths. Never invoke `docker compose down`, `docker volume rm`, `docker system prune`, or any source reset. Print the final absolute backup-set path only after the manifest is atomically written.

- [ ] **Step 4: Run the contract tests and shell syntax check**

  Run:

  ```powershell
  bash -n scripts/backup_plus.sh
  uv run pytest scripts/tests/test_plus_backup_contract.py -q
  ```

  Expected: the backup-related contract assertions pass; restore/document assertions remain red until later tasks.

- [ ] **Step 5: Commit the backup implementation**

  ```powershell
  git add scripts/backup_plus.sh scripts/tests/test_plus_backup_contract.py
  git commit -m "feat: add plus database and volume backup"
  ```

### Task 3: Implement isolated Plus restore verification

**Files:**
- Create: `scripts/restore_plus_verify.sh`

**Interfaces:**
- Consumes: one backup set from Task 2, the running Plus Compose network, and the recorded database/API images.
- Produces: a zero exit status only after checksum, manifest, safe extraction, isolated PostgreSQL restore, migration-table check, API readiness, and restored file-count checks pass.

- [ ] **Step 1: Add manifest and artifact validation**

  Require `manifest.json`, `database.dump`, `archives.tar.gz`, and `media.tar.gz`. Parse and validate schema, 40-hex `git_sha`, 64-hex artifact hashes, filenames, and positive/zero byte sizes with Python. Verify all three SHA-256 hashes before starting a restore container. Require the source `plus-db` and `plus-api` containers, compare the running API OCI revision and image reference with the manifest, and require the recorded release SHA to match the API’s `ARTFLOW_RELEASE_SHA`.

- [ ] **Step 2: Add safe extraction and temporary resource cleanup**

  Extract each tarball into a `mktemp -d` directory using an embedded Python `tarfile` routine. Reject absolute paths, `..` components after normalization, symlinks, hardlinks, devices, FIFOs, and any member that resolves outside the destination. The shell trap must remove only the temporary extraction directories and temporary restore container names; it must not touch any Compose volume.

- [ ] **Step 3: Restore PostgreSQL into an isolated container**

  Derive the source internal network from the running API container, start a uniquely named temporary PostgreSQL container from the manifest database image with a restore-only password and `ARTFLOW_RESTORE_DATABASE` (default `artflow_plus_restore`), and wait up to 90 seconds for two consecutive successful `SELECT 1` checks after initialization. Copy the dump into the temporary container, run `pg_restore --exit-on-error --no-owner`, and verify the `kysely_migration` table is queryable.

- [ ] **Step 4: Start the exact API image against the isolated data**

  Start a uniquely named temporary API container from the recorded API image on the same internal network, with `ARTFLOW_PLUS_DATABASE_URL` pointed at the temporary database, `ARTFLOW_RELEASE_SHA` set to the manifest SHA, a restore-only credential secret, and the extracted archive/media roots mounted read-only. Poll `/readyz` using a disposable Node process from the exact API image; fail with recent container logs if the API exits or does not become ready within 90 seconds. Verify extracted regular-file counts match the manifest counts.

- [ ] **Step 5: Run the tests and a local shell syntax gate**

  Run:

  ```powershell
  bash -n scripts/restore_plus_verify.sh
  uv run pytest scripts/tests/test_plus_backup_contract.py -q
  ```

  Expected: all backup/restore contract tests pass.

- [ ] **Step 6: Commit the restore implementation**

  ```powershell
  git add scripts/restore_plus_verify.sh scripts/tests/test_plus_backup_contract.py
  git commit -m "feat: verify isolated plus restores"
  ```

### Task 4: Document operation and wire the cutover runbook

**Files:**
- Create: `docs/artflow-plus/backup-restore.md`
- Modify: `docs/artflow-plus/cutover-runbook.md: Post-cutover and automated checks`

**Interfaces:**
- Consumes: the exact script arguments and manifest behavior from Tasks 2–3.
- Produces: operator instructions for production backups and disposable restores, with explicit source-volume safety and no real-activity rehearsal.

- [ ] **Step 1: Write the focused operational document**

  Document prerequisites, commands, generated files, the three included data surfaces, the exclusion of the read-only v1 media bridge, release/image binding, retention/offsite handling, failure interpretation, and the fact that restore is to a temporary database/API only. Include:

  ```powershell
  bash scripts/backup_plus.sh backups/artflow-plus
  bash scripts/restore_plus_verify.sh backups/artflow-plus/<timestamp>-<release-sha>
  ```

  State that the restore script never performs `docker compose down --volumes`, resets source databases, or deletes source volumes, and that the v1 `scripts/backup.sh` / `scripts/restore-verify.sh` remain separate.

- [ ] **Step 2: Update the cutover runbook**

  Replace the current incomplete post-cutover sentence with the exact Plus commands and explicitly list `plus_postgres_data`, `plus_archive_data`, and `plus_media_data`. Change the automated-check item from v1-only restore wording to the Plus isolated restore command while preserving the statement that no real activity rehearsal is required.

- [ ] **Step 3: Run documentation and contract validation**

  Run:

  ```powershell
  uv run pytest scripts/tests/test_plus_backup_contract.py -q
  pwsh -NoProfile -File scripts/check_docs.ps1
  ```

  Expected: all focused tests pass and the documentation checker reports no broken local references.

- [ ] **Step 4: Commit documentation**

  ```powershell
  git add docs/artflow-plus/backup-restore.md docs/artflow-plus/cutover-runbook.md
  git commit -m "docs: document plus backup restore operations"
  ```

### Task 5: Full focused verification and handoff

**Files:**
- Modify: none unless verification exposes a contract failure.

- [ ] **Step 1: Run Plus static and test gates**

  ```powershell
  pnpm -C plus run check
  pnpm -C plus run test
  uv run pytest scripts/tests/test_plus_backup_contract.py scripts/tests/test_posix_operations_contract.py tests/gates/test_release_artifacts.py -q
  ```

- [ ] **Step 2: Run a real disposable Docker backup/restore check when the Plus stack is available**

  Bring up only the Plus profile using the already configured production environment, run `backup_plus.sh` into a temporary repository-local backup directory, run `restore_plus_verify.sh` on that set, and remove only the temporary backup directory after recording the result. Do not use `docker compose down --volumes`, do not reset the source volumes, and do not create or rehearse a real activity.

- [ ] **Step 3: Inspect the final diff and status**

  ```powershell
  git diff --check
  git status --short
  git log --oneline -5
  ```

- [ ] **Step 4: Commit any final focused fix and hand off to branch finishing**

  Use `superpowers:finishing-a-development-branch` after all checks pass. The branch may then be merged non-fast-forward into `artflow-plus` and pushed directly to `origin/artflow-plus` according to the repository workflow.

## Self-review

- Coverage: Tasks 1–3 cover the three data surfaces, hashes, release binding, isolated PostgreSQL restore, API readiness, and unsafe tar rejection; Task 4 covers operator use and the no-rehearsal policy; Task 5 covers Plus-only verification.
- Placeholder scan: no step relies on “TBD”, an unspecified helper, or a later decision; all script names, fields, commands, and test assertions are concrete.
- Type/field consistency: Task 2 writes `archives.tar.gz`, `media.tar.gz`, `database.dump`, `git_sha`, and the three matching hash fields; Task 3 consumes those exact names and fields.
