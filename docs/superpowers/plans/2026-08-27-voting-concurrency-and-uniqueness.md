# Voting Concurrency and Registration Uniqueness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make ballot submission linearizable under PostgreSQL concurrency and enforce one singer registration per activity/user and per activity/student.

**Architecture:** Revalidate the locked vote-session row inside the write transaction, preserving the existing browser-session unique constraint as the final idempotency guard. Add database uniqueness to `SingerRegistration`, translate integrity failures at the application boundary, and make the participant page use an explicit activity-scoped registration.

**Tech Stack:** Django 6, PostgreSQL `TransactionTestCase`, SQLite-compatible unit tests, Django constraints, existing voting and singer-contest services/views.

**Spec:** `docs/superpowers/specs/2026-08-27-competition-domain-hardening-design.md`

## Global Constraints

- `submit_ballot()` rechecks `is_open`, `is_locked`, activity lock state, and the time window after obtaining `select_for_update()`.
- The existing unique browser ballot constraint remains the final concurrency guard.
- Existing duplicate registrations must be detected before constraints apply; no automatic deletion or winner selection is allowed.
- All activity ownership checks remain mandatory.
- Sustained load thresholds are out of scope; the real PostgreSQL concurrency regression test is required.

---

### Task 1: Add duplicate-registration data check and database constraints

**Files:**
- Modify: `singer_contest/models.py`
- Create: `singer_contest/migrations/0006_registration_uniqueness.py`
- Modify: `singer_contest/tests.py`
- Modify: `common/tests.py`

**Interfaces:**
- Adds unique constraints `singer_registration_one_user_per_activity` and `singer_registration_one_student_per_activity`.
- Migration aborts with a clear `RuntimeError` if duplicate existing rows are found instead of deleting data.

- [ ] **Step 1: Write failing constraint tests**

Add `test_same_user_cannot_register_twice_in_activity`, `test_same_student_cannot_register_twice_in_activity`, and `test_same_user_can_register_in_different_activities`.

```python
def test_same_user_cannot_register_twice_in_activity(self):
    self.make_singer(student_id="20260001")
    with self.assertRaises(IntegrityError):
        self.make_singer(student_id="20260002")
```

- [ ] **Step 2: Run tests and confirm current duplicates are accepted**

Run `uv run python manage.py test singer_contest.tests.RegistrationConstraintTests`.

Expected result: duplicate tests fail because no database constraints exist.

- [ ] **Step 3: Implement duplicate detection and constraints**

Add a migration `RunPython` check grouping by activity/user and activity/student ID. Raise a descriptive runtime error listing duplicate keys and primary keys, then add the two `UniqueConstraint` objects. Do not modify or delete rows in the migration.

- [ ] **Step 4: Update fixtures that intentionally create multiple singers**

Give each same-activity singer a distinct user while retaining same-user/different-activity fixtures. Do not weaken the constraint to make old test setup pass.

- [ ] **Step 5: Run constraint tests and migration checks**

Run `uv run python manage.py test singer_contest common`, `uv run python manage.py makemigrations --check --dry-run`, and `uv run python manage.py migrate`.

- [ ] **Step 6: Commit the task**

```text
git add singer_contest/models.py singer_contest/migrations/0006_registration_uniqueness.py singer_contest/tests.py common/tests.py
git commit -m "fix: enforce unique activity registrations"
```

### Task 2: Surface duplicate registration errors safely

**Files:**
- Modify: `singer_contest/views.py`
- Modify: `templates/singer_contest/apply.html`
- Modify: `singer_contest/tests.py`

**Interfaces:**
- Registration POST catches `IntegrityError` around the registration insert and returns the normal form with a stable validation message.
- File storage is not attempted when the registration insert fails.

- [ ] **Step 1: Write failing view test**

Add `test_apply_shows_duplicate_registration_error_without_uploading_files`. Submit the same activity twice and assert HTTP 200, an explanatory message, one registration, and no second submission file.

- [ ] **Step 2: Run the test and confirm raw integrity failure**

Run `uv run python manage.py test singer_contest.tests.SingerUploadViewTests.test_apply_shows_duplicate_registration_error_without_uploading_files`.

Expected result: the second POST raises an unhandled integrity error or returns a server error.

- [ ] **Step 3: Implement the application boundary**

Catch only the expected uniqueness `IntegrityError` inside the transaction, roll back the failed insert, append a user-facing message that does not include SQL/database details, and render the same form context. Leave upload validation before the transaction.

- [ ] **Step 4: Run view tests**

Run `uv run python manage.py test singer_contest.tests.SingerUploadViewTests`.

- [ ] **Step 5: Commit the task**

```text
git add singer_contest/views.py templates/singer_contest/apply.html singer_contest/tests.py
git commit -m "fix: handle duplicate registration submissions"
```

### Task 3: Make ballot state validation linearizable

**Files:**
- Modify: `voting/services.py`
- Modify: `voting/tests.py`

**Interfaces:**
- `submit_ballot()` validates option identity and selection shape before the transaction, then revalidates the current locked session and activity state inside it.
- A session locked or closed after the caller's initial object was loaded raises `ValidationError` and creates no ballot/records.

- [ ] **Step 1: Write failing stale-object tests**

Add `test_submit_rechecks_session_after_lock`, `test_submit_rechecks_activity_lock_after_lock`, and `test_submit_rechecks_time_window_after_lock`. Load a stale session object, mutate the database row, then call `submit_ballot()` with the stale object and assert no writes.

- [ ] **Step 2: Run tests and confirm pre-transaction validation bug**

Run `uv run python manage.py test voting.tests.VoteBallotTests.test_submit_rechecks_session_after_lock voting.tests.VoteBallotTests.test_submit_rechecks_activity_lock_after_lock voting.tests.VoteBallotTests.test_submit_rechecks_time_window_after_lock`.

Expected result: current code creates a ballot after the database row is locked/closed because it only checks the stale object.

- [ ] **Step 3: Implement the locked-row revalidation**

Inside the existing outer `transaction.atomic()`, load the session with `select_for_update().select_related("activity")`, obtain `now` after the lock, reject closed/locked/activity-locked/out-of-window sessions, then load options against `locked_session` and create the ballot/records. Preserve the duplicate-browser early return and unique constraint handling.

- [ ] **Step 4: Run voting tests**

Run `uv run python manage.py test voting`.

- [ ] **Step 5: Commit the task**

```text
git add voting/services.py voting/tests.py
git commit -m "fix: revalidate locked vote sessions"
```

### Task 4: Add real PostgreSQL same-browser concurrency coverage

**Files:**
- Modify: `voting/tests.py`
- Modify: `.github/workflows/integration.yml`
- Modify: `README.md`

**Interfaces:**
- Adds a PostgreSQL-only `TransactionTestCase` named `ConcurrentVoteBallotTests`.
- The test starts two worker threads with separate Django connections, synchronizes them at a barrier, and asserts one ballot and one vote record after both calls complete.

- [ ] **Step 1: Write the failing concurrency test**

Create a live session and one option in `setUpTestData`/`setUp`, then use `threading.Barrier(2)` and `close_old_connections()` in each worker. Call `submit_ballot()` with the same browser key from both workers and collect exceptions. Assert the worker results contain two successful references to the same ballot, `VoteBallot.objects.count() == 1`, and `VoteRecord.objects.count() == 1`.

- [ ] **Step 2: Run it against SQLite and confirm the documented skip**

Run `uv run python manage.py test voting.tests.ConcurrentVoteBallotTests`. Expected result: skip when `connection.vendor != "postgresql"`; it must not be silently treated as a passing SQLite concurrency proof.

- [ ] **Step 3: Run it against PostgreSQL and confirm the expected failure or pass state**

Run with `DATABASE_ENGINE=postgresql` and the repository's CI connection variables: `uv run python manage.py test voting.tests.ConcurrentVoteBallotTests`. If it fails, capture whether the error is a deadlock, duplicate insert, or thread connection issue before changing code.

- [ ] **Step 4: Make the smallest concurrency-safe adjustment**

Only adjust transaction/unique handling if the PostgreSQL test demonstrates a real failure. Keep the session row lock and do not introduce a process-local lock or a weaker uniqueness constraint.

- [ ] **Step 5: Wire the test into the PostgreSQL CI job**

Keep the test discoverable by `uv run pytest -q`; add an explicit CI command if the integration job currently excludes `TransactionTestCase`, and document the PostgreSQL requirement in `README.md`.

- [ ] **Step 6: Commit the task**

```text
git add voting/tests.py .github/workflows/integration.yml README.md
git commit -m "test: verify concurrent ballot idempotency"
```

### Task 5: Scope the participant submission page to an activity

**Files:**
- Modify: `singer_contest/views.py`
- Modify: `singer_contest/urls.py`
- Modify: `templates/singer_contest/my_submission.html`
- Modify: `singer_contest/tests.py`

**Interfaces:**
- `my_submission_view` accepts an optional `activity_id` query/form value and always filters by `user=request.user, activity_id=...`.
- With multiple registrations and no activity ID, the view presents an activity choice instead of silently selecting `.last()`.

- [ ] **Step 1: Write failing cross-activity selection test**

Add `test_my_submission_never_selects_registration_from_another_activity`. Create two registrations for the same user in two activities and assert the default response does not expose the second activity's files/content without an explicit activity selection.

- [ ] **Step 2: Run the test and confirm global-last behavior**

Run `uv run python manage.py test singer_contest.tests.SingerUploadViewTests.test_my_submission_never_selects_registration_from_another_activity`.

Expected result: current view selects the globally latest registration.

- [ ] **Step 3: Implement explicit activity scoping**

Add activity selection to the GET/form flow, return a clear choice state when needed, use the selected activity in POST and redirect URLs, and preserve file-purpose validation and activity lock checks.

- [ ] **Step 4: Run singer-contest tests**

Run `uv run python manage.py test singer_contest`.

- [ ] **Step 5: Commit the task**

```text
git add singer_contest/views.py singer_contest/urls.py templates/singer_contest/my_submission.html singer_contest/tests.py
git commit -m "fix: scope singer submissions to activities"
```

## Plan Review Checklist

- [ ] Both database constraints and their safe application error are covered.
- [ ] Vote state is rechecked after the row lock, not merely before the transaction.
- [ ] PostgreSQL concurrency is tested with separate database connections.
- [ ] No test relies on SQLite to prove row-lock semantics.
- [ ] Participant registration reads cannot cross activity boundaries.
