# Repository Guidelines

## Project Structure & Module Organization
ArtFlow is a Django monolith for student arts department activity operations. Core project settings live in `config/`; feature apps are split by domain:

- `accounts/`: custom user model, roles, login/register flows.
- `core/`: shared `Activity` model and activity phase/lock state.
- `public_portal/`: public homepage, announcements, showcases, result posts.
- `files/`: submission files, material requirements, material checks.
- `singer_contest/`: singer registrations, rounds, judges, scores, awards.
- `farewell_show/`: graduation show program submissions and program order.
- `voting/`: audience vote sessions, options, records.
- `staff_panel/`: staff/admin dashboard views and operational workflows.
- `exports/`, `archive/`, `incidents/`, `common/`: export, archive, incident, audit, and shared utilities.

Templates are under `templates/`. Tests are app-level `tests.py` files. Local media under `media/` must not be committed.

## Build, Test, and Development Commands
Prefix shell commands with `rtk` in agent workflows when `rtk` is installed. If the command is unavailable on the current machine, run the command directly and report that fallback; do not block repository work on an optional wrapper.

```bash
uv sync --locked --extra dev
python manage.py migrate
python manage.py runserver
python manage.py check
python manage.py makemigrations --check --dry-run
python manage.py test
python manage.py test staff_panel
python manage.py doctor
pwsh -NoProfile -File scripts/check_docs.ps1
pwsh -NoProfile -File scripts/verify_postgres_acceptance.ps1 -StartCompose -VerifyResetSafety
npm ci
npm run check:css
npm run check:client
npm run test:client
npm run check:pyright
npm run check:pyright:entry-access
npx playwright install chromium
npm run test:e2e
pwsh -NoProfile -File scripts/verify_postgres_backup_restore.ps1 -ComposeProjectName artflow -BackupPath backups/artflow-rehearsal.dump
```

Use `migrate` after pulling migrations, `runserver` locally, `check` for Django validation, `doctor` for read-only runtime diagnostics, and `test` before committing. Install the locked development environment with `uv sync --locked --extra dev`; use `check_docs.ps1` after user-facing documentation changes. `check:client` compiles every `frontend/**/*.ts` entry and fails when tracked `static/dist/` output is stale; `test:client` executes the compiled client artifact. `check:pyright` runs the project baseline and remains non-blocking; `check:pyright:entry-access` is the blocking scoped gate for the hardened entry-access boundary. The PostgreSQL acceptance command requires Docker Compose and leaves its services and volumes intact; `-VerifyResetSafety` makes the demo-data reset check explicit. The CSS gate rebuilds the pinned Tailwind asset and fails if the tracked output is stale. `test:e2e` requires an already-running local or Compose web service and runs the read-only Playwright browser smoke. The backup/restore rehearsal creates a custom-format dump from the running Compose database, restores it into a separate temporary database container, runs Django checks, and cleans up only that temporary target. It must never use `docker compose down --volumes`, reset, or drop the source database/volumes.

## Coding Style & Naming Conventions
Use Python 4-space indentation and Django conventions: models as `PascalCase`, functions/views as `snake_case`, URL names as concise action names such as `vote_session_unlock`. Keep cross-flow rules in shared helpers, e.g. `common/business_rules.py`. Do not enforce permissions only in templates; validate before mutation.

## Testing Guidelines
Use Django `TestCase`. Add regression tests for permission, lock-state, audit, file-access, export, and destructive-data paths. Prefer tests in the app that owns the behavior; cross-flow staff/admin tests can live in `staff_panel/tests.py`. Name tests by behavior, for example `test_locked_activity_blocks_staff_score_entry`.

## Commit & Pull Request Guidelines
Commit messages follow conventional prefixes seen in history: `feat:`, `fix:`, `style:`, `docs:`, `test:`, `chore:`. Keep commits scoped and push feature-branch commits after verification; push `main` only after the verified non-fast-forward merge.

## Agent Execution & Git Network Rules

- Do not spawn subagents to execute repository modifications. The primary agent must inspect, edit, test, and verify changes directly in the current conversation.
- If `git push` times out, retry through the local VPN proxy at `127.0.0.1:12334`:

```bash
git -c http.proxy=http://127.0.0.1:12334 -c https.proxy=http://127.0.0.1:12334 push origin <branch>
```

## Branch & Worktree Workflow

Do not use `.worktree/`, `worktrees/`, or any other linked worktree for ArtFlow development. Work directly in the repository checkout on a short-lived branch created from a clean, up-to-date `main`:

```bash
git status --short --branch
git switch main
git pull --ff-only origin main
git switch -c build/<short-name>
```

Use `feat/`, `fix/`, `docs/`, `test/`, or `build/` prefixes as appropriate. Do not start work if `main` has uncommitted changes; preserve existing user changes and ask before proceeding.

After verification, commit the scoped changes on the feature branch, merge the branch into `main` with a non-fast-forward merge, and push `main`:

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

Keep the feature branch until the merge and push have been confirmed. Delete it only after the final Git status and remote state are verified.

Before opening a PR, run:

```bash
python manage.py check
python manage.py makemigrations --check --dry-run
python manage.py test
```

PRs should summarize behavior changes, list migrations, note verification, and include screenshots for UI changes.

## Security & Configuration Tips
Never commit `.env`, SQLite databases, generated exports, archives, or uploaded files. Use `.env.example` for required variables such as `SECRET_KEY`, `ADMIN_LOGIN_KEY`, database settings, and `ALLOWED_HOSTS`. Internal submission files must go through controlled access views; do not reintroduce direct static media serving for private files.

## Authority Baseline
Raw scoring, criterion scores, vote ballots/records, and round performance/group facts are
authoritative inputs. After their round/session is locked, or after a confirmed stage has
consumed them, do not mutate them through direct ORM writes; use the corresponding audited
service and explicit unlock flow. `StageAwardDecision` is a computed candidate only;
`Award` rows sourced from a stage may be materialized only when that stage is confirmed.
Ruleset templates must expose `builtin_key` and capability status; only `Production`
templates may be cloned into a production workflow. Vote sessions must declare their
purpose, and a ruleset vote source must match that purpose at bound freeze time.
