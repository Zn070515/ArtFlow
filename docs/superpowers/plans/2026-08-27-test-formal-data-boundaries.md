# Test/Formal Data Boundaries Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make test mode one-way, prevent formal data from being reclassified or removed as test data, and keep generated documents out of formal archives when they originate in test mode.

**Architecture:** Add a monotonic `Activity.DataLifecycle` marker while retaining `is_test_mode` for compatibility. Route all transitions through the existing test-data service, guard model saves against formal-to-test changes, and mark generated documents at creation. Cleanup deletes only test-owned runtime rows/files and formal archives filter on the marker.

**Tech Stack:** Django 6, Django migrations, existing `common.test_data`, file storage services, staff-panel export/archive views, Django `TestCase`.

**Spec:** `docs/superpowers/specs/2026-08-27-competition-domain-hardening-design.md`

## Global Constraints

- Once formal, an activity cannot return to test mode; further rehearsal uses an activity clone.
- Formal data is never deleted or relabeled as test data by test cleanup.
- `GeneratedDocument.is_test_data` is set from the activity lifecycle.
- Test-data cleanup removes test generated documents and their files through the existing storage deletion path.
- Private generated files continue to be served through controlled media access.

---

### Task 1: Add monotonic activity lifecycle

**Files:**
- Modify: `core/models.py`
- Create: `core/migrations/0003_activity_data_lifecycle.py`
- Modify: `core/admin.py`
- Test: `common/tests.py`

**Interfaces:**
- Produces `Activity.DataLifecycle.TEST` and `Activity.DataLifecycle.FORMAL`.
- `Activity.is_test_mode` remains available to existing templates and callers.
- `Activity.save()` rejects a persisted formal activity being saved with test lifecycle/test mode.

- [ ] **Step 1: Write failing lifecycle tests**

Add an `ActivityLifecycleTests` class. Add `test_formal_activity_cannot_reenter_test_mode` and `test_new_formal_activity_has_consistent_marker`. The first creates a formal activity and asserts `ValidationError` when setting test mode; the second creates a formal activity and asserts `data_lifecycle=FORMAL` and `is_test_mode=False`. Migration backfill is verified separately by applying migrations to a clean database and inspecting rows; it is not simulated by a normal post-migration unit test.

```python
def test_formal_activity_cannot_reenter_test_mode(self):
    activity = Activity.objects.create(
        title="Formal", activity_type=Activity.Type.SINGER_CONTEST, is_test_mode=False
    )
    activity.is_test_mode = True
    with self.assertRaises(ValidationError):
        activity.save()
```

- [ ] **Step 2: Run the focused tests and confirm failure**

Run `uv run python manage.py test common.tests.ActivityLifecycleTests.test_formal_activity_cannot_reenter_test_mode common.tests.ActivityLifecycleTests.test_migration_compatibility_preserves_existing_test_flag`.

Expected result: failure because `DataLifecycle` and the guard do not exist.

- [ ] **Step 3: Implement the field, guard, and migration**

Add the lifecycle field with default `TEST`, backfill `FORMAL` where `is_test_mode=False`, keep test rows aligned, and update admin list/filter fields. In `save()`, set a new activity's marker from its initial `is_test_mode` value; when updating an existing formal row, reject either `is_test_mode=True` or `data_lifecycle=TEST`. When a test activity changes to formal, set both values consistently. New formal activities are allowed for existing data/bootstrap compatibility.

- [ ] **Step 4: Run lifecycle tests and migration checks**

Run the focused tests and `uv run python manage.py makemigrations --check --dry-run`.

- [ ] **Step 5: Commit the task**

```text
git add core/models.py core/admin.py core/migrations/0003_activity_data_lifecycle.py common/tests.py
git commit -m "feat: make activity data lifecycle monotonic"
```

### Task 2: Harden test-mode transitions and creation flags

**Files:**
- Modify: `common/test_data.py`
- Modify: `staff_panel/views.py`
- Modify: `singer_contest/views.py`
- Modify: `farewell_show/views.py`
- Modify: `staff_panel/tests.py`
- Modify: `common/tests.py`

**Interfaces:**
- `leave_test_mode()` is the only normal TEST-to-FORMAL transition.
- `activity_test_toggle` rejects formal-to-test with `PermissionDenied` and directs operators to clone.
- New runtime objects use `activity.is_test_mode` only after the activity row is locked inside the transition/create transaction.

- [ ] **Step 1: Write failing transition and overwrite tests**

Add `test_formal_activity_cannot_be_reopened_in_test_mode`, `test_formal_score_update_stays_formal`, and `test_test_cleanup_cannot_delete_formal_registration`. Create formal rows, attempt the toggle, update a formal score through `apply_scores`, and run cleanup with a formal row present.

- [ ] **Step 2: Run tests and confirm the existing re-entry bug**

Run `uv run python manage.py test staff_panel.tests common.tests`.

Expected result: the re-entry test currently returns a redirect and the formal-row assertions expose the unsafe path.

- [ ] **Step 3: Implement guarded transition and creation behavior**

Lock the activity in `leave_test_mode()`, validate lifecycle and residual counts, require a reason for clear-and-exit, set both lifecycle and `is_test_mode=False`, and audit the transition. In the toggle view, call only `leave_test_mode()` for test activities and reject formal activities. Ensure score, vote, registration, program, incident, and file creation paths cannot request test data for formal activities.

- [ ] **Step 4: Run related tests and inspect security paths**

Run `uv run python manage.py test common staff_panel singer_contest farewell_show files` and review every changed creation path with `rg -n "is_test_data=|is_test=" singer_contest farewell_show files voting incidents staff_panel`.

Expected result: formal writes remain formal and cleanup leaves formal objects/files untouched.

- [ ] **Step 5: Commit the task**

```text
git add common/test_data.py staff_panel/views.py singer_contest/views.py farewell_show/views.py staff_panel/tests.py common/tests.py
git commit -m "fix: prevent formal data from reentering test mode"
```

### Task 3: Mark generated documents and filter archives

**Files:**
- Modify: `exports/models.py`
- Create: `exports/migrations/0002_generated_document_test_marker.py`
- Modify: `staff_panel/views.py`
- Modify: `common/test_data.py`
- Modify: `staff_panel/tests.py`
- Modify: `common/tests.py`

**Interfaces:**
- `GeneratedDocument.is_test_data` is a persisted BooleanField.
- Word generation sets the marker from the activity lifecycle.
- Archive package creation includes only `GeneratedDocument.objects.filter(activity=activity, is_test_data=False)`.

- [ ] **Step 1: Write failing document tests**

Add `test_generated_test_document_is_removed_with_file`, `test_formal_archive_excludes_test_generated_document`, and `test_formal_word_generation_creates_formal_document`. Assert both database rows and storage files.

- [ ] **Step 2: Run tests and confirm missing-marker/filter failures**

Run `uv run python manage.py test staff_panel.tests common.tests`.

Expected result: failure because the model has no marker and archive/cleanup treat all documents equally.

- [ ] **Step 3: Implement marker, cleanup, and archive filtering**

Add the field and migration backfill from `activity.is_test_mode`. Set it in `word_generate`, delete test documents using their file storage delete method before deleting rows, and filter archive documents to formal ones. Preserve controlled media access and do not use client file paths.

- [ ] **Step 4: Run focused tests and migration checks**

Run `uv run python manage.py test staff_panel.tests common.tests`, `uv run python manage.py makemigrations --check --dry-run`, and `git diff --check`.

- [ ] **Step 5: Commit the task**

```text
git add exports/models.py exports/migrations/0002_generated_document_test_marker.py staff_panel/views.py common/test_data.py staff_panel/tests.py common/tests.py
git commit -m "fix: isolate test generated documents"
```

### Task 4: Preserve child locks and make clone configuration-only

**Files:**
- Modify: `staff_panel/views.py`
- Modify: `common/business_rules.py`
- Modify: `staff_panel/tests.py`

**Interfaces:**
- `ensure_activity_unlocked`, `ensure_round_unlocked`, and `ensure_vote_session_unlocked` implement the activity overlay without mutating child flags.
- `activity_lock` and `activity_unlock` update only activity lock fields and audit rows.
- `activity_clone` copies configuration with test lifecycle and no runtime snapshots/documents.

- [ ] **Step 1: Write failing lock-overlay tests**

Add `test_activity_unlock_does_not_unlock_locked_round`, `test_activity_unlock_does_not_unlock_locked_vote_session`, and `test_activity_lock_does_not_destroy_child_open_state`. Lock a child independently, lock/unlock the activity, then assert child fields are unchanged and mutation remains blocked while either layer is locked.

- [ ] **Step 2: Run tests and confirm current child mutation**

Run `uv run python manage.py test staff_panel.tests.StaffPanelTests`.

Expected result: failures show activity unlock updates child locks.

- [ ] **Step 3: Implement the overlay behavior**

Remove child `.update()` calls from activity lock/unlock. Keep the activity row locked during the transition. Ensure all existing mutation guards use the activity overlay and retain admin/reason requirements for unlock.

- [ ] **Step 4: Verify clone isolation and lock tests**

Run `uv run python manage.py test staff_panel common` and inspect clone queries to ensure no `ScoreRecord`, `ScoreSummary`, `VoteBallot`, `VoteRecord`, `GeneratedDocument`, or submission runtime rows are copied.

- [ ] **Step 5: Commit the task**

```text
git add staff_panel/views.py common/business_rules.py staff_panel/tests.py
git commit -m "fix: preserve child locks under activity overlay"
```

## Plan Review Checklist

- [ ] Every test/formal and generated-document requirement in the spec has an explicit test.
- [ ] `is_test_mode` compatibility and the new monotonic lifecycle never contradict each other.
- [ ] Cleanup filters by ownership and test marker and cannot delete formal rows.
- [ ] Locking behavior is defined as an overlay in both services and views.
