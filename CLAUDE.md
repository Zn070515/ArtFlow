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

## Runtime operations

Plus runs through `deploy/compose.production.yml` with the `plus` profile. Three images (`artflow-plus-api`, `artflow-plus-worker`, `artflow-plus-web`) are built from the same `v*` tag and must be pinned by `@sha256:...` digest in `.env.production`.

`GET /healthz/` is anonymous and intentionally returns only a generic status. Backups and restores follow [backup-restore](docs/artflow-plus/backup-restore.md).

## Engineering rules

- Enforce permissions before every mutation; UI is not an authorization boundary.
- Preserve the single write path: receipt, audit, fact, and outbox in one transaction.
- Keep releases immutable and partition facts, events, and projections by mode.
- Route internal files through the controlled material/archive APIs; never expose private media directly.
- **HTTP routes live in `plus/apps/api/src/routes/<surface>.ts`.** Each module exports `registerXRoutes(ctx: ApiContext)`; `app.ts` is composition only (construction, hooks, CSRF, error mapping, realtime server). Never register a route directly in `app.ts`; `tests/gates/test_plus_route_modules.py` rejects it, unreferenced modules, duplicate method+URL pairs, and a module growing past 900 lines.
- **`db/src/types.ts` and `db/src/migrations.ts` describe one schema.** Any migration, column, or nullability change must update both and pass `pnpm -C plus run schema:check` against PostgreSQL. The gate compares every table/column and nullable flag; adding a column to one side only is a CI failure. `ColumnType<unknown, …>` is treated as nullability-indeterminate.
- **Worker changes must preserve drained shutdown and bounded retry.** Keep the ready file for the compose healthcheck, the dead-letter queue, and the `startRelayLoop` drain; run `pnpm -C plus --filter @artflow-plus/worker test`.
- Do not commit `.env`, secrets, uploads, exports, archives, or generated media.
- Run `pwsh -NoProfile -File scripts/check_docs.ps1` after user-facing documentation changes.
- After each change round, sweep the configuration files for anything that change made stale: the pyright/ruff/mypy lists, the `tsconfig*.json` `include` lists, the Tailwind `content` globs, the `.env` templates, `.dockerignore`, and `dependabot.yml`. A file that exists but appears in no list is checked by nothing.
- Do not let claude get into Co-Authored commits; it is a code reviewer, not a code author. Use `git commit --author` to correct any misattribution.
- Keep reviewer/advice documents under `docs/advices/`; never place a `ChatGPT.md` (or any large reviewer-note dump) at the repository root.

## Git workflow

Work on a short-lived feature branch from the clean, updated `main`. Verify the scoped change before committing. Merge the verified branch back into `main` with a non-fast-forward merge and push it; do not rewrite or force-push shared history.

Pushing is automatic and does not need to be requested each time: once a scoped change has passed its focused gate, commit it on the short-lived branch, merge it into `main` with `--no-ff`, and push. Never push a change that has not passed its focused gate, and never force-push or rewrite shared history.
