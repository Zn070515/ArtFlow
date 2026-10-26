# ArtFlow-Plus

This directory is the v2 workspace. The Django application at the repository
root is the frozen v1 reference implementation; nothing here imports it.

## First vertical slice

`packages/domain` implements the GOAL's kernel shape:

```text
Activity (thin: draft → active → closed → archived)
  → ActivityDefinitionPackage draft
      manifest + per-capability definitions + bindings
  → each capability compiler + the Activity compiler
  → immutable Definition Release
  → ExecutionSession (scope + mode; several scopes may run at once)
```

It is deliberately small and pure:

- commands are functions with explicit inputs;
- every authority artifact is deep-frozen;
- OCC is a monotonic revision carried by the command, and a stale revision is
  refused with `STALE_REVISION`;
- a draft is the only editable definition surface;
- release requires a compiled package whose content hash matches the draft and
  whose capabilities are enabled on the activity;
- an execution session binds a released definition, never a draft;
- multiple scopes may run at once; the scope conflict policy is supplied by the
  capability composition, and FORMAL cannot overlap TEST/REHEARSAL in a
  conflicting scope.

The rules come from the root `GOAL.md`, `docs/invariants/` (LIFE-01/02,
CONC-01, AUTH-01) and the golden fixtures in `tests/golden/`.

## Run

From the repository root (Node 24.22.0 is pinned in `.node-version`):

```powershell
pnpm -C plus install --frozen-lockfile
pnpm -C plus run check   # tsc --noEmit
pnpm -C plus run test    # Vitest + fast-check
```

The DB-backed tests (db, runtime, API) run when a database is reachable and are
skipped otherwise. Against the local Docker database:

```powershell
$env:ARTFLOW_PLUS_DATABASE_URL = "postgresql://artflow:artflow_dev@127.0.0.1:5433/artflow_plus"
pnpm -C plus run test
```

Set `$env:REQUIRE_DB = "1"` to turn a missing/unreachable database into a
failure instead of a skip; CI always sets it.

Start the API and the relay worker (two processes, same image in deployment):

```powershell
$env:ARTFLOW_PLUS_DATABASE_URL = "postgresql://artflow:artflow_dev@127.0.0.1:5433/artflow_plus"
pnpm -C plus --filter @artflow-plus/api start     # Fastify on 127.0.0.1:3000
pnpm -C plus --filter @artflow-plus/worker start  # outbox relay + pg-boss backstop
```

Local start uses `tsx` so workspace packages resolve TypeScript sources directly;
production packaging is part of the M8 deployment slice.

The root `check:plus` / `test:plus` scripts delegate to the same pnpm commands.
The Gates workflow runs both on every `artflow-plus` push/PR and supplies the
same variable from its PostgreSQL service.

## Capability composition (M2)

`packages/domain/src/registry.ts` is the capability registry:
identity/version/dependencies/conflicts/definition contract/commands/queries/
events/permissions/surfaces. `packs.ts` turns an opinionated composition plus
Guided Mode answers into one compilable Definition Package.

```text
CapabilityRegistry.validateComposition({ enable, disable })
  → dependency closure, conflict diagnostics, merged scope-conflict policy

instantiateActivityPack(SINGER_COMPETITION_PACK, registry, { answers })
  → enabled capabilities + compilable empty definition
```

The default registry exposes the capabilities implemented today
(`competition`, `materials`, `questionnaire`, `registration`, `ticketing`, and
`voting`). A Pack that
references a capability scheduled for M5-M7 still fails with
`CAPABILITY_UNKNOWN` diagnostics rather than producing placeholders.

## Execution runtime (M3)

Every write goes through one durable command path: receipt claim → Activity
lock → domain command → fact + outbox in the same transaction. A retry with the
same `Idempotency-Key` replays the original response; the same key with a
different payload is `COMMAND_ID_CONFLICT`. Definition drafts, compiled plans,
releases and execution sessions are persisted.

```text
POST /api/activities/:id/executions          start a scoped session
POST /api/activities/:id/executions/:sid/close
GET  /api/activities/:id/executions          authoritative read
GET  /api/activities/:id/events?after=       cursor recovery (authoritative)
GET  /api/activities/:id/stream              SSE (enhancement only)
GET  /api/activities/:id/execution-state     projection + stale watermark
```

Every release freezes its execution semantics: capability versions, declared
scopes, merged scope conflicts and the runtime contract version. Starting a
session reads that snapshot; the current registry may only confirm that a
compatible implementation exists.

The outbox is the event log. `apps/worker` applies it per
`(activity_id, mode)` partition: an advisory transaction lock serializes a
partition, the projection update is a `last_sequence` CAS, and a permanently
failing event sets the partition to `blocked` instead of letting later events
overtake it. Operators can retry the blocked event or rebuild the projection
from the log. pg-boss only schedules the relay as a backstop; the outbox remains
the source of truth. Formal, rehearsal and test events and projections never mix.

Every accepted command writes an `audit_entry` with the injected `ActorContext`
in the same transaction as the receipt and the outbox event. M3 engine routes
retain the explicit system-actor compatibility path; M4 capability writes use
local bearer sessions (`POST /api/auth/login`) and never read actor identity from
the request body. `/readyz` checks PostgreSQL and the required migrations;
`/healthz` only reports process liveness.

M4 registration/material routes are authoritative HTTP commands:

```text
POST  /api/activities/:id/registrations
PATCH /api/activities/:id/registrations/:registrationId
POST  /api/activities/:id/registrations/:registrationId/submit
POST  /api/activities/:id/registrations/:registrationId/review
POST  /api/activities/:id/roster/finalize
POST  /api/activities/:id/registrations/:registrationId/materials
GET   /api/activities/:id/materials/:materialId
POST  /api/activities/:id/competition/rounds/:roundKey/prepare
POST  /api/activities/:id/competition/rounds/:roundKey/panel
POST  /api/activities/:id/competition/rounds/:roundKey/performances/:performanceId/open
POST  /api/activities/:id/competition/rounds/:roundKey/performances/:performanceId/lock
POST  /api/activities/:id/competition/rounds/:roundKey/lock
POST  /api/activities/:id/competition/rounds/:roundKey/scores
PATCH /api/activities/:id/competition/rounds/:roundKey/scores/:scoreFactId
POST  /api/activities/:id/competition/rounds/:roundKey/scores/:scoreFactId/corrections
POST  /api/activities/:id/competition/rounds/:roundKey/scores/:scoreFactId/corrections/:correctionId/close
POST  /api/activities/:id/competition/rounds/:roundKey/scores/:scoreFactId/corrections/:correctionId/recalculate
POST  /api/activities/:id/competition/rounds/:roundKey/resolve
POST  /api/activities/:id/competition/rounds/:roundKey/advancement/finalize
POST  /api/activities/:id/competition/rounds/:roundKey/ties/:tieId/decide
POST  /api/activities/:id/competition/podium/recompute
```

Questionnaire and material slots are read from the active released definition.
Material writes currently record controlled metadata, ownership, and review facts;
the actual media-byte backend and range gateway are a later slice. Material reads
are owner/staff-permission checked; no public or static media URL is produced. The `registration`, `roster`,
and `material` tables are current-state projections while the outbox remains the
immutable event log.

M5 Competition / Evaluation / Podium is now implemented as an authoritative
capability slice:

```text
prepare round → activate panel → open performance → score fact(s)
  → lock performance/round → resolve ranking → decide ties/advancement
  → produce podium candidate
```

Round, panel, seat, performance, score fact, revision, correction, ranking,
advancement, tie-decision, and podium-candidate tables are covered by migrations
`0006_competition_evaluation` through `0009_m5_context_and_podium_metadata`. All
scoring sources share the `(round, contestant, judge)` current-fact uniqueness
constraint. Advancing a performance context retires only the old current score
facts; their immutable history remains, and a gate/resolver can consume only
facts bound to the current panel and exact performance context. Opening a
performance also requires its participant to be in the final approved roster.
`duplicate-score-fact.json` is consumed by
`packages/runtime/test/golden-duplicate-score-fact.test.ts`; the adapter uses real
commands and asserts no-side-effect rejection, immutable edit history, and stale
context refusal. Correction is an audited `open → revise → close → recalculate`
saga; the next round lock and resolver run explicitly consume the new score
version. Unresolved ties remain HOLD, and podium required rounds come from the
frozen competition release rather than the caller's subset. `StageResultCandidateProduced`
records the source round IDs, source score versions, and input fingerprint.
Resolver output is a candidate/read model only; M5 does not confirm Awards or
stage results.

A blocked projection is recovered through the worker's operator CLI (there is no
unauthenticated HTTP route):

```powershell
pnpm -C plus --filter @artflow-plus/worker ops retry   --activity <id> --mode formal
pnpm -C plus --filter @artflow-plus/worker ops rebuild --activity <id> --mode formal
```

## Current layout

```text
plus/
├── apps/
│   ├── api/          # Fastify composition root, HTTP contracts, SSE
│   └── worker/       # outbox relay + pg-boss scheduling
├── packages/
│   ├── domain/       # engine kernel, registry, packs, compilers, projections
│   ├── contracts/    # TypeBox/JSON Schema contracts
│   ├── db/           # Kysely schema access and module-owned migrations
│   └── runtime/      # durable command service, repositories orchestration, relay
└── README.md
```

Planned but not created yet: `apps/web`, `packages/ui`.

Tooling baseline (ADR-0002): Node 24 LTS (`.node-version` 24.22.0), TypeScript 7
strict, pnpm 12.14.0 workspaces, Fastify 5 + TypeBox, Kysely, pg-boss 12,
React 19 + Vite 8, Vitest 5 + fast-check 4, Playwright. `pnpm-lock.yaml` is
committed; `node:test` has been retired.

Capabilities own their facts, commands, events and projections; the engine never
imports a concrete capability module. See
`docs/artflow-plus/skeleton-coverage.md` for how v1's skeleton maps onto this
new architecture.

## Planning baseline

- Product goal: `docs/artflow-plus/goal.md`
- Roadmap: `docs/artflow-plus/roadmap.md`
- Target architecture: `docs/architecture/target/README.md`
- ADRs: `docs/architecture/adr/`
- Invariants: `docs/invariants/`
- Golden fixtures: `tests/golden/`
- Gates: `docs/gates/`

## M4 exit evidence

- PostgreSQL runtime tests cover the released questionnaire snapshot, rejected
  unknown questions, registration review, server-derived roster counts, private
  material ownership, and the fail-closed execution boundary.
- `packages/runtime/test/golden-unknown-roster.test.ts` consumes the shared
  `tests/golden/unknown-roster.json` fixture and proves UNKNOWN is not zero.
- The local-session migration is `0004_local_sessions`; registration/material
  projections are in `0005_registration_materials`.

## Next slice

1. M7b Archive: the permanent archive package, retention, and `archive-identity`.
   M7a publishing/results is complete.

## M7a publishing / results

M7a exposes one authoritative public selector and five staff commands:

```text
POST  /api/activities/:id/publishing/stage-results/:stageKey/confirm
POST  /api/activities/:id/publishing/stage-results/:stageKey/unlock
POST  /api/activities/:id/publishing/releases
POST  /api/activities/:id/publishing/releases/:releaseId/revoke
PATCH /api/activities/:id/publishing/publications/:stageKey
GET   /api/activities/:id/publishing/state
GET   /api/public/results/:publicCode
```

The public selector is anonymous and never returns fingerprints, hashes, actors,
notes, or editorial fields. The in-memory public rate limiter is a single-process
IP bucket; production multi-instance deployments need a shared limiter.

Every stage has at most one ACTIVE release (`result_release_active_key` partial
unique index). Revoke and unlock make the old URL immediately invisible; unlock
supersedes the active release in the same transaction.

## M7b archive

A closed activity can be sealed into a versioned ZIP package:

```text
POST  /api/activities/:id/close
PATCH /api/activities/:id/title
POST  /api/activities/:id/archive
POST  /api/activities/:id/unarchive
GET   /api/activities/:id/archive
GET   /api/activities/:id/archive/file?version=
```

Archive and unarchive require `archive.manage`. The download verifies size and
SHA-256 before streaming and never exposes a static path. Set
`ARTFLOW_PLUS_ARCHIVE_DIR` to a persistent volume; production backups must include
it. The package contains activity identity, publishing releases/stage results,
formal sessions, and an event summary. Registration/material/vote/score detail is
not included until those facts carry a mode column.

## M6 feature slice and M6.5 authority hardening complete

- Migrations `0010_m6_voting_ticketing` and `0011_voting_identity_policy` own frozen vote sessions/options, ballot
  identity constraints, same-activity foreign keys, ticket/access-session digests,
  judge entry versions and rebuildable live state.
- Voting stores an explicit `identityPolicy`; it never accepts client-side identity
  downgrades. Formal counts use one valid-ballot selector and exclude revoked/expired
  ticket ballots. Zero valid ballots is `HOLD/NO_VALID_BALLOTS`.
- Runtime tests cover ticket-backed duplicate rejection through a redeemed
  HttpOnly session, closed-session refusal, cross-activity ticket rejection,
  credential reissue/close semantics, replay rejection, one-time response
  redaction, judge-session-backed scoring, live projection recovery, frozen
  execution-release binding, and PostgreSQL two-connection races for redemption,
  ballots, and judge-seat claims.
- Configure `ARTFLOW_PLUS_CREDENTIAL_SECRET` outside development; production has
  no signing-secret fallback.
