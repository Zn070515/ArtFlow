# ADR-0031: Operational adoption, source-aware consumption, and public fail-closed

- Status: accepted
- Date: 2026-10-27
- Supersedes: none; completes ADR-0030 for the v1 → v2 transition

## Context

ADR-0030 closed the authority gaps for activities created inside Plus. A second
audit found that the v1 → v2 transition itself was not a domain flow:

- `importLegacyBundle` creates a read-only historical snapshot: a frozen release
  with `commandScopes: {}` and only registration/questionnaire/materials/
  competition. Starting a judging session there produced a running session whose
  first business command failed with `COMMAND_SCOPE_UNDECLARED`.
- The adoption composition could not be added afterwards: there is no
  enable/disable capability command and no compiler/release path for imported
  facts.
- Consumption was activity-wide: any confirmed result blocked every score edit,
  ticket rotation/revocation invalidated every vote result, and grouping was
  locked by an unrelated result.
- The public selector trusted `result_release.status = active` even when the
  referenced `stage_result` had no source or was stale.
- `RUNTIME_CONTRACT_VERSION` stayed at 1, so a release without command ownership
  could still start an execution session.

## Decision

### Two explicit import modes

`importLegacyBundle` remains **historical import**: a read-only snapshot of a
past activity and its results. A new `adoptLegacyBundle` performs **operational
adoption**:

1. resolve a target Activity Pack through the normal registry (the pack defines
   the composition and default definitions);
2. compile the package with the normal capability compilers;
3. release it through `releaseDefinition` with the full `commandScopes` map and
   `runtimeContractVersion = 2`;
4. import preparation facts only: registrations, roster, materials, grouping,
   and prepared rounds;
5. reconcile counts and report `semanticReady`.

Historical scores, ballots, and releases stay in v1. Adoption refuses a bundle
that already has an ACTIVE published result; that activity belongs to historical
import. The CLI is `import-legacy <bundle> --mode adoption --pack <id>`.

### Source-aware consumption

`StoredResultSource` carries `dependencyIds`: contributing round IDs for a
podium candidate, the vote session for a vote result, empty for a legacy import.
Consumption then intersects the changed source with the result's dependencies:

- a score edit only blocks results whose podium dependency includes its round;
- ticket revocation only stales results for the vote sessions in which that
  ticket actually cast a ballot;
- revoking an access session does not stale results, because the valid-ballot
  predicate only inspects `ticket.state`;
- rotating an unused (issued) credential cannot affect any ballot and never
  stales a result;
- grouping correction is blocked only when a confirmed result names one of the
  participants whose membership would change.

A source without dependency metadata is treated conservatively (unknown
dependency blocks).

### The public selector is fail-closed on its own

`selectPublicResults` joins the referenced `stage_result` and requires:
`status = confirmed`, `source IS NOT NULL`, and `stale_at IS NULL`, in addition
to an ACTIVE release and a valid snapshot. Even if a write path forgets to
supersede a release, the result cannot remain public.

### Runtime contract v2

`RUNTIME_CONTRACT_VERSION` is 2. A release created under contract 1 (historical
imports) is refused at `startExecution` with `RUNTIME_CONTRACT_MISMATCH` instead
of producing a session that cannot run commands.

## Consequences

- Historical import and operational adoption are now distinct products with
  different guarantees; the runbook must choose the correct mode.
- Adoption must choose a pack and cannot add capabilities later; that record is
  the adopted release.
- Results confirmed before dependency metadata exist fail closed on consumption
  checks until they are unlocked and confirmed again.
- The public results surface may disappear after an upgrade if an old ACTIVE
  release references a result without provenance; re-confirm and re-release.
- Cutover smoke has two profiles: `historical` verifies published history;
  `operational` verifies an active release, composition, and scopes without
  requiring a result that has not happened yet.

## Verification

- Runtime: `legacy-adoption.test.ts` adopts a current bundle, asserts the frozen
  composition/commandScopes, starts a judging session and activates a panel, and
  opens a vote session. Adoption of an already-published bundle is rejected.
- Runtime: source-aware score/grouping/ticket tests cover affected and
  unaffected sources, unused-ticket rotation/revocation, and stale releases.
- DB: the public selector test covers missing provenance and stale sources.
- API/runtime: contract v1 is refused at session start.
- Web E2E, structural gates, and documentation checks stay green.
