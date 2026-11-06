@docs\artflow-plus\self-build-checklist.md
# Repository Guidelines

## Project Structure & Module Organization

ArtFlow is a single-line repository. `main` carries **ArtFlow-Plus (v2)**; the 1.x Django monolith remains at the root only until external review and the v1→v2 coverage audit close. Do not add features to the Django code.

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

### Retained 1.x source

`accounts/`, `core/`, `ruleset/`, `questionnaire/`, `files/`, `singer_contest/`, `voting/`, `tickets/`, `entry_access/`, `public_portal/`, `farewell_show/`, `staff_panel/`, `exports/`, `archive/`, `incidents/`, `common/`, `config/`, `templates/`, `frontend/`, and `static/` are the frozen Django monolith. They can be inspected with `uv sync --locked --extra dev`, `uv run python manage.py check`, and `uv run python manage.py test`, but are not a delivery path. Delete them only after the coverage audit and external review are approved.

## Coding Style & Naming Conventions

- TypeScript: strict, ESM, `.js` import suffixes. Keep capability code dependent on its own module and the engine only; never import another capability's internals.
- Domain logic stays pure; runtime services own transactions and projections; API routes translate HTTP and never invent authority.
- HTTP registration lives in `plus/apps/api/src/routes/<surface>.ts`; each module exports `registerXRoutes(ctx: ApiContext)`. `app.ts` keeps construction, hooks, CSRF, error mapping, and the realtime server only. `tests/gates/test_plus_route_modules.py` enforces the boundary.
- `db/src/types.ts` and `db/src/migrations.ts` are two descriptions of one schema. Update both for any schema change and run `pnpm -C plus run schema:check`; the drift gate compares tables, columns, and nullability against a migrated PostgreSQL schema.
- React components use PascalCase files for routes/components and camelCase for helpers; shared contracts come from `@artflow-plus/contracts`.
- Python that remains in the 1.x tree follows Django conventions and is migration-only until deletion.

## Testing Guidelines

- Add a focused test beside the behavior: domain unit tests, runtime database tests, API route tests, and browser E2E for user journeys.
- Database tests use `REQUIRE_DB=1` and a disposable schema; never let a skipped database test pass silently.
- Golden fixtures are implementation-independent and must keep passing through the v2 runtime.
- A fixed defect should become a regression test or an invariant entry.

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
- While the Django tree remains: `pyrightconfig.json`, `[tool.mypy] files`, `[tool.ruff] src`, and `tailwind.config.js` still list every app directory.

## Security & Configuration Tips

Never commit `.env`, secrets, generated exports, archives, uploaded files, or database dumps. Keep credentials in the deployment environment. Private material bytes and archives are served only through the controlled Plus APIs; do not add direct static routes for them.
