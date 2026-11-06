# ADR-0025: Grouping is its own capability

- **Status**: accepted
- **Date**: 2026-10-27

## Context

v1 models the first-round group chorus as `GroupStage` + `Group` +
`GroupMembership`: the grouping comes from an external draw and the stage owns
its roster source, material window, and frozen snapshot. v2 had no equivalent
and the v1 exporter reported it as `unsupported`.

Grouping belongs neither to registration (it happens after registration closes,
sometimes during the live show) nor to competition rounds (a grouping stage can
exist without any competition).

## Decision

- Add a `grouping` capability depending on `registration` and `competition`.
  It contributes only to the Ops surface and declares no execution scope; its
  commands are session-free like registration.
- The aggregate is four-state (`draft` / `confirmed` / `frozen` / `cancelled`)
  and memberships are append-only. A partial unique index on
  `(stage_id, participant_id) WHERE is_current` is the last line of defence.
- Two roster sources: all approved participants (roster must be final) and the
  advancers of a named round (the latest advancement decision must be `auto`).
  Freezing re-resolves the source and compares fingerprints.
- The release's `groupCount` constrains the partition when declared, but group
  sizes stay free. A missing release means no count constraint.
- Consumption protection is activity-level and conservative: a confirmed
  stage result rejects correction and cancellation.
- Grouping writes are allowed while the activity is `active` or `closed`, and
  refused once `archived`. `closed` is not a lock; archived is terminal.
- The material window keeps its three states only. Group material files and the
  supplement-only question restriction belong to the media slice.
- v2 has no `PerformanceGroup`, so there is no second roster that could diverge
  from the grouping. v1's "scoring groups must match the frozen grouping" rule
  disappears structurally.

## Consequences

- Ops exposes exactly three steps (group → confirm → freeze); every strict rule
  stays on the server.
- The v1 exporter emits a `grouping` section only after a v1 hotfix ships.
  Bundles without that section still import, with grouping absent.
- v2 cannot prove from a release which grouping a result consumed, so the
  consumption check is coarser than v1's.
