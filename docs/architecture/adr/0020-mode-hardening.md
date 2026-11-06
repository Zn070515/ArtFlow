# ADR-0020: Execution-mode isolation for score, vote, and ranking facts

- **Status**: accepted
- **Date**: 2026-10-26

## Decision

Execution mode (`test` / `rehearsal` / `formal`) becomes a column on the facts
that decide outcomes: `score_fact.mode`, `vote_session.mode`, and
`ranking_snapshot.mode`. Every write derives the mode from the running
execution session; every competitive read filters by mode. The partial unique
index for current score facts becomes `(round_id, contestant_id, judge_id,
mode)`, so a rehearsal score never blocks the formal score for the same judge
and contestant. New score fact ids include the mode.

`resolveRound` stores a ranking per mode; test, rehearsal, and formal runs can
all produce rankings. Podium candidates, advancement decisions, tie decisions,
and publishing remain formal-only (`FORMAL_MODE_REQUIRED`). The Live console and
the judge context read the running session's mode, defaulting to formal.

Round, panel, and performance lifecycle state is **not** mode-scoped. Therefore
a non-formal session may open, lock, and resolve a round only while the round
has no formal score fact; otherwise the command fails with
`FORMAL_FACTS_EXIST`. A staff `reset-rehearsal` command clears a round's
non-formal score facts, corrections, revisions, rankings, performances, and
score states, supersedes its panel, and returns the round to `prepared` so the
formal run starts clean. It refuses when any formal fact exists. Judge entry
seats are left claimed; the next panel activation recycles them by seat key.

Registrations and materials are always formal data. Test and rehearsal entries
used for automated validation belong to isolated fixture activities; a real
activity is never used as a rehearsal prerequisite. The v1 `is_test_data` import
policy is a separate cutover decision.

## Alternatives rejected

- Binding facts to `execution_session_id`: more provenance, but it would change
  uniqueness, current-fact semantics, and recovery after a closed session.
- Cloning rounds, panels, and performances per mode: full isolation, but it
  doubles the Live and resolution lifecycle for a rehearsal-only need.
- Adding mode to registrations and materials: there is no execution session for
  registration; an activity-level test flag would be a larger product change.
- Letting the round's lifecycle be mode-agnostic without a guard: a rehearsal
  could lock the formal round or retire its scores.

## Consequences

- Automated test/rehearsal modes remain available for isolated fixture
  activities; they must not be used to rehearse a real activity.
- `round.scoreVersion` remains shared; the guard and reset keep rehearsal data
  out of the formal version history in the supported flows.
- Existing facts backfill to `formal`.
- Direct, rapid, proxy, and paper scores all carry the session mode; corrections
  require the correcting session to match the fact's mode.
- A rehearsal ranking is visible in Live but can never become a podium
  candidate or published result.
