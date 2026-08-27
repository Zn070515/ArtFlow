# Test Data, Files, and Voting Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make test data, uploaded media, and public voting safe under cleanup, replacement, retry, and concurrency.

**Architecture:** Add focused services to `common`, `files`, and `voting`; keep model constraints as the final integrity layer and make existing views adapters. Use an explicit file lifecycle and ballot aggregate rather than inferring state from multiple rows.

**Tech Stack:** Django 6.0, Django transactions and constraints, Django storage API, Pillow/file signatures, SQLite/PostgreSQL, pytest-django.

**Spec:** `docs/superpowers/specs/2026-08-27-production-correctness-hardening-design.md`

## Global Constraints

- Test cleanup may delete only rows and files marked as test data and owned by the selected activity.
- Formal queries and exports exclude test data explicitly.
- A file purpose has one current file per owner; historical files remain auditable.
- Upload validation rejects policy violations before model persistence.
- A ballot is unique by `(vote_session, browser_session_key)`; IP is only a soft signal.
- Vote mutations and award reconciliation are atomic and idempotent.

---

### Task 1: Add safe file policy and storage lifecycle services

**Files:**
- Create: `files/policies.py`
- Modify: `files/services.py`
- Modify: `files/models.py`
- Test: `files/tests.py`

**Interfaces:**
- `validate_upload(uploaded_file, purpose) -> None` raises `ValidationError` for unsupported extension/content type or purpose-specific byte limit.
- `store_submission_file(*, owner, uploaded_file, purpose, uploaded_by, is_test_data) -> SubmissionFile` validates, marks the new row current, and demotes the prior current row for that owner/purpose inside a transaction.
- `delete_submission_file(submission_file) -> None` deletes the database row and then removes its storage object safely.

- [ ] **Step 1: Write failing tests** for per-purpose size and extension policy, empty files, current replacement, and storage deletion using `SimpleUploadedFile` and a temporary `FileSystemStorage`.
- [ ] **Step 2: Run `uv run pytest files/tests.py -q` and verify uploads are currently accepted without policy/current semantics.
- [ ] **Step 3: Add `is_current`, `version`, and a check/unique constraint that permits one current file for each non-null owner/purpose; implement the policy table and lifecycle service.
- [ ] **Step 4: Generate the migration and run `uv run python manage.py migrate --plan`.
- [ ] **Step 5: Run focused tests and verify prior files remain historical while the newest file is current.
- [ ] **Step 6: Commit with `git commit -m "feat: add safe submission file lifecycle"`.

### Task 2: Route every upload and cleanup through the file service

**Files:**
- Modify: `singer_contest/views.py`
- Modify: `farewell_show/views.py`
- Modify: `staff_panel/views.py`
- Modify: `files/services.py`
- Modify: `files/tests.py`, `staff_panel/tests.py`
- Modify: relevant upload templates for clear policy errors and current markers

- [ ] **Step 1: Write failing tests** for participant upload, staff upload, program upload, test-data cleanup, and deletion removing both row and object.
- [ ] **Step 2: Run focused tests and verify at least one path still writes directly and cleanup leaves an orphan.
- [ ] **Step 3: Replace direct `SubmissionFile.objects.create()` and queryset `.delete()` calls with the service; preserve owner/activity authorization and material-check synchronization.
- [ ] **Step 4: Add current-file labels and historical-file display to staff and participant templates.
- [ ] **Step 5: Run focused tests with temporary media and inspect no out-of-scope files are removed.
- [ ] **Step 6: Commit with `git commit -m "fix: enforce upload policy across all flows"`.

### Task 3: Make test-mode exit an explicit safe transition

**Files:**
- Create: `common/test_data.py`
- Modify: `staff_panel/views.py:activity_test_toggle,activity_clear_test_data`
- Modify: `staff_panel/tests.py`, `common/tests.py`
- Modify: export query builders in `staff_panel/views.py`

**Interfaces:**
- `test_data_counts(activity) -> dict[str, int]` reports owned test rows and files.
- `clear_activity_test_data(activity, *, operator) -> dict[str, int]` atomically removes only marked owned rows through safe file deletion and records the caller separately from the view.
- `leave_test_mode(activity, *, operator, clear=False, reason="") -> dict[str, int]` refuses when counts are nonzero unless `clear=True` and a reason is supplied; it then clears and flips the mode in one transaction.

- [ ] **Step 1: Write failing tests** for refusing exit with residual data, cleanup preserving production rows/files, repeated cleanup, and export exclusion.
- [ ] **Step 2: Run focused tests and verify the boolean toggle currently leaves test rows and formal exports include them.
- [ ] **Step 3: Implement count, clear, and transition services using activity-scoped dependencies and `transaction.atomic()`.
- [ ] **Step 4: Update the test-mode UI to show counts and require an explicit cleanup confirmation/reason.
- [ ] **Step 5: Add `is_test_data=False` filters to every formal result/export query and test each export builder.
- [ ] **Step 6: Run focused tests and commit with `git commit -m "fix: make test mode exit safe"`.

### Task 4: Replace VoteRecord identity inference with ballots and choices

**Files:**
- Modify: `voting/models.py`
- Create: `voting/migrations/0004_vote_ballot_and_choice.py`
- Create: `voting/services.py`
- Modify: `voting/views.py`
- Modify: `staff_panel/views.py`, `common/management/commands/seed_demo_data.py`
- Test: `voting/tests.py`, `staff_panel/tests.py`, `common/tests.py`

**Interfaces:**
- `VoteBallot` has `vote_session`, `browser_session_key`, `ip_address`, `submitted_at`, and `is_test_data`, with a database unique constraint on `(vote_session, browser_session_key)`.
- `VoteChoice` has `ballot` and `vote_option`, with a unique constraint on `(ballot, vote_option)`.
- `submit_ballot(vote_session, *, browser_session_key, option_ids, ip_address) -> VoteBallot` validates session state, activity-scoped options, selection count, and soft IP limit, then creates ballot and choices atomically. Duplicate concurrent submissions return the existing ballot without creating another one.

- [ ] **Step 1: Write failing tests** for one ballot with multiple choices, duplicate browser submission, forged option IDs, selection limits, and a shared IP with distinct browser sessions.
- [ ] **Step 2: Run `uv run pytest voting/tests.py -q` and verify current multi-row identity and race behavior fail the new assertions.
- [ ] **Step 3: Add models and a data migration that groups existing VoteRecord rows by session/browser key, creates one ballot per group, and creates one choice per existing option before removing the legacy model/table.
- [ ] **Step 4: Implement `submit_ballot` with `transaction.atomic()`, `get_or_create`/unique-integrity handling, and IP as a soft rejection signal only.
- [ ] **Step 5: Update public voting, result counts, exports, seed data, and admin/tests to use `VoteBallot`/`VoteChoice`.
- [ ] **Step 6: Run migration tests and focused voting tests; commit with `git commit -m "fix: make voting ballots concurrency-safe"`.

### Task 5: Scope vote options and reconcile generated popularity awards

**Files:**
- Modify: `staff_panel/views.py:vote_session_create,vote_session_lock,vote_session_unlock,_generate_popularity_award`
- Modify: `singer_contest/models.py`
- Create: generated migration for `Award.source_vote_session`
- Modify: `voting/tests.py`, `staff_panel/tests.py`
- Modify: vote/award templates if action forms are affected

**Interfaces:**
- `Award.source_vote_session` is nullable for manual awards and unique for generated popularity awards.
- `_generate_popularity_award(vote_session) -> Award | None` locks the session row, deterministically computes the winner from `VoteChoice`, and updates one source-linked award so unlock/edit/relock cannot leave stale duplicates.

- [ ] **Step 1: Write failing tests** for cross-activity options and the A-wins → unlock → B-wins → relock sequence.
- [ ] **Step 2: Run focused tests and verify forged options and duplicate popularity awards currently occur.
- [ ] **Step 3: Add source linkage, activity validation, and atomic deterministic reconciliation; use POST-only lock/unlock/toggle decorators.
- [ ] **Step 4: Update templates to forms with CSRF tokens and unlock reason fields.
- [ ] **Step 5: Run focused tests and migration checks.
- [ ] **Step 6: Commit with `git commit -m "fix: reconcile popularity awards on relock"`.

### Task 6: Verify the workstream and perform security review

- [ ] **Step 1:** Run `uv run pytest files/tests.py voting/tests.py staff_panel/tests.py common/tests.py -q`.
- [ ] **Step 2:** Run `uv run python manage.py check` and `uv run python manage.py makemigrations --check --dry-run`.
- [ ] **Step 3:** Search all tracked code for direct `SubmissionFile.objects.create`, `SubmissionFile.objects.filter(...).delete`, and `VoteRecord` references; resolve every production reference.
- [ ] **Step 4:** Review test-mode deletion predicates and vote authorization for cross-activity or production-data access.
- [ ] **Step 5:** Commit review fixes with `git commit -m "test: cover file and voting safety boundaries"`.
