# ADR-0024: Pack default definitions and three validated activity shapes

- **Status**: accepted
- **Date**: 2026-10-26

## Decision

An `ActivityPack` may carry `definitions`: per-capability definitions that
replace the capability's `emptyDefinition()` when the pack is instantiated. The
definitions still go through the normal capability compilers and the same
create/compile/release commands; a pack is composition plus default data, never
a new activity type.

Three shapes are validated end-to-end against the same kernel:

1. `singer-competition` — judged live performances; the pack now supplies a
   runnable final round (3 judges / minimum 2 / average) and a three-criterion
   rubric so a Guided-created activity can actually run.
2. `stage-show` — registration, questionnaire, materials metadata, roster, and
   archive; no competition and no publishing.
3. `review-awards` — submissions judged by a panel, with competition and
   publishing; the pack supplies a review round and rubric.

The differences between the shapes are capability composition and default
definitions. No shape copies round/panel/performance/score/publishing logic.

The gaps are explicit rather than emulated: stage shows have no public program
page, vote-only activities have no publishing path (publishing depends on
competition), brackets/composite scoring have no capability, and imported
participants have no login/claim flow. Each is a separate slice.

## Alternatives rejected

- Hard-coding activity types with their own tables/flow: reintroduces the v1
  module-per-event problem and bypasses the capability boundary.
- One capability per shape: duplicates round/score/publishing logic and makes
  the kernel grow with every event type.
- Packs that only compose empty definitions: Guided creation produces
  competitions with no rounds, so the pack cannot be operated without Expert
  editing. Defaults make Guided output runnable.

## Consequences

- Guided creation produces a compilable, runnable activity for all three packs;
  Expert editing can replace any definition.
- Pack defaults are versioned data; changing a default changes new activities,
  not existing releases.
- The validation report (`docs/artflow-plus/shape-validation.md`) names the
  remaining gaps; none are represented as fake capabilities.
- `GET /api/packs` and Studio's new-activity page list all three packs without
  web changes.
