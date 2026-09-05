# Task 8 — Shared production rate limiting

## Status

Implemented on `build/m1-authority-goal-v4`. Production selects a primary-database
rate-limit backend; development and test select LocMem. The existing admin-login
and vote-passcode paths now call the same `common.rate_limit.allow()` helper.

## Design and changed files

- `common/models.py` and `common/migrations/0010_rate_limit.py`
  - Add `RateLimitBucket` with a unique 64-character SHA-256 key, window start,
    count, expiry, and an expiry index.
  - Source IP and browser-session values are hashed before persistence.
- `common/rate_limit.py`
  - Adds `RateLimitDecision(allowed, retry_after_seconds)` and `allow()`.
  - PostgreSQL uses one `INSERT ... ON CONFLICT ... DO UPDATE ... RETURNING`
    statement. It resets expired buckets or increments active ones atomically.
  - SQLite uses the transaction-scoped ORM fallback needed by local tests.
  - LocMem remains the non-production path. `hit_rate_limit()` remains as a
    generic compatibility wrapper.
- `config/settings.py`
  - `RATE_LIMIT_BACKEND` is `database` only for `APP_ENV=production`; it is
    `locmem` for development and test.
- `accounts/views.py`, `voting/views.py`
  - Both failed-attempt flows use `allow()` and consume only `allowed`.
  - Admin login keeps source IP as a coarse throttle input. Vote passcode keeps
    its existing vote-session/browser-session throttle scope. No voter identity,
    ballot uniqueness, or GOAL v4 primary-authority behavior changed.
- `accounts/tests.py`, `voting/tests.py`, `config/tests.py`
  - Cover shared persisted counts across connection boundaries, expiry reset,
    route integration for both callers, minimal decision metadata, environment
    selection, and a PostgreSQL-only two-worker conflict regression.

## TDD evidence

### RED

`python -m pytest accounts/tests.py voting/tests.py -k "throttle or rate" -q`

Result before implementation: **5 failed, 4 passed, 1 skipped**.

The failures were the intended missing-interface failures:

- `ImportError: cannot import name 'RateLimitBucket' from common.models`
- `AttributeError: module 'common.rate_limit' has no attribute 'allow'`

`python -m pytest config/tests.py -k rate_limit_backend -q`

Result before implementation: **1 failed** with missing
`config.settings.RATE_LIMIT_BACKEND`.

### GREEN

`python -m pytest accounts/tests.py voting/tests.py -k "throttle or rate" -q`

Result: **9 passed, 1 skipped**. The skip is the PostgreSQL-only concurrent
worker regression on local SQLite.

`python -m pytest config/tests.py -k rate_limit_backend -q`

Result: **1 passed**.

## Verification

- `python manage.py check` — passed: `System check identified no issues (0 silenced).`
- `python manage.py makemigrations --check --dry-run` — passed: `No changes detected`.
- Task-source Ruff check — passed for `common/rate_limit.py`, `common/models.py`,
  settings, both views, and the changed non-voting test files.
- `python -m ruff check voting/tests.py --ignore E501` — passed. A complete Ruff
  check of that file reports an unchanged baseline E501 at line 695; this task
  adds only lines 827–836.
- `git diff --check` — passed (Git emitted only existing CRLF normalization notices).

## PostgreSQL concurrency

The PostgreSQL test is present in `DatabaseRateLimitConcurrencyTests` and asserts
two independent worker threads receive exactly `[True, False]` at limit one.
Docker Desktop was unavailable locally:

`failed to connect to the docker API at npipe:////./pipe/dockerDesktopLinuxEngine`

Therefore the PostgreSQL-only test could not be run in this environment. It is
skipped on SQLite by design.

## Self-review

- The production path has one atomic unique-key upsert; no read-modify-write
  sequence is exposed between workers.
- Expired and active windows are distinguished within that statement.
- The decision object carries only allowance and retry seconds—no key, IP,
  session identifier, passcode, or credential payload.
- Persisted keys are digested, so the shared database does not retain raw
  browser-session or coarse-IP throttle values.
- Both callers share the same helper; the former exception API remains only for
  compatibility and has no active callers.
- No Redis, distributed service, worktree, subagent, or audience-identity logic
  was introduced.

## Concerns and non-task baseline failures

- Docker/PostgreSQL was unavailable, so the actual PostgreSQL concurrency run is
  pending an environment with Docker running.
- A broad `accounts/tests.py voting/tests.py config/tests.py` run stops in the
  unchanged `VotePublicStagingBoundaryTests` setup: it directly creates a STAFF
  user, while the existing authority guard requires an authorized creator. This
  is unrelated to Task 8 (the changed voting lines begin at 827) and was not
  altered to avoid scope creep.
- Repository-wide Mypy reports existing unrelated model/test typing errors;
  the package-aware run reached no Task 8 source diagnostic.

## Fix round 1 — bounded cleanup and PostgreSQL verification

### Cleanup behavior

- Each database-backed `allow()` call now performs best-effort cleanup only
  after the allowance decision has completed. The PostgreSQL
  `INSERT ... ON CONFLICT ... DO UPDATE ... RETURNING` statement is unchanged.
- Cleanup selects at most 32 expired rows, excludes the just-used hashed key,
  and rechecks `expires_at <= now` in the delete query. A bucket revived by a
  concurrent allowance is therefore not deleted, and future-expiry buckets are
  never candidates.
- Cleanup database errors do not replace or weaken an allowance decision that
  has already completed. Persistent keys remain SHA-256 digests; no raw IP,
  browser-session, passcode, or credential value is stored or returned.

### TDD evidence

RED command:

`python -m pytest accounts/tests.py::DatabaseRateLimitTests::test_database_allow_removes_only_a_bounded_expired_batch -q`

Result before implementation: **1 failed**. The focused test failed with
`AttributeError` because `common.rate_limit._CLEANUP_BATCH_SIZE` and cleanup
behavior did not yet exist.

GREEN command:

`python -m pytest accounts/tests.py::DatabaseRateLimitTests::test_database_allow_removes_only_a_bounded_expired_batch -q`

Result: **1 passed**.

The regression creates three expired buckets and one active bucket, constrains
the batch to two, and makes a real database-backed allowance. It verifies that
exactly two expired rows are removed while the pre-existing active bucket and
the newly allowed bucket remain.

### PostgreSQL and Docker

Docker later became available after the earlier
`dockerDesktopLinuxEngine` connection blocker recorded above.

`docker compose up --build --wait`

Result: **exit 0**; the `db` and rebuilt `web` services both reached healthy
status.

The first attempted in-container invocation was:

`docker compose exec -T web python -m pytest accounts/tests.py::DatabaseRateLimitConcurrencyTests::test_concurrent_workers_allow_only_the_configured_limit -q`

Result: **exit 1**, `/opt/venv/bin/python: No module named pytest`. The
production image intentionally does not include the development-only pytest
dependency.

The repository-supported Django test invocation against the same Compose
PostgreSQL service was then run exactly as:

`docker compose exec -T web python manage.py test accounts.tests.DatabaseRateLimitConcurrencyTests.test_concurrent_workers_allow_only_the_configured_limit --verbosity 2`

Result: **exit 0**; **1 test passed** (`Ran 1 test in 0.488s`, `OK`). This
executes the two-worker PostgreSQL atomic-upsert regression and confirms the
outcomes remain one allowed and one denied at limit one.

Additional PostgreSQL cleanup coverage:

`docker compose exec -T web python manage.py test accounts.tests.DatabaseRateLimitTests --verbosity 1`

Result: **exit 0**; **4 tests passed** (`Ran 4 tests in 2.253s`, `OK`).

### Fix-round verification

- `python -m pytest accounts/tests.py voting/tests.py -k "throttle or rate" -q`
  — passed: **10 passed, 1 skipped, 71 deselected**. The local skip is the
  PostgreSQL-only concurrency case verified successfully in Compose above.
- `python manage.py check` — passed: `System check identified no issues (0 silenced).`
- `python manage.py makemigrations --check --dry-run` — passed: `No changes detected`.
- `python -m ruff check common/rate_limit.py accounts/tests.py` — passed:
  `All checks passed!`
- `git diff --check` — passed with only existing CRLF normalization warnings.

## Fix round 2 — cleanup savepoint isolation

### Transaction behavior

- Only opportunistic expired-bucket cleanup now runs inside an inner
  `transaction.atomic()` savepoint. The `DatabaseError` handler remains outside
  that savepoint, so Django rolls back and restores the cleanup savepoint before
  the best-effort error is suppressed.
- The successful allowance decision is made before cleanup and remains usable
  inside a caller-owned outer atomic block. The PostgreSQL atomic upsert,
  bounded batch size, active-bucket expiry recheck, hashed storage key, caller
  scopes, and decision privacy contract are unchanged.

### TDD evidence

RED command:

`python manage.py test accounts.tests.DatabaseRateLimitTests.test_cleanup_database_error_does_not_break_outer_transaction --verbosity 2`

Result before the production fix: **exit 1**. The injected cleanup `DELETE`
failure was caught by `allow()`, but the next query in the caller's outer atomic
block raised `TransactionManagementError` because the transaction was marked
broken (`Ran 1 test in 0.021s`, `FAILED (errors=1)`).

GREEN command:

`python manage.py test accounts.tests.DatabaseRateLimitTests.test_cleanup_database_error_does_not_break_outer_transaction --verbosity 2`

Result after adding the cleanup-only savepoint: **exit 0**; **1 test passed**
(`Ran 1 test in 0.018s`, `OK`). The test also verifies that the successful
allowance bucket persists and the failed cleanup does not remove its expired
candidate.

### PostgreSQL concurrency evidence

The previously completed Compose verification was not rerun in fix round 2.
Its exact commands and results were:

`docker compose up --build --wait`

Result: **exit 0**.

Then:

`docker compose exec -T web python manage.py test accounts.tests.DatabaseRateLimitConcurrencyTests.test_concurrent_workers_allow_only_the_configured_limit --verbosity 2`

Result: **exit 0**; **1 passed**.

### Fix-round verification

- `python -m pytest accounts/tests.py voting/tests.py -k "throttle or rate" -q`
  — **exit 0**: **11 passed, 1 skipped, 71 deselected** in 11.64s. The skip is
  the PostgreSQL-only concurrency test covered by the successful Compose run
  above.
- `python manage.py check` — **exit 0**:
  `System check identified no issues (0 silenced).`
- `python manage.py makemigrations --check --dry-run` — **exit 0**:
  `No changes detected`.
- `python -m ruff check common/rate_limit.py accounts/tests.py` — **exit 0**:
  `All checks passed!`
- `git diff --check` — **exit 0** with only existing CRLF normalization
  warnings.
