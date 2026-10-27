# ADR-0032: Semantic adoption closure

- Status: accepted
- Date: 2026-10-27
- Supersedes: none; completes ADR-0031

## Context

ADR-0031 split historical import from operational adoption, but adoption still
used the selected Pack's default definitions while copying v1 facts. The result
had two authorities for the same activity:

- the imported questionnaire hash did not exist in the adopted release, so
  registration detail failed with `VERSION_NOT_RELEASED`;
- imported rounds kept `round-21` keys while the release described `final`, so
  Live could not find them;
- imported round configuration (1 judge, 总分 rubric) differed from the Pack
  default (3 judges, three criteria), splitting round authority from scoring;
- imported round IDs were not the resolver's canonical IDs, so podium stayed HOLD;
- grouping group counts could contradict the release;
- adoption reopened registration because `registrationOpen` only checked
  `Activity.status`;
- material bytes were never migrated or served.

## Decision

### Adoption builds the definition from the bundle

`buildAdoptionDefinition` starts from the Pack composition, then replaces the
capability definitions with the bundle's facts:

| Capability | Source |
| --- | --- |
| questionnaire | legacy question keys/labels/types/required |
| competition | legacy round keys, judge counts, completion, scoring method, rubric, tie policy |
| grouping | legacy single-stage group count (multiple stages leave it unconstrained with a warning) |
| registration | lifecycle derived from the v1 phase (`final` when the roster is final, `review` when registrations exist, otherwise `open`) |
| materials | purposes derived from imported content types |
| publishing | `final_podium` when competition is enabled, `vote_result` when voting is enabled |

Compilation and release still go through the normal compilers and
`releaseDefinition`.

### Canonical round identity

Adopted rounds use `idFromCommand("round", "<activityId>:<roundKey>")`, exactly
the ID the resolver derives from the release. Historical import keeps its own
snapshot IDs because it never executes commands.

### Registration has its own lifecycle

`registration` definitions and artifacts carry `lifecycle`
(`draft/open/review/final`). `registration.start`, answer, submit, and the public
`registrationOpen` selector require `open`; `Activity.status` no longer reopens a
closed registration. Releases written before the field default to `open`.

### Adoption readiness is semantic

Adoption checks questionnaire keys, round keys, judge configuration, rubric hash,
group count, material question slots, registration lifecycle, and publishing
stages. `rehearsalReady` is true only when those checks pass and the unsupported
list contains no blocking kind (`multiple_rubrics`, `group_material`).
Other unsupported kinds are reported as warnings that stay in v1.

The acceptance journey runs a real exporter-shaped fixture through adoption,
registration detail, full judging, score, lock, ranking, podium, confirm,
release, the public selector, and opening a vote session.

### Media bridge

- The v1 exporter records each material's relative media path.
- Adoption/historical import stores `legacy-file:<relative-path>`; a configured
  read-only `ARTFLOW_PLUS_LEGACY_MEDIA_DIR` serves those bytes through the
  controlled material content route.
- New uploads register metadata through `materials.upload`, then send bytes to
  `PUT /materials/:id/content`; bytes live under `ARTFLOW_PLUS_MEDIA_DIR` and are
  served only by `GET /materials/:id/content` after ownership/permission checks.
- `legacy:<id>` without a path remains metadata-only and fails closed with
  `MATERIAL_CONTENT_UNAVAILABLE`.

### Grouping dependencies and public snapshot identity

Result sources also carry typed `dependencyRefs` (`round:`, `voteSession:`,
`groupingStage:`). Grouping corrections are blocked only when a confirmed result
declares a dependency on that stage, not by participant overlap. The public
selector filters by stage before choosing the response snapshot, so a request
cannot receive one stage's results with another stage's activity title.

## Consequences

- Adoption is now a semantic conversion; a pack that cannot own the bundle facts
  is rejected (`LEGACY_BUNDLE_INVALID`).
- Existing adopted activities must be re-adopted after this change; their release
  does not carry the bundle-derived definitions or canonical round IDs.
- Registration is closed after adoption; supplements must use a future explicit
  supplement seam rather than reopening registration.
- Production cutover remains NO-GO until an adoption rehearsal and the
  operational smoke pass on the real v1 export.

## Verification

- `legacy-adoption.test.ts` uses the real exporter shape (`round-21`) and runs the
  full journey to a public result.
- Tests cover incompatible packs, closed registration, material storage and
  legacy traversal protection.
- Smoke checks `commandScopes` in the active release.
