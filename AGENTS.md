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
Prefix shell commands with `rtk` in agent workflows.

```bash
python manage.py migrate
python manage.py runserver
python manage.py check
python manage.py makemigrations --check --dry-run
python manage.py test
python manage.py test staff_panel
```

Use `migrate` after pulling migrations, `runserver` locally, `check` for Django validation, and `test` before committing. Install dependencies with `uv pip install -r requirements.txt` or an activated virtualenv plus `pip install -r requirements.txt`.

## Coding Style & Naming Conventions
Use Python 4-space indentation and Django conventions: models as `PascalCase`, functions/views as `snake_case`, URL names as concise action names such as `vote_session_unlock`. Keep cross-flow rules in shared helpers, e.g. `common/business_rules.py`. Do not enforce permissions only in templates; validate before mutation.

## Testing Guidelines
Use Django `TestCase`. Add regression tests for permission, lock-state, audit, file-access, export, and destructive-data paths. Prefer tests in the app that owns the behavior; cross-flow staff/admin tests can live in `staff_panel/tests.py`. Name tests by behavior, for example `test_locked_activity_blocks_staff_score_entry`.

## Commit & Pull Request Guidelines
Commit messages follow conventional prefixes seen in history: `feat:`, `fix:`, `style:`, `docs:`, `test:`, `chore:`. Keep commits scoped and push after each commit.

Before opening a PR, run:

```bash
python manage.py check
python manage.py makemigrations --check --dry-run
python manage.py test
```

PRs should summarize behavior changes, list migrations, note verification, and include screenshots for UI changes.

## Security & Configuration Tips
Never commit `.env`, SQLite databases, generated exports, archives, or uploaded files. Use `.env.example` for required variables such as `SECRET_KEY`, `ADMIN_LOGIN_KEY`, database settings, and `ALLOWED_HOSTS`. Internal submission files must go through controlled access views; do not reintroduce direct static media serving for private files.
