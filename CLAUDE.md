# CLAUDE.md

## Project overview

ArtFlow is a Django monolith for university arts-department activity operations. Domain apps live in `accounts/`, `core/`, `public_portal/`, `files/`, `singer_contest/`, `farewell_show/`, `voting/`, `staff_panel/`, `exports/`, `archive/`, `incidents/`, and `common/`. Read `GOAL.md` for product scope and [the development baseline](docs/development-baseline.md) for the current, verified operating procedures.

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
- Do not let claude get into Co-Authored commits; it is a code reviewer, not a code author. Use `git commit --author` to correct any misattribution.

## Git workflow

Work on a short-lived feature branch from a clean, updated `main`. Verify the scoped change before committing. The integration owner merges the verified branch into `main` with a non-fast-forward merge and pushes `main`; do not rewrite or force-push shared history.
