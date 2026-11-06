# ADR-0026: Vote results are a publishing source

- **Status**: accepted
- **Date**: 2026-10-27

## Context

`publishing` depended statically on `competition` and its confirm command read
only a podium candidate. A pure audience vote had an authoritative closed tally
but no way to become a published result.

## Decision

- `publishing` no longer depends on `competition`. Its compiler requires at
  least one result source (`competition` or `voting`) in the composition.
- A dedicated `publishing.vote_result.confirm` command freezes a closed vote
  session's tally into `stage_result`; the existing release/revoke/unlock/public
  read path is reused unchanged.
- A preview query returns the ranked decisions, raw counts, session revision,
  and a tally fingerprint. Confirm requires the same revision and fingerprint,
  so ticket revocations after the preview fail closed.
- Ranking: count descending, ordinal ascending; equal counts share a rank
  (`1,1,3`). The public score is the vote share percent, carried by
  `ResultDecision.unit = "percent"`.
- The new `vote-poll` pack is the pure-vote shape: voting + publishing (+
  optional archive), no competition or registration.

## Consequences

- The podium path and its tests are unchanged except for an explicit
  `CAPABILITY_NOT_ENABLED` guard.
- v2 still has no voting UI; operators create/close sessions through the API.
- A closed session's tally can change if tickets are revoked afterwards; the
  fingerprint is the only guard and the preview must be the source of truth for
  the confirm input.
