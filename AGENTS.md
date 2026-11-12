@docs\artflow-plus\self-build-checklist.md
# Repository Guidelines

## Project Structure & Module Organization

ArtFlow is a single-line repository. `main` carries **ArtFlow-Plus (v2)**; the 1.x Django monolith has been removed and its source is preserved in tag `v1.0.2`. Its feature record is in `docs/archive/v1/`. Do not reintroduce it.

### ArtFlow-Plus layout

v2 is a pnpm 12 workspace with Node 24, Fastify 5, Kysely/PostgreSQL 18, and React 19:

- `plus/apps/api/`: Fastify HTTP + the single `/api/realtime` WebSocket endpoint; command routes, public reads, cookie sessions/CSRF.
- `plus/apps/web/`: React + Vite + TanStack Router/Query; Studio, Ops, Live, Portal, and `/vote/<sessionId>`.
- `plus/apps/worker/`: outbox relay (in-process 250ms loop + pg-boss backstop).
- `plus/packages/domain/`: pure domain, capability registry, packs, compilers, command/event model.
- `plus/packages/runtime/`: command handlers, projections, and capability services.
- `plus/packages/db/`: Kysely schema, module-owned migrations, repositories.
- `plus/packages/contracts/`: shared TypeBox schemas.
- `plus/packages/realtime/`: the protected WebSocket core (`/protocol`, `/server`, `/client`); read `CORE.md` before touching it. Feature code registers `RealtimeTopic` definitions and must not open sockets directly (`GATE-REALTIME-CORE-01`).
- `plus/tools/contracts/`: development/CI-only Consumer Graph, contract schemas and adapters, journey specs, audit and mutation tooling. It must not enter the runtime image dependency closure.

Commands (from the repository root):

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

The API migrates on start. Browser E2E uses the `artflow_e2e` schema and `workers: 1`. Structural gates live in `tests/gates`; golden fixtures are validated by `uv run python tests/golden/validate_fixtures.py`.

## Coding Style & Naming Conventions

- TypeScript: strict, ESM, `.js` import suffixes. Keep capability code dependent on its own module and the engine only; never import another capability's internals.
- Domain logic stays pure; runtime services own transactions and projections; API routes translate HTTP and never invent authority.
- HTTP registration lives in `plus/apps/api/src/routes/<surface>.ts`; each module exports `registerXRoutes(ctx: ApiContext)`. `app.ts` keeps construction, hooks, CSRF, error mapping, and the realtime server only. `tests/gates/test_plus_route_modules.py` enforces the boundary.
- The schema has one source: migrations → `db/schema.snapshot.json` → `db/src/types.ts`. After any schema change run `pnpm -C plus run schema:snapshot` and `schema:types`, then `pnpm -C plus run schema:check`; the gate compares the snapshot with migrations and the types with the snapshot. Do not hand-edit generated files.
- React components use PascalCase files for routes/components and camelCase for helpers; shared contracts come from `@artflow-plus/contracts`.
- Python is gate-only: pytest/ruff over `tests/gates`, `tests/golden`, and `scripts/tests`.

## Testing Guidelines

- Add a focused test beside the behavior: domain unit tests, runtime database tests, API route tests, and browser E2E for user journeys.
- Database tests use `REQUIRE_DB=1` and a disposable schema; never let a skipped database test pass silently. A standalone run that skipped its database cases is not evidence of passing.
- Golden fixtures are implementation-independent and must keep passing through the v2 runtime.
- A fixed defect should become a regression test or an invariant entry.

### Test architecture rules

The test system is part of the architecture. The design record is
`docs/artflow-plus/specs/2026-11-11-self-auditing-test-system-design.md` and
`docs/artflow-plus/specs/2026-11-11-contract-testing-program-design.md`; the tooling lives in
`plus/tools/contracts/`.

1. **Lifecycle templates, not per-capability copies.** The shared harness covers initial state,
   legal and illegal transitions, terminal states and post-terminal write protection, version
   conflicts, duplicate/replayed commands, concurrent transitions, cross-capability preconditions,
   `test`/`rehearsal`/`formal` isolation, and archive/revoke/republish/recovery. Each capability
   contributes an adapter that constructs state, executes a command, reads state, and declares its
   business constraints.
2. **One contract distribution.** Compose small, orthogonal schemas from
   `plus/packages/contracts/src/contracts/` (descriptor, lifecycle, authorization, idempotency,
   transaction, event, recovery). Manifest, shared schema, and runtime behavior must agree; extend
   the shared contract instead of adding a surface-local shape. Never write one schema that restates
   the whole business.
3. **Adapters are the only integration seam.** Register each capability in
   `plus/tools/contracts/src/harness/adapters/`. Use real PostgreSQL and the real command path; do
   not mock repositories. The adapter must stay thinner than the production path and must not encode
   implementation details as expectations.
4. **The Consumer Graph is a gate.** `graph:check` must stay at zero unresolved edges. New routes,
   events, topics, and read models must be discoverable or explicitly declared in `api-only.json` or
   `dynamic-dependencies.json` with a reason. Check reverse and transitive impact before changing a
   shared seam, and review new warnings rather than letting them accumulate.
5. **Fault injection covers failure and recovery.** Exercise call, transaction, event, state,
   concurrency, and dependency faults. A case must be reproducible, controllable, located, isolated,
   free of arbitrary sleeps, able to print its reproduction parameters, and must assert both the
   behavior during the fault and the recovered final state. Inject through dependency injection,
   clocks, schedulers, and test seams; do not add test-only branches to production code.
6. **Expectations are independent.** Derive them from invariants, golden fixtures, journey specs,
   and consumer contracts — never from the implementation under test. Prove the red before claiming
   the green.
7. **Do not let the test system become a second business system.** No per-function suites, no
   cartesian-product matrices, no copy-pasted templates, no contracts that encode implementation
   details, no over-mocking, and no unit-test-only claims. Tier by cost and risk: fast
   static/contract checks, medium database/API integration, high-cost concurrency/recovery/E2E, and
   periodic state-space exploration. Test count, coverage, and line count are not completion
   evidence; a new abstraction must repay its maintenance cost.

## Spec & Plan Requirements

Every document under `docs/artflow-plus/specs/` and `docs/artflow-plus/plans/` must include a
**Test architecture** section written before implementation starts:

- contracts and capabilities touched, and whether an existing contract extends;
- consumers, read models, routes, events, and topics affected, taken from `graph:check`;
- lifecycle edges, terminal guards, and `test`/`rehearsal`/`formal` isolation;
- the adapter(s) used and why they stay thin;
- fault-injection cases with the recovery state each one asserts;
- why the existing tests are insufficient;
- the anti-bloat decision: which template or adapter is extended instead of adding a test;
- the focused gates to run and the evidence that will count as proof.

A spec without this section is incomplete. A plan must order the work as
prove-the-failure → fix/extend → regression → expand, and must not scale a mechanism before its
usefulness has been demonstrated on a real defect.

## Commit & Pull Request Guidelines

Every logical change is a small, independently verifiable commit. Separate test additions, behavior fixes, type-hygiene batches, and documentation changes. Run the focused gate before each commit. Conventional prefixes: `feat:`, `fix:`, `style:`, `docs:`, `test:`, `chore:`, `build:`.

PRs should summarize behavior changes, list migrations, note verification, and include screenshots for UI changes.

## Agent Execution & Git Network Rules

- Execute repository work inline in the current conversation. Do not spawn subagents or delegate inspection, editing, testing, verification, cleanup, commits, or merges; the primary agent must perform and report those actions directly.
- If `git push` times out, retry through the local VPN proxy at `127.0.0.1:12334`:

```bash
git -c http.proxy=http://127.0.0.1:12334 -c https.proxy=http://127.0.0.1:12334 push origin <branch>
```

## Branch & Worktree Workflow

Work directly in the repository checkout on a short-lived branch from the clean, up-to-date `main`. Do not use linked worktrees.

```bash
git status --short --branch
git switch main
git pull --ff-only origin main
git switch -c feat/<short-name>
```

Use `feat/`, `fix/`, `docs/`, `test/`, or `build/` prefixes. Do not start work with uncommitted changes; preserve existing user changes and ask before proceeding.

After verification:

```bash
git status --short
git diff --check
git add <scoped-files>
git commit -m "<type>: <short description>"
git switch main
git pull --ff-only origin main
git merge --no-ff <branch-name>
git push origin main
```

Keep the branch until the merge and push are confirmed.

Before merging, run:

```bash
pnpm -C plus run check
pnpm -C plus run test          # REQUIRE_DB=1 against PostgreSQL
pnpm -C plus run build:prod
uv run pytest tests/gates -q
uv run python tests/golden/validate_fixtures.py
pwsh -NoProfile -File scripts/check_docs.ps1
```

## Configuration Sweep

After each round, check the configuration against what the tree now contains:

- `tsconfig*.json` `include` — every TypeScript source is type-checked.
- `plus/apps/web` Tailwind content globs — match everywhere class names are written.
- `.env.example` / `.env.production.example` / `.env.event.example` — every knob the Plus apps read is documented.
- `.dockerignore` / `.gitignore` — node_modules, dist, media, archives, logs, and local databases are excluded.
- `.github/dependabot.yml` — one entry per package ecosystem the repository actually uses.
- `pyproject.toml` `[tool.ruff] src` and `[tool.pytest.ini_options] testpaths` still cover every gate module.

## Security & Configuration Tips

Never commit `.env`, secrets, generated exports, archives, uploaded files, or database dumps. Keep credentials in the deployment environment. Private material bytes and archives are served only through the controlled Plus APIs; do not add direct static routes for them.
