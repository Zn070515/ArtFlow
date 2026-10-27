# CLAUDE.md

## Project overview

ArtFlow is a two-era repository. `main` is the **1.x production line** — a Django monolith serving the live v1.0.x deployment. `artflow-plus` is the **v2 development line (ArtFlow-Plus)** under `plus/` — a Node 24 / Fastify 5 / React 19 / PostgreSQL 18 workspace that is complete through M13.1 but has not cut production over. The two lines do not merge mechanically; implement v2 behavior, not v1 bug fixes, and only the deliberate cutover crosses lines.

Read `GOAL.md` for product scope, [`AGENTS.md`](AGENTS.md) for the module breakdown of both lines, and [the development baseline](docs/development-baseline.md) for the current, verified operating procedures.

## Development environment

Use the repository's Python 3.12 baseline from `.python-version` and uv 0.11.29 with the lockfile-backed development environment. Python 3.13 remains supported by project metadata and CI:

```powershell
uv sync --locked --extra dev
uv run python manage.py migrate --noinput
uv run python manage.py check
uv run python manage.py test
```

For a first local setup, copy `.env.example` to `.env` and replace every `change-me` value. `scripts\bootstrap.ps1` prepares the local environment, runs migrations and diagnostics, and never resets data. It accepts `-SeedDemoData` only when deterministic demo records are wanted.

`seed_dev_admin` creates or updates the local administrator using `DEV_ADMIN_PASSWORD` or an interactive prompt. `seed_demo_data` is idempotent. `seed_demo_data --reset` is deliberately constrained to command-owned, test-marked runtime rows; never treat it as a general-purpose data deletion tool.

ArtFlow-Plus (v2) uses Node 24, pnpm 12.14.0, and PostgreSQL 18 in a pnpm workspace under `plus/`. The local database container is `artflow-plus-postgres` on `127.0.0.1:5433`:

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

The v2 API migrates on start. Browser E2E uses the `artflow_e2e` schema with `workers: 1`. `uv run pytest tests/gates -q` includes the v2 structural gates.

## Runtime operations

Development defaults to SQLite. Docker Compose is the PostgreSQL path:

```powershell
docker compose up --build --wait
Invoke-WebRequest http://127.0.0.1:8000/healthz/
```

Use `uv run python manage.py doctor` for read-only configuration, database, migration, static-directory, and media-directory diagnostics. `GET /healthz/` is anonymous and intentionally returns only a generic status. The container image installs the `production` dependency extra; Windows development uses the `dev` extra.

## Engineering rules

- Enforce permissions before every mutation; templates are not authorization boundaries.
- Use `settings.AUTH_USER_MODEL` or `get_user_model()`, never `auth.User`.
- Route internal files through controlled access views; do not expose private media with a static route.
- Preserve activity and result locks, audit logging, and test-data safeguards when changing operational flows.
- Do not commit `.env`, secrets, SQLite databases, uploads, exports, archives, or generated media.
- Run `pwsh -NoProfile -File scripts/check_docs.ps1` after user-facing documentation changes.
- After each change round, sweep the configuration files for anything that change made stale: the pyright `include` list, the ruff/mypy module lists, the `tsconfig*.json` `include` lists, the Tailwind `content` globs, the `.env` templates, `.dockerignore`, and `dependabot.yml`. A file that exists but appears in no list is checked by nothing.
- Do not let claude get into Co-Authored commits; it is a code reviewer, not a code author. Use `git commit --author` to correct any misattribution.
- Keep reviewer/advice documents under `docs/advices/`; never place a `ChatGPT.md` (or any large reviewer-note dump) at the repository root.

## Git workflow

Work on a short-lived feature branch from the clean, updated base of the line you are changing — `main` for 1.x fixes, `artflow-plus` for v2 work. Verify the scoped change before committing. Merge the verified branch back into that same line with a non-fast-forward merge and push it; do not rewrite or force-push shared history, and never merge across lines.

Pushing is automatic and does not need to be requested each time: once a scoped change has passed its focused gate, commit it on the short-lived branch, merge it into the line it targets (`main` or `artflow-plus`) with `--no-ff`, and push that line. Never push a change that has not passed its focused gate, and never force-push or rewrite shared history.
