# Business Correctness Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enforce permission, scoring, state-transition, activity-ownership, and audit invariants at the application boundary.

**Architecture:** Keep `staff_panel` as the HTTP adapter while moving scoring rules into `singer_contest/services.py` and shared ownership checks into `common/business_rules.py`. Use Django transactions for each business mutation and retain existing URLs with POST-only semantics.

**Tech Stack:** Django 6.0, Django TestCase, SQLite/PostgreSQL, Decimal, openpyxl, existing AuditLog and pytest-django gates.

**Spec:** `docs/superpowers/specs/2026-08-27-production-correctness-hardening-design.md`

## Global Constraints

- No linked worktrees; work directly on `feat/production-correctness-hardening`.
- All state-changing endpoints require POST, CSRF, and server-side authorization.
- Formal scoring cannot lock with a missing expected judge/singer cell.
- Score validation happens before mutation; mutation, recalculation, and audit are atomic.
- Cross-activity foreign-key combinations are rejected before save.
- Do not delete unmarked or production data.
- Preserve the existing test, lint, type, migration, coverage, and documentation gates.

---

### Task 1: Synchronize role-derived staff permissions

**Files:**
- Modify: `accounts/models.py:User.save`
- Create: `accounts/migrations/0002_reconcile_staff_flag.py`
- Test: `accounts/tests.py`

**Interfaces:**
- `User.save()` sets `is_staff = self.role in (User.Role.STAFF, User.Role.ADMIN) or self.is_superuser` before the database write.
- Migration updates only non-superusers whose role is not staff/admin and whose stored `is_staff` is true.

- [ ] **Step 1: Write failing tests** for role promotion, role demotion, and a superuser demotion preserving `is_staff`.
- [ ] **Step 2: Run `uv run pytest accounts/tests.py -q` and verify the demotion assertion fails because `is_staff` remains true.
- [ ] **Step 3: Implement the bidirectional `User.save()` derivation and the idempotent data migration.
- [ ] **Step 4: Run `uv run pytest accounts/tests.py -q` and verify all focused tests pass.
- [ ] **Step 5: Run `uv run python manage.py makemigrations --check --dry-run`.
- [ ] **Step 6: Commit with `git commit -m "fix: synchronize role-derived staff access"`.

### Task 2: Create the scoring domain service and missing-cell contract

**Files:**
- Create: `singer_contest/services.py`
- Modify: `singer_contest/models.py` only if a validator or constraint is required
- Test: `singer_contest/tests.py`

**Interfaces:**
- `validate_score(value: object) -> Decimal` accepts finite numeric values from 0 to 100 with no more than two decimal places and raises `ValidationError` otherwise.
- `expected_score_cells(contest_round) -> list[tuple[int, int]]` returns `(singer_id, judge_id)` for approved singers and active judges in the same activity.
- `missing_score_cells(contest_round) -> list[dict[str, int | str]]` returns singer/judge identifiers and display names for absent score rows.
- `recalculate_round(contest_round) -> None` updates summaries only from complete expected cells.

- [ ] **Step 1: Write failing tests** for invalid text, 100.01, negative values, NaN/infinity, missing score rows, inactive judges, and cross-activity rows.
- [ ] **Step 2: Run `uv run pytest singer_contest/tests.py -q` and verify each new behavior fails against the nullable query and permissive DecimalField.
- [ ] **Step 3: Implement Decimal parsing, expected-cell calculation, missing-cell reporting, and complete-only recalculation with activity-scoped querysets.
- [ ] **Step 4: Run the focused tests and verify they pass.
- [ ] **Step 5: Run `uv run ruff check singer_contest/services.py singer_contest/tests.py`.
- [ ] **Step 6: Commit with `git commit -m "feat: centralize complete score calculations"`.

### Task 3: Make manual score entry atomic and auditable

**Files:**
- Modify: `staff_panel/views.py:round_score_entry`
- Modify: `staff_panel/tests.py`
- Modify: `templates/staff_panel/round_score_entry.html`

**Interfaces:**
- Add `apply_scores(contest_round, score_values, operator, *, note="") -> list[dict[str, str | int | None]]` in `singer_contest.services`; it validates the entire mapping, applies it inside `transaction.atomic()`, recalculates, and records one structured audit diff.
- Manual entry passes all submitted cells to `apply_scores` and renders validation errors without changing any row.

- [ ] **Step 1: Write failing tests** for a malformed score rolling back an earlier valid cell, a valid batch creating summaries, and an edit audit containing old/new values.
- [ ] **Step 2: Run `uv run pytest staff_panel/tests.py -q` and verify the batch rollback and audit assertions fail.
- [ ] **Step 3: Implement `apply_scores` with pre-validation, `transaction.atomic()`, `select_for_update()` on the round, `update_or_create`, recalculation, and structured JSON audit data.
- [ ] **Step 4: Adapt the view to use the service and show field-level error text.
- [ ] **Step 5: Run focused tests and verify all pass.
- [ ] **Step 6: Commit with `git commit -m "fix: make manual scoring atomic"`.

### Task 4: Make Excel score import parse-then-apply

**Files:**
- Modify: `singer_contest/services.py`
- Modify: `staff_panel/views.py:excel_import_scores`
- Modify: `staff_panel/tests.py`
- Modify: `templates/staff_panel/excel_import.html`

**Interfaces:**
- `parse_score_workbook(uploaded_file, contest_round) -> tuple[dict[tuple[int, int], Decimal], list[str]]` performs all workbook, header, singer, judge, duplicate, blank, numeric, finite, and range validation without database writes.
- The import view calls `apply_scores` only when the returned error list is empty.

- [ ] **Step 1: Write failing tests** for an invalid row after valid rows leaving the database unchanged, unknown singer/judge, duplicate headers, and malformed workbook.
- [ ] **Step 2: Run `uv run pytest staff_panel/tests.py -q` and verify the partial-write test fails.
- [ ] **Step 3: Implement the pure parse/validate phase and call the atomic apply service only on zero errors.
- [ ] **Step 4: Run focused tests and verify no score or summary is written on any parse error.
- [ ] **Step 5: Commit with `git commit -m "fix: make score imports all-or-nothing"`.

### Task 5: Protect round and activity state transitions

**Files:**
- Modify: `staff_panel/views.py:round_lock,round_unlock,activity_test_toggle,activity_lock,activity_unlock`
- Modify: `staff_panel/urls.py` only if route names need no change
- Modify: `templates/staff_panel/round_ranking.html`
- Modify: `templates/staff_panel/export_center.html`
- Test: `staff_panel/tests.py`

**Interfaces:**
- Ordinary `lock_round(request, pk)` refuses a round with `missing_score_cells()` and returns a clear response.
- Admin unlock endpoints require POST and a non-empty reason; the reason is persisted in the audit record.
- Test-mode transition is POST-only in this workstream; cleanup semantics are completed in the test-data plan.

- [ ] **Step 1: Write failing tests** asserting GET returns 405 for every listed mutation and incomplete rounds cannot lock.
- [ ] **Step 2: Run `uv run pytest staff_panel/tests.py -q` and verify GET still mutates and incomplete rounds still lock.
- [ ] **Step 3: Add `@require_POST`, complete-score locking, and reason validation; keep `_require_admin` checks before mutation.
- [ ] **Step 4: Replace mutation links with CSRF forms and an unlock-reason field.
- [ ] **Step 5: Run focused tests and inspect that GET requests leave state and audit counts unchanged.
- [ ] **Step 6: Commit with `git commit -m "fix: secure result state transitions"`.

### Task 6: Enforce same-activity ownership at service and view boundaries

**Files:**
- Modify: `common/business_rules.py`
- Modify: `staff_panel/views.py:award_create,vote_session_create,incident_create`
- Modify: `voting/views.py` if shared validation is needed
- Modify: `singer_contest/models.py` and `voting/models.py` only for expressible database constraints
- Create: migrations generated by Django
- Test: `common/tests.py`, `staff_panel/tests.py`, `voting/tests.py`

**Interfaces:**
- `ensure_same_activity(expected_activity, related_object, *, label) -> None` raises `PermissionDenied` when a submitted related object belongs to another activity.
- Award creation validates `singer.activity_id == activity.pk`; vote options validate `singer.activity_id == vote_session.activity_id` before any option is created.

- [ ] **Step 1: Write failing tests** forging cross-activity singer IDs for awards and vote options and asserting zero partial rows.
- [ ] **Step 2: Run the focused tests and verify forged IDs are currently accepted.
- [ ] **Step 3: Implement shared checks and scope all form querysets by selected activity.
- [ ] **Step 4: Add database constraints only where they do not require cross-table checks; generate and inspect migrations.
- [ ] **Step 5: Run `uv run python manage.py migrate --plan` and focused tests.
- [ ] **Step 6: Commit with `git commit -m "fix: enforce activity ownership boundaries"`.

### Task 7: Complete audit semantics and verify the full workstream

**Files:**
- Modify: `common/audit.py` if JSON serialization helper is needed
- Modify: `staff_panel/views.py` for unlock/relock old/new values
- Modify: `common/tests.py`, `staff_panel/tests.py`, `singer_contest/tests.py`
- Modify: `docs/` with the new incident-test contract

- [ ] **Step 1: Write failing tests** proving rolled-back score batches create no audit row and successful edits identify operator, singer, judge, old score, and new score.
- [ ] **Step 2: Run focused tests and verify the current coarse audit record fails the assertions.
- [ ] **Step 3: Implement transaction-bound audit creation and JSON-safe Decimal serialization.
- [ ] **Step 4: Run `uv run pytest accounts/tests.py singer_contest/tests.py staff_panel/tests.py common/tests.py -q`.
- [ ] **Step 5: Run `uv run python manage.py check`, `uv run python manage.py makemigrations --check --dry-run`, `uv run ruff check .`, and `uv run mypy`.
- [ ] **Step 6: Perform a contract/semantic review of all workstream files, then commit with `git commit -m "test: cover business correctness invariants"`.
