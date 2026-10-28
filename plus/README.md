# ArtFlow-Plus

This directory is the v2 workspace. The Django application at the repository
root is the frozen v1 reference implementation; nothing here imports it.

## Current state

M0–M15.1 are complete. The workspace covers the full activity journey —
registration → evaluation → voting → publishing → archive — plus grouping, the
public vote page, and one protected realtime core. Production still runs v1 on
`main`; the cutover code and runbooks are ready, but the domain has not been
switched. Milestone exits and evidence live in
`docs/artflow-plus/roadmap.md`.

M15.1 adds a read-only activity operations analytics projection at
`GET /api/activities/:id/operations/analytics`. It aggregates existing
registration, materials, roster, competition, voting, publishing, and archive
facts for the Ops detail view. It has a dedicated read surface, reuses the
redeemed-ticket validity rule, and never becomes a second authority or returns
row-level participant/judge credentials. The next slices are tasks/checklists,
check-in/attendance, schedule/program release, and incident/recovery.

The Live console and the voting card share the single WebSocket core in
`packages/realtime`. Sockets only invalidate queries; HTTP remains the recovery
authority. Two topics exist: `voting:<activityId>` and
`activity:<activityId>`.

An authority-closure pass (ADR-0030) froze command→scope ownership in each
release, added result source provenance and consumption/stale handling, declared
a read-surface level for every GET route at boot, and stopped returning bearer
tokens from the browser login/register responses. Releases and confirmed results
created before that pass must be re-released or reconfirmed because the new
guards fail closed.

ADR-0031 splits `import:legacy` into a read-only `historical` mode and an
`adoption` mode that compiles and releases a real Plus definition for a current
v1 activity. Consumption is now source-aware (a confirmed result only locks the
rounds/vote sessions it actually consumed), the public selector requires a
confirmed, non-stale, provenance-bearing result, and runtime contract v2 refuses
sessions on releases without command ownership.

ADR-0032 makes adoption a semantic conversion: the definition is generated from
the bundle (questionnaire, round keys and judge counts, rubric, grouping, material
slots, registration lifecycle), adopted rounds use the resolver's canonical IDs,
registration has its own lifecycle, and material bytes are served through a
controlled local volume plus a read-only v1 media bridge. `semanticReady` is true
only after questionnaire/round/rubric/grouping/material/lifecycle checks pass.

ADR-0033 closes participant and material cutover: the bundle carries
`materialChecks` even when no file exists, adoption creates real file slots, staff
can issue a scoped supplement capability without migrating a v1 account, and
material bytes upload atomically (the old current survives a failed replacement).
Production compose now mounts `plus_media_data` and the v1 `media_data` read-only,
and media paths accept Unicode filenames.

ADR-0035 closes the imported-participant account gap without rewriting imported
IDs or migrating passwords. Staff issue a one-time `/claim#...` fragment for an
adopted `legacy-user:*` registration; issuing a replacement revokes the prior
unconsumed claim. The participant creates a new account or binds an existing
participant session, and the registration/material ownership checks resolve the
linked legacy identity. The Claim page also accepts a manually pasted token,
and Ops copy falls back to selection-based copying when Clipboard API access is
unavailable. The fragment is removed from the address bar immediately; raw
claim/session credentials stay out of durable responses and audit records. This
does not authorize deleting v1 source or media.

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

The default registry exposes every implemented capability (`registration`,
`questionnaire`, `materials`, `competition`, `voting`, `ticketing`,
`publishing`, `archive`, and `grouping`). A Pack that references an unknown
capability fails with `CAPABILITY_UNKNOWN` diagnostics rather than producing
placeholders.

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
GET  /api/activities/:id/execution-state     projection + stale watermark
WS   /api/realtime                           invalidation-only notifications
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
│   ├── api/          # Fastify composition root, HTTP contracts, /api/realtime
│   ├── web/          # React 19 surfaces and the public vote page
│   └── worker/       # outbox relay + pg-boss scheduling
├── packages/
│   ├── domain/       # engine kernel, registry, packs, compilers, projections
│   ├── runtime/      # durable command service, repositories orchestration, relay
│   ├── db/           # Kysely schema access and module-owned migrations
│   ├── contracts/    # TypeBox/JSON Schema contracts
│   └── realtime/     # protected WebSocket core (see realtime/CORE.md)
└── README.md
```

Planned but not created yet: `packages/ui`.

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

## Next steps

1. Cutover infrastructure is ready for automated and isolated acceptance, but
   production cutover must be driven by an `import:legacy --mode adoption --pack
   <id>` of the first current activity followed by the operational smoke profile;
   it remains gated by clean-baseline evidence, activity-specific capability
   completeness, and the authority audit, not by a real-activity rehearsal or
   the calendar. Follow `docs/artflow-plus/cutover-runbook.md`.
2. Close the remaining product gaps: a public program page for stage shows,
   bracket/composite scoring, XLSX export, on-site display, and multi-instance
   realtime broadcast.
3. Split the frontend into the public Portal shell and the operations Console
   shell before the next UX round; the fixed direction, desktop layout and
   acceptance gates are in `docs/artflow-plus/frontend-design-direction.md`.
4. Close the M7→M13.3 high review findings (production relay, proxy rate limits,
   body ceilings, adopted-archive keys, historical read-only, post-confirmation
   score correction, and the P2 items) listed in
   `docs/artflow-plus/reviews/2026-10-27-m7-m13-high-review.md`.

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
notes, or editorial fields. Development/E2E uses a swept in-memory limiter;
production `main.ts` wires `PostgresRateLimiter` to the shared
`rate_limit_bucket` table. If production starts without an explicit shared
limiter, the API fails closed.

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

## M8a web shell and public portal

`apps/web` is the v2 product shell (React 19 + Vite 8 + TanStack Router/Query).
The first surface is the anonymous public results page with the Afterglow shader
hero.

```powershell
pnpm -C plus --filter @artflow-plus/web dev       # Vite on 5173, proxies /api to 3000
pnpm -C plus --filter @artflow-plus/web build     # static dist/
pnpm -C plus --filter @artflow-plus/web test      # Vitest + RTL
$env:ARTFLOW_PLUS_DATABASE_URL = "postgresql://artflow:artflow_dev@127.0.0.1:5433/artflow_plus"
pnpm -C plus --filter @artflow-plus/web test:e2e # Playwright, own API/web servers + artflow_e2e schema
# If the bundled Chromium is not installed locally, use Edge:
# $env:PLAYWRIGHT_CHANNEL = "msedge"
```

`VITE_API_TARGET` overrides the dev/preview proxy target. The WebGL scene is a
lazy chunk; `prefers-reduced-motion` uses a static backdrop and never creates a
WebGL context.

## M8b registration loop

Cookie auth uses HttpOnly `artflow_session` + readable `artflow_csrf`; mutations
send `x-csrf-token`. Web and API must be same-origin behind the proxy.

```text
POST /api/auth/login
POST /api/auth/register
GET  /api/auth/me
POST /api/auth/logout
GET  /api/public/activities/:publicCode
GET  /api/activities
GET  /api/activities/:id/registrations/mine
GET  /api/activities/:id/registrations/:registrationId
GET  /api/activities/:id/registrations
GET  /api/activities/:id/roster
```

Participant flow: public code → start/resume registration → frozen questionnaire
→ save/submit. Ops flow: activity list → registration detail → approve/request
supplement/reject → finalize roster.

Materials are **metadata only** in this slice: the browser sends original name,
content type, and size; no bytes are stored or served. The UI labels this
explicitly. Production needs `ARTFLOW_PLUS_CREDENTIAL_SECRET` for session-bound
CSRF.

## M8c Studio

Studio requires the `studio.manage` permission. Activity creation, activation,
definition compile/release, and execution session start/close now authenticate
the request actor and enforce that permission.

```text
GET  /api/activities/:id/studio
POST /api/activities
POST /api/activities/:id/activate
POST /api/activities/:id/definitions/compile
POST /api/activities/:id/definitions/release
POST /api/activities/:id/executions
POST /api/activities/:id/executions/:sessionId/close
```

The web flow is Guided Pack creation plus an Expert JSON editor for the current
draft package; compile diagnostics come from the capability compilers. Release
freezes the definition; sessions use the active release's declared scopes.
`GET /api/activities` also accepts `studio.manage` for the Studio activity list.

## M8d Live console and judge entry

The Live console needs `competition.manage` or `judge.manage`; opening the
judging session additionally accepts those permissions instead of
`studio.manage`. The activity must enable `ticketing` to hand out judge links.

```text
GET  /api/activities/:id/live
GET  /api/judge/context
POST /api/activities/:id/executions                  # scope=judging
POST /api/activities/:id/competition/rounds          # prepare a configured round
POST /api/activities/:id/competition/rounds/:key/panel
POST /api/activities/:id/competition/rounds/:key/performances/:performanceId/open
POST /api/activities/:id/competition/rounds/:key/performances/:performanceId/lock
POST /api/activities/:id/competition/rounds/:key/lock
POST /api/activities/:id/competition/rounds/:key/resolve
POST /api/activities/:id/judge-entry/reissue         # signed capability
POST /api/judge-entry/claim                          # HttpOnly judge session
```

Staff start a `judging` session, prepare rounds, activate the panel, open a
performance from the final roster, and generate `/judge/<publicCode>?capability=…`.
The judge claims an entry seat, polls `/api/judge/context`, and submits three
rubric scores as `direct_judge`. Staff then lock the performance, lock the round,
and resolve the ranking. The Live page subscribes to `activity:<id>` through
`@artflow-plus/realtime`; messages only invalidate queries, and when the socket
fails the page polls every 5 seconds. `/events` + `/execution-state` remain the
authoritative recovery path and require an operations session
(`studio.manage`, `competition.manage`, or `judge.manage`): their payloads
contain judging and registration details.

`apps/api/scripts/seed-live.ts` seeds `E2E-LIVE-*` (competition + ticketing,
approved `singer-a`, final roster) and writes `.e2e-live.json` for the Playwright
spec.

## M8e-1 Mode hardening

Execution mode now belongs to the facts that decide outcomes:

```text
score_fact.mode          partial unique → (round, contestant, judge, mode) where current
vote_session.mode        derived from the running execution session at open
ranking_snapshot.mode    one current ranking per round and mode
```

Writes derive the mode from the running session; reads filter by it. Rehearsal
scores do not block formal scores, and a rehearsal ranking can never become a
podium candidate, advancement decision, or published result
(`FORMAL_MODE_REQUIRED`). `GET .../ranking` accepts an optional `mode` query
(default `formal`); write commands never accept a mode.

Round/panel/performance state is shared, so a non-formal session may not
open/lock/resolve a round that already has a formal score fact
(`FORMAL_FACTS_EXIST`). Rehearse before the formal run, then clear it:

```text
POST /api/activities/:id/competition/rounds/:roundKey/reset-rehearsal
     body: { scope: "judging", mode: "test" | "rehearsal" }
```

The reset deletes the round's non-formal facts/corrections/revisions/rankings
and performances, supersedes its panel, and returns the round to `prepared`.
After formal facts exist, rehearse in a copied activity instead.

## M8e-2 Legacy import

v1 activities move through a versioned JSON bundle:

```powershell
# v1 repository
uv run python manage.py export_plus_bundle --activity <public_code> --output bundle.json

# v2 repository
$env:ARTFLOW_PLUS_DATABASE_URL = "postgresql://artflow:artflow_dev@127.0.0.1:5433/artflow_plus"
pnpm -C plus --filter @artflow-plus/api import:legacy -- bundle.json --dry-run
pnpm -C plus --filter @artflow-plus/api import:legacy -- bundle.json --report report.json
```

The importer runs in one transaction, skips `is_test_data` rows, keeps materials
as metadata (`storage_key = legacy:<id>`), imports historical ballots as
anonymous, and writes published results from the frozen snapshot. It then
recomputes counts and snapshot hashes from v2 and rolls back on any mismatch.
Group-chorus stages and other constructs v2 cannot express are listed in the
report's `unsupported` array; their facts stay in v1.

## M8e-3 Cutover

Plus ships two production images from `deploy/plus/Dockerfile`: `api` (esbuild
single-file Node bundle) and `web` (nginx + Vite build). The API bundle is
required because workspace packages export TypeScript sources; `tsc` output
cannot be loaded at runtime.

```powershell
pnpm -C plus run build:prod
docker build -f deploy/plus/Dockerfile --target api -t artflow-plus-api .
docker build -f deploy/plus/Dockerfile --target web -t artflow-plus-web .
```

The v2 services run beside v1 as a Compose profile:

```powershell
docker compose -f deploy/compose.production.yml --env-file .env.production --profile plus up -d
```

The main domain is switched by Caddy site profile, not by path or activity
routing:

```dotenv
# .env.production
ARTFLOW_SITE_PROFILE=v1   # before cutover, and the rollback target
ARTFLOW_SITE_PROFILE=v2   # after the switch
```

```powershell
docker compose -f deploy/compose.production.yml --env-file .env.production up -d proxy
node scripts/cutover-smoke.mjs
```

Rollback is allowed only before the first authoritative v2 write. See
`docs/artflow-plus/cutover-runbook.md` for the full preflight, commit point,
and post-cutover checklist.

## M8e-4 Three activity shapes

Guided packs now carry default capability definitions, and `/api/packs` exposes
three shapes:

| Pack | Composition | Runnable default |
| --- | --- | --- |
| `singer-competition` | competition, registration, questionnaire, materials, publishing, archive | final round (3 judges / minimum 2 / average) + three-criterion rubric |
| `stage-show` | registration, questionnaire, materials, archive | program questionnaire + work-file slot |
| `review-awards` | competition, publishing, archive, registration, questionnaire, materials | review round + theme/completion/expression rubric |

A pack's `definitions` replace the capability's `emptyDefinition()` but still go
through the normal compilers and create/compile/release commands. The three
shapes share rounds, panels, performances, score facts, publishing, and archive;
no shape-specific kernel code exists.

```powershell
pnpm -C plus --filter @artflow-plus/domain test
$env:ARTFLOW_PLUS_DATABASE_URL = "postgresql://artflow:artflow_dev@127.0.0.1:5433/artflow_plus"
pnpm -C plus --filter @artflow-plus/api exec vitest run test/activity-shapes.test.ts
```

Known gaps (documented in `docs/artflow-plus/shape-validation.md`): no public
program page for stage shows, no bracket/composite scoring, no XLSX export,
on-site display, or multi-instance realtime broadcast. Participant account
claim is delivered by M14.1; ticket-backed voting entry is delivered by M14.

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

## M9–M13 feature slices

Grouping (M9) is a standalone capability over registration and competition:

```text
GET   /api/activities/:id/grouping
POST  /api/activities/:id/grouping/stages
PATCH /api/activities/:id/grouping/stages/:stageId/groups
POST  /api/activities/:id/grouping/stages/:stageId/confirm
POST  /api/activities/:id/grouping/stages/:stageId/freeze
POST  /api/activities/:id/grouping/stages/:stageId/correct
POST  /api/activities/:id/grouping/stages/:stageId/cancel
PATCH /api/activities/:id/grouping/stages/:stageId/window
```

Stages move `draft → confirmed → frozen` (or `cancelled`). Membership history is
append-only, the roster source is fingerprinted, and an unfrozen stage blocks
archival. See `docs/domains/grouping.md` and GRP-01…09.

Vote-result publishing (M10) decouples `publishing` from `competition`, so a
`vote-poll` activity can confirm a closed vote session and publish its tally:

```text
GET  /api/activities/:id/publishing/vote-results/:sessionId
POST /api/activities/:id/publishing/stage-results/:stageKey/confirm-vote
```

The participant vote page (M12) is public and anonymous by default:

```text
GET /api/public/vote/:sessionId     # formal sessions only; no counts or identities
GET /vote/<sessionId>               # web route; ticket sessions use fragment/HttpOnly exchange
```

Realtime (M11, M13) is one protected WebSocket core:

```text
WS /api/realtime
```

`packages/realtime` owns the protocol, the Fastify plugin, and the browser
client; feature code only registers a `RealtimeTopic`. Topics are
`voting:<activityId>` (aggregate vote read) and `activity:<activityId>`
(outbox-head invalidation). The Live console and the voting card both fall back
to polling when the socket fails. `GATE-REALTIME-CORE-01` enforces the transport
monopoly; the contract is in `packages/realtime/CORE.md`.
