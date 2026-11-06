# ADR-0014: Publishing owns confirmation and release

- **Status**: accepted
- **Date**: 2026-10-26

## Decision

The `publishing` capability owns stage-result confirmation, unlock, the editorial
publication container, result releases, revocation, supersession, and the single
public results selector. `competition` keeps podium candidates as an upstream
read model; it does not own public result facts.

`unlock_stage_result` must write `StageResultUnlocked` and
`ResultReleaseSuperseded` in one transaction. Splitting confirmation and release
into two capabilities would require cross-capability immediate consistency, so
M7a deliberately keeps both under one owner.

The runtime reads the latest podium candidate inside the Activity-locked
transaction and passes its decisions to publishing. The HTTP client never
supplies ranking data; it supplies only the stage key and the expected source
revision/fingerprint.

## Alternatives rejected

- Extending `competition` with public release fields would mix internal
  evaluation with public facts and enlarge the competition surface.
- A separate `results` capability plus `publishing` would make the golden
  fixture's atomic unlock/supersede impossible without a new saga mechanism.
- Accepting decisions from the request body would let a caller forge the
  confirmed ranking.
