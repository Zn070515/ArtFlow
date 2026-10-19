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

The PostgreSQL-backed `packages/db` tests run when a database is reachable and
are skipped otherwise. Against the local Docker database:

```powershell
$env:ARTFLOW_PLUS_DATABASE_URL = "postgresql://artflow:artflow_dev@127.0.0.1:5433/artflow_plus"
pnpm -C plus run test
```

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

The default registry exposes only capabilities implemented today
(`competition`). A Pack that references a capability scheduled for M4-M7 fails
with `CAPABILITY_UNKNOWN` diagnostics rather than producing placeholders.

## Current layout

```text
plus/
├── apps/
│   └── api/          # Fastify composition root, HTTP contracts
├── packages/
│   ├── domain/       # engine kernel, capability registry, packs, compilers
│   ├── contracts/    # TypeBox/JSON Schema, command/event/pack contracts
│   └── db/           # Kysely schema access and module-owned migrations
└── README.md
```

Planned but not created yet: `apps/worker`, `apps/web`, `packages/ui`.

Tooling baseline (ADR-0002): Node 24 LTS (`.node-version` 24.22.0), TypeScript 7
strict, pnpm 12.14.0 workspaces, Fastify 5 + TypeBox, Kysely, pg-boss,
React 19 + Vite 8, Vitest 5 + fast-check 4, Playwright. `pnpm-lock.yaml` is
committed; `node:test` has been retired.

Modules stay separate inside `packages/domain` (activity, definition,
registration, evaluation, voting, ticketing, results, archive) and may not
read each other's tables.

## Planning baseline

- Product goal: `docs/artflow-plus/goal.md`
- Roadmap: `docs/artflow-plus/roadmap.md`
- Target architecture: `docs/architecture/target/README.md`
- ADRs: `docs/architecture/adr/`
- Invariants: `docs/invariants/`
- Golden fixtures: `tests/golden/`
- Gates: `docs/gates/`

## Next slices

1. M3 execution runtime: session projections, outbox worker, recovery, realtime
   degradation.
2. M4 Registration / Questionnaire / Materials, reusing `unknown-roster` and the
   pack questions introduced in M2.
3. Register each implemented capability in the default registry and let the
   Singer Pack instantiate completely; no engine change should be required.
