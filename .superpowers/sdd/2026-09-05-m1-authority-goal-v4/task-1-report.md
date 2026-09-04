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
