# ADR-0013: Plus capability ownership and conditional voting composition

- **Status**: accepted
- **Date**: 2026-10-19

## Decision

`Evaluation` remains a business-domain name, not a registered Plus capability.
The `competition` capability owns judge panels, seats, score facts, corrections,
ranking, advancement, and podium candidates. The Singer Pack therefore asks for
`competition` when judges are enabled. A future physical split requires a new
capability identity, release compatibility decision, and migration plan; it is
not introduced by renaming documentation only.

`voting` has no unconditional dependency on `ticketing`. Its frozen definition
contains an explicit `identityPolicy`:

- `ticket` requires the `ticketing` capability and uses redeemed ticket sessions;
- `browser` uses the server-issued browser identity cookie;
- `anonymous` is an explicit, repeatable-identity policy and cannot be selected
  by downgrading another identity at submit time.

`score_component` voting is restricted to `ticket`; `browser` is the default
shape for the empty `popularity` definition and must still be explicitly frozen
in any released definition.

The package compiler invokes capability-owned composition validation, so the
conditional ticketing requirement is checked before a definition can be
released. The release snapshot remains the authority at runtime.

## Alternatives rejected

- Registering a parallel `evaluation` capability now would split the M5 facts and
  release ownership before there is a stable boundary, creating two authorities.
- Keeping `voting` dependent on `ticketing` would make browser-only voting
  impossible and would encode an optional runtime rule as an unconditional graph
  dependency.
