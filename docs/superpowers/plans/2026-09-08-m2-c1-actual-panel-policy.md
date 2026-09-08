# Plan: M2-C1 Actual Panel Policy Closure

> **For the implementing agent:** REQUIRED SUB-SKILL: Use `superpowers:executing-plans` to execute this plan task-by-task.

**Goal:** Freeze an explicit minimum-panel policy at round configuration time, capture actual attending judges in the authority snapshot, and make every scoring-matrix consumer use that snapshot.

**Architecture:** Add nullable `ContestRound.minimum_judge_count` as DRAFT-only configuration. Extend `prepare_judge_panel` with an explicit attending-ID set; validate it against the prepared `RoundJudge` roster and persist only the attending members in the existing immutable panel snapshot. Add a single services helper that prefers the latest `ACTIVE` panel snapshot and falls back to legacy `RoundJudge` only when no formal snapshot exists. Route matrix, import, recalculation, lock, and staff-grid consumers through that helper.

**Tech stack:** Django 6, PostgreSQL/SQLite test matrix, existing authority scopes, Django `TestCase`, Pyright, Tailwind build only if templates change.

## Task 1: Document and baseline the contract

**Files:** `docs/m2-c1-actual-panel-policy.md`, this plan

1. Record expected roster, actual panel, minimum policy, fail-safe behavior, error semantics, and the single matrix source.
2. Review the plan for authority bypasses, legacy compatibility, and migration impact.
3. Run `git diff --check`, then commit only the spec and plan:
   `docs: specify m2-c1 actual panel policy`.

## Task 2: Add failing authority and matrix tests (RED)

**Files:** `singer_contest/test_judge_authority.py`, `singer_contest/tests.py`

1. Add a prepared five-judge round with explicit minimum four and assert that four attending prepared judges create a valid snapshot.
2. Assert three attendees fail with `INSUFFICIENT_JUDGES` and do not create an active panel.
3. Assert an unset minimum fails safe to the expected roster count.
4. Assert expected/missing score cells use only the actual snapshot members, including after a global judge is added or deactivated.
5. Run the focused tests and verify these new tests fail for the current implementation before production edits.

## Task 3: Add and guard the round minimum policy

**Files:** `singer_contest/models.py`, `singer_contest/migrations/0036_round_minimum_judge_count.py`, `staff_panel/forms.py`, `staff_panel/views.py`, `templates/staff_panel/round_form.html`

1. Add nullable positive `minimum_judge_count` to `ContestRound`; include it in configuration-field authority guards.
2. Add the field to round creation validation and the staff form with clear fail-safe help text.
3. Generate the migration and verify `makemigrations --check --dry-run`.
4. Add/adjust focused tests for form persistence and post-preparation direct mutation rejection.
5. Run the focused model/form gate and commit:
   `feat: configure round minimum judge count`.

## Task 4: Implement explicit actual-panel preparation

**Files:** `singer_contest/judge_authority.py`, `singer_contest/test_judge_authority.py`

1. Replace scoring-mode-derived minimum logic with configured minimum or expected roster count.
2. Validate `DROP_HIGH_LOW` minimum > 2 and configured minimum <= expected roster count.
3. Normalize and validate attending IDs as a subset of `RoundJudge`; do not query the mutable activity-wide judge list for authority.
4. Preserve idempotence for an existing active snapshot and keep the insufficient-attendance path fail-safe with no active snapshot.
5. Include expected/actual/minimum and attending IDs in the audit payload.
6. Run the focused authority tests and commit:
   `fix: enforce actual judge panel policy`.

## Task 5: Bind all scoring consumers to the formal panel

**Files:** `singer_contest/services.py`, `staff_panel/views.py`, `singer_contest/tests.py`, relevant import/lock tests

1. Add one typed helper for the authoritative panel judges: latest active snapshot members first, legacy `RoundJudge` fallback only when no snapshot exists.
2. Route expected cells, missing cells, score membership, recalculation, workbook parsing, staff score grid, round lock, and readiness payloads through it.
3. Add regression coverage for a panel member being deactivated globally and for an absent prepared judge not creating required cells.
4. Run focused singer/staff tests plus Pyright and commit:
   `fix: bind score matrix to panel snapshot`.

## Task 6: Two-round review and full verification

1. Review 1: inspect the diff against the spec, authority scopes, model guards, migration, and all `_active_judges` consumers; run `git diff --check` and targeted tests.
2. Review 2: inspect error paths, duplicate/foreign IDs, stale snapshots, lock/recalculate consistency, security leakage, and type diagnostics; run the full required gates.
3. Run Django checks/tests, migration check, docs check, client checks if templates changed, Pyright baseline and entry-access gates, and PostgreSQL targeted acceptance with Docker.
4. Commit any isolated verification/doc fixes separately, then merge the feature branch into `main` with `--no-ff` and push. If push times out, retry through `127.0.0.1:12334`.

