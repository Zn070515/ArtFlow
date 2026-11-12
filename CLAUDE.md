@docs\artflow-plus\self-build-checklist.md
# CLAUDE.md

## Project overview

ArtFlow is a single-line repository. `main` carries **ArtFlow-Plus (v2)** under `plus/` — a Node 24 / Fastify 5 / React 19 / PostgreSQL 18 workspace. The 1.x Django monolith has been removed from `main`; its complete source is preserved in tag `v1.0.2`, and its feature record lives in `docs/archive/v1/`. Do not reintroduce it.

Read `GOAL.md` for product scope, [`AGENTS.md`](AGENTS.md) for the module breakdown, and [the development baseline](docs/development-baseline.md) for the current, verified operating procedures.

## Development environment

ArtFlow-Plus uses Node 24, pnpm 12.14.0, and PostgreSQL 18 in a pnpm workspace under `plus/`. The local database container is `artflow-plus-postgres` on `127.0.0.1:5433`:

```powershell
Set-Location plus
pnpm install
pnpm run check
$env:ARTFLOW_PLUS_DATABASE_URL = "postgresql://artflow:artflow_dev@127.0.0.1:5433/artflow_plus"
$env:REQUIRE_DB = "1"
pnpm run test
pnpm --filter @artflow-plus/api start
pnpm --filter @artflow-plus/web dev
```

The API migrates on start. Browser E2E uses the `artflow_e2e` schema with `workers: 1`. `uv run pytest tests/gates -q` includes the structural gates; `uv run python tests/golden/validate_fixtures.py` validates the implementation-independent fixtures.

Python is used only for structural gates: `uv sync --locked --extra dev`, `uv run pytest tests/gates -q`, `uv run python tests/golden/validate_fixtures.py`, and `pwsh -NoProfile -File scripts/check_docs.ps1`.

.NET 9 is used only by the renderer-only document export sidecar under `plus/services/document-export/`; verify it with `dotnet restore --locked-mode` and `dotnet test` on that solution. It never receives database credentials.

## Runtime operations

Plus runs through `deploy/compose.production.yml` with the `plus` profile. Three images (`artflow-plus-api`, `artflow-plus-worker`, `artflow-plus-web`) are built from the same `v*` tag and must be pinned by `@sha256:...` digest in `.env.production`.

`GET /healthz/` is anonymous and intentionally returns only a generic status. Backups and restores follow [backup-restore](docs/artflow-plus/backup-restore.md).

## Engineering rules

- Enforce permissions before every mutation; UI is not an authorization boundary.
- Preserve the single write path: receipt, audit, fact, and outbox in one transaction.
- Keep releases immutable and partition facts, events, and projections by mode.
- Route internal files through the controlled material/archive APIs; never expose private media directly.
- The document export sidecar is renderer-only: authorized rows go in, OOXML bytes come out. Never give it database credentials, a public port, file storage, or caller-supplied templates/paths.
- **HTTP routes live in `plus/apps/api/src/routes/<surface>.ts`.** Each module exports `registerXRoutes(ctx: ApiContext)`; `app.ts` is composition only (construction, hooks, CSRF, error mapping, realtime server). Never register a route directly in `app.ts`; `tests/gates/test_plus_route_modules.py` rejects it, unreferenced modules, duplicate method+URL pairs, and a module growing past 900 lines.
- **The schema has one source.** Migrations define it; `db/schema.snapshot.json` is generated from a migrated database; `db/src/types.ts` is generated from the snapshot. Any migration, column, or nullability change must regenerate both (`schema:snapshot`, `schema:types`) and pass `pnpm -C plus run schema:check` against PostgreSQL. The gate compares the snapshot with migrations and the types with the snapshot; editing a generated file by hand is a CI failure. `ColumnType<unknown, …>` is treated as nullability-indeterminate.
- **Worker changes must preserve drained shutdown and bounded retry.** Keep the ready file for the compose healthcheck, the dead-letter queue, and the `startRelayLoop` drain; run `pnpm -C plus --filter @artflow-plus/worker test`.
- Do not commit `.env`, secrets, uploads, exports, archives, or generated media.
- Run `pwsh -NoProfile -File scripts/check_docs.ps1` after user-facing documentation changes.
- After each change round, sweep the configuration files for anything that change made stale: the pyright/ruff/mypy lists, the `tsconfig*.json` `include` lists, the Tailwind `content` globs, the `.env` templates, `.dockerignore`, and `dependabot.yml`. A file that exists but appears in no list is checked by nothing.
- Do not let claude get into Co-Authored commits; it is a code reviewer, not a code author. Use `git commit --author` to correct any misattribution.
- Keep reviewer/advice documents under `docs/advices/`; never place a `ChatGPT.md` (or any large reviewer-note dump) at the repository root.

## Test architecture rules

The test system is part of the architecture, not a follow-on. The design record is
`docs/artflow-plus/specs/2026-11-11-self-auditing-test-system-design.md` and
`docs/artflow-plus/specs/2026-11-11-contract-testing-program-design.md`; the tooling lives in
`plus/tools/contracts/`. These rules apply to every capability change.

- **Lifecycle contracts are reusable templates.** Cover the initial state, legal and illegal
  transitions, terminal states and their write protection, version conflicts, duplicate/replayed
  commands, concurrent transitions, cross-capability preconditions, `test`/`rehearsal`/`formal`
  isolation, and archive/revoke/republish/recovery. A capability supplies an adapter (construct
  state, execute command, read state, declare business constraints); it must not re-copy the
  template per module.
- **One contract distribution.** Compose small, orthogonal schemas from
  `packages/contracts/src/contracts/` (descriptor, lifecycle, authorization, idempotency,
  transaction, event, recovery). Capability manifests, shared schemas, and runtime behavior must
  agree; extend the shared contract instead of adding a surface-local shape. Never build a
  monolithic schema that restates the business.
- **Adapters are the integration seam.** Each capability plugs into the harness through
  `plus/tools/contracts/src/harness/adapters/`. Use real PostgreSQL and the real command path, not
  repository mocks. Keep the adapter thinner than the production path and never freeze
  implementation details into a contract.
- **The Consumer Graph is a gate.** `graph:check` must keep zero unresolved edges, and new routes,
  events, topics, and read models must be discoverable or explicitly declared (`api-only.json`,
  `dynamic-dependencies.json`) with a reason. Consult reverse and transitive impact before changing
  a shared seam; review new warnings instead of letting them accumulate.
- **Fault injection is required, not optional.** Exercise call, transaction, event, state,
  concurrency, and dependency faults. A fault case must be reproducible, controllable, located,
  isolated from other tests, free of arbitrary sleeps, able to print the parameters needed to
  reproduce, and must assert both behavior during the fault and the recovered final state. Inject
  through dependency injection, clocks, schedulers, and test seams; do not pollute production code.
- **Do not let the test system grow into a second business system.** No per-function suites, no
  cartesian-product matrices, no copy-pasted templates, no contracts that encode implementation
  details, no over-mocking, and no unit-test-only claims. Tier the work by cost and risk: fast
  static/contract checks, medium database/API integration, high-cost concurrency/recovery/E2E, and
  periodic state-space exploration. Test count, coverage, and line count are not completion
  evidence; a new abstraction must repay its maintenance cost.
- **Expectations come from outside the implementation.** Derive them from invariants, golden
  fixtures, journey specs, and consumer contracts — never generate the expected result from the code
  under test and then assert it back. A test that cannot fail is not evidence; prove the red before
  declaring the green.
- **Specs and plans must carry a test-architecture section.** Every document under
  `docs/artflow-plus/specs/` and `docs/artflow-plus/plans/` names: the contracts and capabilities
  touched; the consumers and read models affected (from the graph); the lifecycle edges, terminal
  guards, and mode isolation; the adapter(s) and whether an existing one extends; the fault and
  recovery cases; why existing tests are insufficient; the anti-bloat decision (extend versus add);
  and the focused gates to run. A spec without this section is incomplete, and a plan must schedule
  proof before scale.

## Git workflow

Work on a short-lived feature branch from the clean, updated `main`. Verify the scoped change before committing. Merge the verified branch back into `main` with a non-fast-forward merge and push it; do not rewrite or force-push shared history.

Pushing is automatic and does not need to be requested each time: once a scoped change has passed its focused gate, commit it on the short-lived branch, merge it into `main` with `--no-ff`, and push. Never push a change that has not passed its focused gate, and never force-push or rewrite shared history.
