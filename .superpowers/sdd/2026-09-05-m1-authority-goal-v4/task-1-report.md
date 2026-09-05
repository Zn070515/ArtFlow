# Task 1 Report: Parent Creation and Deletion Authority

## Status

Implemented and verified Task 1 only. The change closes unauthorized parent creation,
bulk-insert/conflict-update, and deletion paths for `Activity`, `ContestRound`, and
`VoteSession` without adding public bypass kwargs.


## Implementation

- Added initial-state enforcement to instance `save()` and guarded manager `bulk_create()`:
  - `Activity`: unlocked `DRAFT` only.
  - `ContestRound`: unlocked `DRAFT`, zero score version, automatic advancement only.
  - `VoteSession`: closed and unlocked only.
- Kept the established `ACTIVITY_STATE`, `CONTEST_ROUND_STATE`, and
  `VOTE_SESSION_STATE` scopes as the explicit authorized provisioning/lifecycle route.
- Made `bulk_create(update_conflicts=True)` enforce both state and the existing
  prepared/locked configuration restrictions.
- Added `TEST_DATA_CLEANUP` as the sole parent-deletion scope. It permits only safe
  test cleanup and does not weaken ordinary ORM deletion.
- `clear_activity_test_data()` now first closes/unlocks test VoteSessions under the
  existing vote-state authority, then deletes them under the cleanup authority.
- Disabled direct Activity and ContestRound Admin deletion. Prepared ContestRound child
  snapshots continue to surface Django `ProtectedError`.

## TDD Evidence

- Creation RED: `python -m pytest core/tests.py singer_contest/test_m1_core_final.py voting/tests.py -k "creation or bulk_create" -q` produced 14 expected authority failures.
- Creation GREEN: 9 tests passed with 12 manager subtests.
- Deletion RED: `... -k "delete or cleanup" -q` produced 5 expected deletion-bypass failures.
- Deletion GREEN: 8 tests passed.
- Admin RED: `python -m pytest core/tests.py singer_contest/test_m1_core_final.py -k "admin" -q` produced 2 expected Admin-permission failures.
- Conflict-update RED: `python -m pytest singer_contest/test_m1_core_final.py voting/tests.py -k "update_conflicts" -q` produced 2 expected configuration-bypass failures.

## Final Verification

- `python -m pytest core/tests.py singer_contest/test_m1_core_final.py voting/tests.py -q`: 77 passed, 3 PostgreSQL-only skips, 12 subtests passed.
- `python manage.py check`: no issues.
- `python manage.py makemigrations --check --dry-run`: no changes detected.
- `git diff --check`: clean.

## Self-review and Concerns

- Reviewed every changed production guard and the full scoped diff. The cleanup scope is
  explicit and thread-local; no caller-controlled bypass parameter was added.
- Existing focused fixtures that deliberately begin from non-initial parent states now use
  their corresponding established authority scope.
- PostgreSQL row-lock tests remain skipped on the local SQLite run; no database migration
  is required for this task.

## Review Follow-up: Parent Guard Completeness

### Scope and Implementation

- `core/models.py`: Activity initial creation now rejects non-null `locked_at` and
  `locked_by` as well as non-DRAFT or locked state, for instance saves and both manager
  bulk-create paths (including conflict updates). No public bypass was introduced.
- `core/models.py`: Activity deletion now refuses any reverse-related row while under
  `TEST_DATA_CLEANUP`. This prevents every cascade path, including formal direct children
  (`Award`, `SingerRegistration`) and formal descendants of otherwise test-marked runtime
  rows. Test cleanup must explicitly remove its test-safe children before deleting the
  now-bare TEST+DRAFT Activity; test status is never inferred from the Activity alone.
- `core/tests.py`: added manager, `bulk_create`, and `update_conflicts` provenance tests;
  added persistence regressions for formal `SingerRegistration`, `Award`, and a formal
  `VoteOption` nested below a test `VoteSession`.

### RED / GREEN Evidence

- RED: `python -m pytest core/tests.py -k "lock_provenance or formal_singer_registration or formal_award" -q`
  produced 7 expected failures (with 2 passing selected tests and 4 manager subtests):
  both managers accepted lock provenance, conflict upsert accepted it, and formal direct
  children cascaded.
- RED: `python -m pytest core/tests.py -k "formal_descendant_of_test_runtime_data" -q`
  produced 1 expected failure: a formal `VoteOption` was erased through a test
  `VoteSession` cascade.
- GREEN: `python -m pytest core/tests.py -k "lock_provenance or formal_singer_registration or formal_award or formal_descendant_of_test_runtime_data" -q`
  passed: 6 tests, 4 manager subtests.

### Final Verification and Self-review

- `python -m pytest core/tests.py singer_contest/test_m1_core_final.py voting/tests.py -q`:
  83 passed, 3 PostgreSQL row-lock skips, 16 subtests passed.
- `python manage.py check`: no issues; `python manage.py makemigrations --check --dry-run`:
  no changes detected; `git diff --check`: clean.
- Reviewed the complete follow-up diff: `_meta.related_objects` covers concrete reverse
  relations and the no-cascade deletion predicate closes direct and nested formal-data
  deletion without changing Tasks 2-10. No migration is required.

## Reviewer-fix Verification (2026-09-05)

- Focused command: `python -m pytest core/tests.py -k "lock_provenance or formal_singer_registration or formal_award or formal_descendant_of_test_runtime_data" -q`
  Result: `7 passed, 32 deselected, 6 subtests passed in 1.96s`.
- `python manage.py check`: `System check identified no issues (0 silenced).`
- `python manage.py makemigrations --check --dry-run`: `No changes detected`.

### Self-review

- Confirmed instance save, default/base manager create, bulk create, and conflict-upsert
  paths all pass through the initial-state guard; non-null `locked_at`/`locked_by` is
  rejected without lifecycle authority.
- Confirmed Activity deletion checks every concrete reverse relation before Django’s
  collector can cascade, covering formal direct children and nested descendants even
  when intermediate runtime rows are marked as test data.
- No additional code changes were necessary after review; the focused tests and both
  Django checks are clean. Broader tests were intentionally not run per task scope.
