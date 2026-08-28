# Competition Round Integrity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every competition round use an immutable roster and judge panel captured before scoring, with deterministic advancement and safe lifecycle transitions.

**Architecture:** Add `RoundEntry` and `RoundJudge` snapshot tables and a `ContestRound.status` lifecycle. A single transactional `prepare_round()` service creates snapshots; all score, import, ranking, and lock operations read snapshots only. The staff panel exposes preparation explicitly and preserves existing POST/CSRF and audit conventions.

**Tech Stack:** Django 6, PostgreSQL/SQLite, Django `TestCase`, openpyxl, existing `AuditLog` and staff-panel templates.

**Spec:** `docs/superpowers/specs/2026-08-27-competition-domain-hardening-design.md`

## Global Constraints

- Round snapshots are immutable after preparation; global judge activation and registration status changes never rewrite them.
- The next round is prepared only from the previous round's persisted `ScoreSummary.is_advanced` values.
- No guessed tie-breaking or drop-high-low policy changes.
- All state-changing staff endpoints remain POST-only and CSRF-protected.
- Same-activity validation is mandatory for all snapshot and score relations.

---

### Task 1: Add snapshot models and round status

**Files:**
- Modify: `singer_contest/models.py`
- Create: `singer_contest/migrations/0005_round_snapshot_and_status.py`
- Test: `singer_contest/tests.py`

**Interfaces:**
- Produces `ContestRound.Status` values `DRAFT`, `PREPARED`, `SCORING`, and `LOCKED`.
- Produces `RoundEntry(round, singer)` and `RoundJudge(round, judge)` with unique pairs.
- Both snapshot models reject related objects from another activity in `clean()` and `save()`.

- [ ] **Step 1: Write the failing model tests**

Add a `make_singer(*, activity, student_id, name=None, user=None)` helper to the test class that creates a distinct test user when `user` is omitted. Then add tests named `test_round_entry_rejects_singer_from_another_activity`, `test_round_judge_rejects_judge_from_another_activity`, and `test_round_snapshot_pairs_are_unique`. Assert `ValidationError` for cross-activity rows and `IntegrityError` for duplicate pairs.

```python
def test_round_entry_rejects_singer_from_another_activity(self):
    other_activity = Activity.objects.create(
        title="Other", activity_type=Activity.Type.SINGER_CONTEST
    )
    foreign = self.make_singer(activity=other_activity, student_id="foreign")
    with self.assertRaises(ValidationError):
        RoundEntry.objects.create(round=self.round, singer=foreign)
```

- [ ] **Step 2: Run the focused tests and confirm the expected failure**

Run `uv run python manage.py test singer_contest.tests.ScoringServiceTests.test_round_entry_rejects_singer_from_another_activity singer_contest.tests.ScoringServiceTests.test_round_judge_rejects_judge_from_another_activity singer_contest.tests.ScoringServiceTests.test_round_snapshot_pairs_are_unique`.

Expected result: test errors because the snapshot models and `ContestRound.Status` do not exist.

- [ ] **Step 3: Implement the models and migration**

Add the status field with default `DRAFT`, keep `is_locked` during compatibility migration, add the two foreign-key models, same-activity validation, pair constraints, admin registration, and migration. Do not add a data migration that guesses existing unlocked round rosters.

- [ ] **Step 4: Run the focused tests and migration check**

Run `uv run python manage.py test singer_contest.tests.ScoringServiceTests.test_round_entry_rejects_singer_from_another_activity singer_contest.tests.ScoringServiceTests.test_round_judge_rejects_judge_from_another_activity singer_contest.tests.ScoringServiceTests.test_round_snapshot_pairs_are_unique` and `uv run python manage.py makemigrations --check --dry-run`.

Expected result: all focused tests pass and no model changes are pending.

- [ ] **Step 5: Commit the task**

```text
git add singer_contest/models.py singer_contest/admin.py singer_contest/migrations/0005_round_snapshot_and_status.py singer_contest/tests.py
git commit -m "feat: add immutable round snapshots"
```

### Task 2: Implement transactional round preparation

**Files:**
- Modify: `singer_contest/services.py`
- Modify: `singer_contest/tests.py`

**Interfaces:**
- Produces `prepare_round(contest_round, operator) -> ContestRound`.
- Produces snapshot-backed `_eligible_singers(contest_round)` and `_active_judges(contest_round)` helpers.
- `prepare_round()` raises `ValidationError` when called after `DRAFT`, when a later round has no previous round, or when no eligible singer/judge exists.

- [ ] **Step 1: Write failing preparation tests**

Add `test_prepare_preliminary_round_snapshots_approved_non_test_singers`, `test_prepare_semifinal_round_uses_only_previous_advancers`, `test_prepare_round_snapshots_active_judges`, and `test_prepare_round_is_rejected_after_preparation`. Reuse the test class's `make_singer` helper to create 20 preliminary singers and ten advanced summaries, then assert the next round has exactly ten `RoundEntry` rows.

```python
def test_prepare_semifinal_round_uses_only_previous_advancers(self):
    semifinal = ContestRound.objects.create(
        activity=self.activity,
        round_type=ContestRound.RoundType.SEMI_FINAL,
    )
    for index in range(20):
        singer = self.make_singer(student_id=f"2026{index:04d}")
        ScoreSummary.objects.create(
            round=self.round,
            singer=singer,
            average_score=90 - index,
            rank=index + 1,
            is_advanced=index < 10,
        )
    prepare_round(semifinal, self.user)
    self.assertEqual(RoundEntry.objects.filter(round=semifinal).count(), 10)
```

- [ ] **Step 2: Run the preparation tests and confirm failure**

Run `uv run python manage.py test singer_contest.tests.ScoringServiceTests.test_prepare_preliminary_round_snapshots_approved_non_test_singers singer_contest.tests.ScoringServiceTests.test_prepare_semifinal_round_uses_only_previous_advancers singer_contest.tests.ScoringServiceTests.test_prepare_round_snapshots_active_judges singer_contest.tests.ScoringServiceTests.test_prepare_round_is_rejected_after_preparation`.

Expected result: failure because `prepare_round()` and snapshot-backed helpers do not exist.

- [ ] **Step 3: Implement the service**

Use `ContestRound.objects.select_for_update()` inside `transaction.atomic()`. For preliminary rounds query approved, non-test registrations in the activity; for later rounds query the immediately preceding round's advanced summaries and restrict by activity. Snapshot active judges, reject an empty matrix source, set status to `PREPARED`, keep `is_locked=False`, and create an audit record. Make the helper queries return registrations/judges through snapshot foreign keys ordered by primary key.

- [ ] **Step 4: Run the focused tests and inspect the query contract**

Run the four focused preparation tests and `uv run python manage.py test singer_contest.tests.ScoringServiceTests.test_expected_cells_include_approved_singer_and_active_judge` after updating that fixture to prepare the round first.

Expected result: all tests pass, and expected-cell output is based on `RoundEntry`/`RoundJudge` rather than global state.

- [ ] **Step 5: Commit the task**

```text
git add singer_contest/services.py singer_contest/tests.py
git commit -m "feat: prepare frozen competition rounds"
```

### Task 3: Move scoring and ranking to snapshots

**Files:**
- Modify: `singer_contest/services.py`
- Modify: `staff_panel/views.py`
- Modify: `singer_contest/tests.py`
- Modify: `staff_panel/tests.py`

**Interfaces:**
- `expected_score_cells`, `missing_score_cells`, `ensure_score_records_belong_to_round`, `parse_score_workbook`, and `recalculate_round` use snapshot-backed helpers.
- `apply_scores()` transitions `PREPARED` to `SCORING`, rejects `DRAFT` and `LOCKED`, and keeps existing atomic/audit behavior.

- [ ] **Step 1: Write failing snapshot immutability and inactive-judge tests**

Add `test_new_global_judge_does_not_change_prepared_matrix`, `test_registration_status_change_does_not_change_prepared_roster`, and `test_recalculate_ignores_score_from_judge_outside_snapshot`. Prepare a round, change global state, insert an old score for an inactive/non-snapshot judge, and assert missing cells and averages still reflect only the snapshot.

- [ ] **Step 2: Run the tests and confirm they expose dynamic-query behavior**

Run `uv run python manage.py test singer_contest.tests.ScoringServiceTests.test_new_global_judge_does_not_change_prepared_matrix singer_contest.tests.ScoringServiceTests.test_registration_status_change_does_not_change_prepared_roster singer_contest.tests.ScoringServiceTests.test_recalculate_ignores_score_from_judge_outside_snapshot`.

Expected result: failures show newly active judges or changed registrations entering the matrix, or the extra score changing the average.

- [ ] **Step 3: Implement snapshot-only scoring**

Replace global queries in all scoring helpers. Filter score records used in recalculation by the `RoundJudge` snapshot. Require the singer/judge pair to exist in the snapshots. Keep the current deterministic ordering and drop-high-low behavior unchanged. Set `is_test_data` from the activity flag for compatibility with the data-lifecycle plan.

- [ ] **Step 4: Update score-entry and export views**

Make `round_score_entry`, score-template generation, Excel import, and ranking use service helpers. A `DRAFT` round renders a preparation-required message and cannot accept scores. Update existing fixtures to call `prepare_round()` before score operations.

- [ ] **Step 5: Run focused scoring tests**

Run `uv run python manage.py test singer_contest staff_panel`.

Expected result: all scoring, import, ownership, and lock tests pass with no dynamic roster regressions.

- [ ] **Step 6: Commit the task**

```text
git add singer_contest/services.py singer_contest/tests.py staff_panel/views.py staff_panel/tests.py
git commit -m "fix: score only frozen round participants"
```

### Task 4: Add preparation and lifecycle controls to the staff panel

**Files:**
- Modify: `staff_panel/views.py`
- Modify: `staff_panel/urls.py`
- Modify: `templates/staff_panel/round_list.html`
- Modify: `templates/staff_panel/round_score_entry.html`
- Modify: `templates/staff_panel/round_ranking.html`
- Modify: `staff_panel/tests.py`

**Interfaces:**
- Adds POST-only `round_prepare` at `staff:round_prepare`.
- `round_lock` requires a prepared/scoring round and transitions status to `LOCKED` while setting `is_locked=True`.
- `round_unlock` is admin-only, requires a reason, and transitions a locked result back to `SCORING` without deleting snapshots.

- [ ] **Step 1: Write failing endpoint tests**

Add `test_staff_can_prepare_round`, `test_unprepared_round_cannot_accept_scores`, `test_round_lock_sets_locked_status`, and `test_round_unlock_preserves_snapshots`. Assert POST success, GET/POST behavior, and CSRF-compatible redirects.

- [ ] **Step 2: Run endpoint tests and confirm missing-route/state failures**

Run `uv run python manage.py test staff_panel.tests.StaffPanelTests.test_staff_can_prepare_round staff_panel.tests.StaffPanelTests.test_unprepared_round_cannot_accept_scores staff_panel.tests.StaffPanelTests.test_round_lock_sets_locked_status staff_panel.tests.StaffPanelTests.test_round_unlock_preserves_snapshots`.

Expected result: failure because the route and status-aware behavior are not implemented.

- [ ] **Step 3: Implement the POST endpoint and templates**

Call `prepare_round()` from the endpoint, show status and snapshot counts in the list, hide score controls until prepared, and display a stable preparation-required message. Preserve `{% csrf_token %}` in every new form. Make lock/unlock view transitions use the service/lifecycle and write the existing audit actions.

- [ ] **Step 4: Run staff tests and template checks**

Run `uv run python manage.py test staff_panel` and `pwsh -NoProfile -File scripts/check_docs.ps1`.

Expected result: all staff tests pass and documentation checks remain clean.

- [ ] **Step 5: Commit the task**

```text
git add staff_panel/views.py staff_panel/urls.py templates/staff_panel/round_list.html templates/staff_panel/round_score_entry.html templates/staff_panel/round_ranking.html staff_panel/tests.py
git commit -m "feat: add round preparation workflow"
```

### Task 5: Update seed data, admin visibility, and migration compatibility

**Files:**
- Modify: `common/management/commands/seed_demo_data.py`
- Modify: `singer_contest/admin.py`
- Modify: `common/tests.py`
- Modify: `singer_contest/tests.py`

- [ ] **Step 1: Write failing seed/compatibility assertions**

Add assertions that seeded rounds have snapshots before seeded scores/summaries are created, and that admin-visible round status matches `is_locked`.

- [ ] **Step 2: Run the assertions and confirm old seed assumptions fail**

Run `uv run python manage.py test common.tests singer_contest.tests`.

Expected result: failures identify seed rows that bypass the new snapshot contract.

- [ ] **Step 3: Update seed creation order and admin fields**

Create/configure rounds, call the same preparation service with the demo admin operator, then create demo scores. Register `RoundEntry` and `RoundJudge`; list round status and snapshot counts. Do not create snapshots for copied runtime data during activity cloning.

- [ ] **Step 4: Run migration, seed, and full related tests**

Run `uv run python manage.py migrate`, `uv run python manage.py test common singer_contest staff_panel`, and `uv run python manage.py makemigrations --check --dry-run`.

- [ ] **Step 5: Commit the task**

```text
git add common/management/commands/seed_demo_data.py singer_contest/admin.py common/tests.py singer_contest/tests.py
git commit -m "test: align demo data with frozen rounds"
```

## Plan Review Checklist

- [ ] Every round roster and judge-panel requirement in the spec has a test and implementation task.
- [ ] The status transitions, service names, and view route names are consistent across tasks.
- [ ] No task deletes or guesses existing production data.
- [ ] The plan introduces no tie-policy behavior beyond the current deterministic ordering.
