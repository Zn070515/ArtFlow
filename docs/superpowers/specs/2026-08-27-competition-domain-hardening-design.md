# Competition Domain Hardening Design

**Date:** 2026-08-27  
**Status:** Approved for implementation planning  
**Scope:** Competition round integrity, test/formal data boundaries, voting concurrency, and registration uniqueness.

## Goal

Make the competition workflow deterministic and safe to resume: each round must use a frozen roster and judge panel, formal data must not be reclassified as test data, and voting/registration writes must remain correct under concurrent requests and database enforcement.

## Current Failure Modes

- Scoring currently derives singers from all approved registrations and judges from currently active global judges. A later round can therefore include singers who did not advance, and a panel can change after scoring starts.
- Recalculation reads every score row instead of the round's frozen judge panel, so an inactive global judge can still affect the result.
- An activity that has left test mode can be switched back into test mode, allowing later writes or overwritten rows to be treated as test data.
- Ballot submission checks `VoteSession` state before acquiring its row lock and does not revalidate state inside the transaction.
- Registrations have no database uniqueness for one user or one student in the same activity.
- Activity lock/unlock mutates child lock state, so unlocking the activity can silently unlock a previously locked round or vote session.
- Generated documents have no test-data marker and archive creation does not exclude test documents.
- The participant submission page selects the last registration globally instead of selecting a registration in an explicit/current activity context.

## Chosen Architecture

### 1. Round snapshots and lifecycle

Add `RoundEntry` and `RoundJudge` snapshot tables in `singer_contest`:

- `RoundEntry(round, singer)` identifies the registrations eligible for one round.
- `RoundJudge(round, judge)` identifies the judges assigned to one round.
- Both pairs are database-unique and validate that related objects belong to the same activity.

Extend `ContestRound` with a lifecycle status:

```
DRAFT -> PREPARED -> SCORING -> LOCKED
```

Existing `is_locked` remains as a compatibility/readability field during migration; `LOCKED` is the authoritative normal terminal scoring state and both fields are written consistently. An explicit admin unlock with a non-empty reason is the only exception and returns a round to `SCORING` without changing its snapshots. Existing rounds are migrated to a safe state: locked rounds become `LOCKED`; other rounds remain `DRAFT` and must be prepared before scoring.

`prepare_round(round, operator)` runs in one transaction and locks the round. It creates the immutable snapshot:

- Preliminary round: approved, non-test registrations in the round activity.
- Later round: registrations whose immediately preceding round has an advanced summary, restricted to the same activity and non-test data.
- Judges: active judges in the activity at preparation time.

Preparation is idempotent only while the round is `DRAFT`. Once prepared, the snapshot cannot be silently changed. An administrative correction, if needed, requires an explicit service operation, an operator, a non-empty reason, and an audit entry; ordinary judge activation/deactivation and registration status changes never rewrite the snapshot.

Scoring, Excel parsing, missing-cell checks, summary recalculation, ranking, and the staff score grid all consume `RoundEntry` and `RoundJudge`. Recalculation only reads score records whose judge is in the round's snapshot. Score writes must target a snapshot pair, reject `DRAFT` and `LOCKED`, and transition `PREPARED` to `SCORING` on the first successful write. Locking requires a complete snapshot matrix, transitions the round to `LOCKED`, and prevents further score writes.

The next round is prepared only from the previous round's persisted `ScoreSummary.is_advanced` values. No tie-breaking rule beyond the current deterministic score-descending/registration-ID ordering is introduced in this change; policy-specific tie rules remain a later, explicitly specified change.

### 2. One-way test/formal lifecycle

Keep `Activity.is_test_mode` as the compatibility-facing flag, and add a monotonic activity lifecycle marker (`TEST` or `FORMAL`) with a database-safe transition service. New activities start in `TEST`; `leave_test_mode()` is the only transition to `FORMAL` and requires either no remaining test data or an explicit clear operation with a reason.

Once formal, an activity cannot return to test mode. The toggle endpoint must reject that transition and direct operators to clone the activity for another rehearsal. Creation/update services derive `is_test_data` from the locked activity lifecycle; a formal activity cannot create test rows. Existing formal activities are backfilled to the formal lifecycle; existing test activities remain test.

`GeneratedDocument.is_test_data` is added and set from the activity lifecycle. Archive packages include only formal generated documents and retain the existing formal filters for spreadsheet exports. Test-data cleanup removes test generated documents and their files through the existing storage deletion path. Clone creates a new test activity and copies configuration only, never runtime submissions, scores, ballots, or generated documents.

### 3. Lock overlay, voting, and uniqueness

Activity locking is a global overlay:

```
effective_locked(object) = activity.is_locked OR object.is_locked
```

Locking or unlocking an activity changes only the activity row and audit trail. It never updates `ContestRound` or `VoteSession` child flags. All mutation services/views use the effective-lock helpers.

`submit_ballot()` validates input before the transaction, then locks the current `VoteSession` row and rechecks `is_open`, `is_locked`, activity lock state, and the time window inside the transaction. Only after those checks does it create the ballot and records. The existing unique constraint remains the final idempotency/concurrency guard; a duplicate browser submission returns the already-created ballot without creating records.

Add database constraints on `SingerRegistration` for `(activity, user)` and `(activity, student_id)`. Application flows translate integrity failures into a user-facing validation error without leaking database details. Existing duplicate rows must be detected by a migration/data check before constraints are applied; the implementation will fail safely rather than deleting or choosing a winner automatically.

The participant submission page receives an explicit `activity_id` when there is more than one registration, scopes the query to that activity, and does not fall back to a cross-activity `last()` query.

## Interfaces and Error Contracts

- `prepare_round(contest_round, operator) -> ContestRound` is the only normal entry point for creating round snapshots.
- `_eligible_singers()` and `_active_judges()` become snapshot-backed query helpers; callers do not query global registration/judge state for an existing round.
- `ensure_round_unlocked()` checks both the activity overlay and round lifecycle.
- Attempting to score an unprepared round, modify a frozen snapshot, submit after a locked vote, re-enter formal activity test mode, or create a duplicate registration raises the existing Django validation/permission class used by that flow, with a stable Chinese message.
- Transaction boundaries protect state transitions, snapshot creation, score writes, ballot writes, and test-data cleanup.

## Security and Data Integrity

- All state-changing staff endpoints remain POST-only and CSRF-protected.
- Activity ownership checks remain mandatory before creating or mutating related objects.
- Snapshot services use row locks and same-activity validation; no client-supplied IDs can expand the roster or judge panel.
- Private generated files continue to be served through controlled media access; archive and cleanup paths never trust a client-provided file path.
- Formal data is never deleted or relabeled as test data by a test cleanup operation.

## Verification Plan

Unit and Django tests will cover:

1. Twenty approved preliminary singers produce exactly ten entries in the next round when ten summaries advance.
2. Preparing a round freezes its judge panel against later global judge changes.
3. Changing registration status after preparation/lock does not change the round roster or result.
4. An inactive global judge's old score is excluded unless that judge belongs to the round snapshot.
5. Formal activity re-entry into test mode is rejected; cloning creates an isolated test activity.
6. Test generated documents are removed by cleanup and excluded from formal archive packages.
7. Activity unlock does not alter a locked child round or vote session.
8. Vote submission rechecks state after row locking and rejects a session locked before the write.
9. PostgreSQL `TransactionTestCase` verifies same-browser concurrent submission creates exactly one ballot.
10. Duplicate activity/user and activity/student registrations are rejected by the database and surfaced safely.

The implementation will run the repository's required Django checks, migration check, full test suite, lint/type checks, CSS/docs checks where applicable, and PostgreSQL acceptance/concurrency verification before integration.

## Non-Goals

- No guessed tie-breaking or drop-high-low policy changes.
- No load-test threshold or performance redesign of the single-session ballot lock in this change; the true PostgreSQL concurrency regression test is required, while sustained load testing remains a follow-up.
- No broad rewrite of the staff panel or unrelated export architecture.
