# ArtFlow Development Baseline

This guide describes the repository's verified development and runtime paths. It is operational documentation, not a replacement for activity-level permission, audit, or data-retention rules.

## Environments and dependencies

Use Python 3.12, as selected by `.python-version`, with uv 0.11.29. The Docker image installs that same exact uv version, while the project metadata and CI also support Python 3.13. The lockfile is authoritative:

```powershell
uv sync --locked --extra dev
```

The `dev` extra supplies local quality and test tools. The `production` extra supplies the Linux container runtime dependency and is installed by the Docker image. `requirements.txt` is a generated compatibility artifact; regenerate it only through `scripts\export-requirements.ps1` after an intentional lockfile update.

Copy `.env.example` to `.env` for development and replace every placeholder. The local defaults are `APP_ENV=development` and `DATABASE_ENGINE=sqlite`, which place SQLite data in `db.sqlite3`. Do not use that database file for shared or production data.

Set `DATABASE_ENGINE=postgresql` only with all `POSTGRES_*` connection variables. Production also requires `APP_ENV=production`, `DEBUG=False`, non-placeholder secrets, `ALLOWED_HOSTS`, and `CSRF_TRUSTED_ORIGINS`; use `.env.production.example` as the field list. Production configuration is validated and must not fall back to SQLite.

## Local setup and diagnostics

The standard Windows flow is:

```powershell
Copy-Item .env.example .env
uv sync --locked --extra dev
uv run python manage.py migrate --noinput
uv run python manage.py seed_dev_admin
uv run python manage.py runserver
```

`scripts\bootstrap.ps1` automates dependency synchronization, local environment preparation, migrations, static collection, `check`, `doctor`, and a local health request. It does not reset data. Add `-SeedDemoData` only to create deterministic demo records.

Commercial or event-style account setup is completed from the role-specific
registration pages printed by `scripts\start-event.ps1`:

```text
http://127.0.0.1:8000/register/admin/
http://127.0.0.1:8000/register/staff/
```

The admin form requires `ADMIN_ACCESS_KEY`; the staff form requires
`STAFF_ACCESS_KEY`. Both require username, password, and confirmation. The
participant form at `/register/` requires only username and password. Each
registration path uses the account service authority boundary rather than
writing users directly. Technical operators without a browser can use the
one-time command:

```powershell
docker compose --env-file .env.event -f deploy/compose.event.yml exec web python manage.py provision_first_admin --username event-admin
```

The command reads the password without echoing it, refuses to reset or replace
an initialized installation, and never creates a Django superuser. A launcher
may use `--password-stdin`; it must not put the password in an argument,
tracked environment template, image, audit record, or log. `seed_dev_admin`
remains development-only and is the only command that can reset its local
development account.

Run diagnostics without mutating data:

```powershell
uv run python manage.py doctor
Invoke-WebRequest http://127.0.0.1:8000/livez/
Invoke-WebRequest http://127.0.0.1:8000/readyz/
```

`doctor` checks loaded configuration, database connectivity, unapplied migrations,
static/media directories, non-secret access-key readiness, and the non-secret first-admin provisioning status
(`required`, `complete`, or `inconsistent`). A fresh installation reports
`required` but is not treated as a failure; `inconsistent` is a configuration
failure. When the database is healthy it also reports Ticket row and stale
access-session counts; if the database check fails it does not query Ticket
tables again. It returns nonzero for failures and does not print secrets or a
complete database URL.

Health probes are split by what they actually observe, and all three accept only
`GET` and answer with a minimal body:

| Route | Meaning | Body |
|---|---|---|
| `/livez/` | The application process answered. No database call, no system checks. | `{"status": "alive"}` |
| `/readyz/` | The default database connection is reachable. | `{"status": "ok"}` or generic unavailable |
| `/healthz/` | Readiness under its historical name; kept because the container, Caddy and CI probes already point at it. | same as `/readyz/` |

Django's full system-check set is a startup gate, not a heartbeat: it runs in
`manage.py check` (also executed by `scripts/docker-entrypoint.sh` before
migrations), in `doctor`, and in the deployment gate. The application container's
liveness probe uses `/livez/` so a temporary database outage cannot mark a
running process dead; database readiness is still covered by the Caddy proxy
probe, which reaches `/healthz/` through the real request path.
Event and production launchers pass `doctor --require-access-keys`, which turns
missing or placeholder `STAFF_ACCESS_KEY` / `ADMIN_ACCESS_KEY` into a
configuration failure. After rotating either key, run
`python manage.py invalidate_sessions` in the target web container so every
browser must authenticate again.

## Demo data and reset safety

`seed_dev_admin` creates or updates only the development administrator, taking its password from `DEV_ADMIN_PASSWORD` or an interactive prompt. `seed_demo_data` is repeatable and creates deterministic demo configuration and runtime data.

`seed_demo_data --reset` is a narrow cleanup operation, not a database reset. It deletes only command-owned runtime rows with the repository's test-data flag, including the demo Ticket inventory, and refuses an unsafe cascade. It preserves unmarked formal data, unmarked configuration, and audit records. Ticket access sessions are short-lived and can be purged explicitly with `uv run python manage.py purge_ticket_sessions`; this never deletes Tickets or ballots. Take a backup and use a disposable database before invoking reset during troubleshooting.

## Docker and PostgreSQL

Docker Compose uses PostgreSQL and waits for healthy database and web services:

```powershell
docker compose up --build --wait
Invoke-WebRequest http://127.0.0.1:8000/healthz/
```

The database remains on the internal Docker network. The web port is bound to loopback. Compose uses named volumes for PostgreSQL data (`postgres_data`), collected static files (`static_data`), and media (`media_data`). `docker compose down` stops the stack while retaining those volumes. `docker compose down --volumes` permanently removes all three local volumes, so use it only when intentional data loss is acceptable.

This root Compose file is development/integration only. For an event operated from one local Staff machine, copy `.env.event.example` to `.env.event` and use [`scripts/start-event.ps1`](../scripts/start-event.ps1) with the separate [`deploy/compose.event.yml`](../deploy/compose.event.yml) contract. It stays loopback-only unless `-Lan` is explicitly selected. For production, use [`deploy/compose.production.yml`](../deploy/compose.production.yml), never this root file.

### Event/local-only contract

Use `scripts/start-event.ps1` for the single Staff-operated primary machine. Its default publishes `web` solely as `127.0.0.1:8000`; `-Lan` is an explicit private-network opt-in that derives `ALLOWED_HOSTS` from one validated IPv4 address. PostgreSQL remains private in both modes; the event manifest provides no public ingress, TLS, WAF, or DDoS protection. Never run a second writable event stack. PowerPoint remains an independent presentation tool. Full purchaser instructions are in [event deployment](deployment-event.md).

### PostgreSQL acceptance gate

Run the Task 8 PostgreSQL acceptance contract against the Compose services with:

```powershell
pwsh -NoProfile -File scripts\verify_postgres_acceptance.ps1 -StartCompose -VerifyResetSafety
```

`-StartCompose` explicitly performs `docker compose up --build --wait`; without it, the script requires an already running Compose `web` service. The contract runs migrations, `doctor`, a health request, idempotent demo seeding, the opt-in demo reset check, and Django's full `manage.py test` suite inside the `web` container. The image intentionally installs only the production extra, so this gate uses Django's built-in test runner rather than host `pytest`. It never stops services or removes volumes. Use `docker compose down --volumes` separately—and only when intentionally discarding local PostgreSQL, static, and media data.

### Ballot burst benchmark

`voting.services.submit_ballot` deliberately serializes: it takes the Activity
authority lock, then the VoteSession row lock, then the ticket locks. Do not
change that protocol on a hunch. Measure it first:

```powershell
uv run python manage.py benchmark_ballot_burst --vote-session <pk> --clients 300 --duration 10
```

The command drives the real service entry point from N threads, releases each
client's single ballot across `--duration` seconds, and reports throughput,
success/failure counts with reasons, p50/p95/p99 latency, PostgreSQL peak
connection and blocked-lock counts, deadlocks, and transaction growth. It also
re-checks that accepted ballots equal new ballot rows and that records match, so
a "fast" run that lost votes fails loudly.

It refuses a non-test activity (a burst writes real ballots), refuses SQLite
unless `--allow-sqlite` is passed (row-lock waits there are not representative),
and tags every row it creates as test data. Compare 100/200/300 clients before
and after any change; only adopt a protocol change when the numbers show lock
waits are the bottleneck, and never bypass the integrity or authority contracts
to do it. The measured 100/200/300 baselines and their limits are recorded in
[production readiness](production-readiness.md#2026-10-04-p1-8-投票-burst-量化记录).

## CI and local gates

The repository CI covers Linux SQLite quality checks, Windows application checks, PostgreSQL integration, the scoped `entry_access` Pyright gate, a Chromium browser runtime smoke, workflow linting, dependency audit, CodeQL, and a Git-history secret scan. The PostgreSQL integration verifies migrations, `doctor`, `/healthz/`, repeated demo seeding, the browser-reachable health endpoint, and the explicit PostgreSQL-marked concurrency suite.

Before submitting a branch, run the applicable local gates:

```powershell
uv run python manage.py check
uv run python manage.py makemigrations --check --dry-run
uv run python manage.py test
pwsh -NoProfile -File scripts/check_docs.ps1
git diff --check
```

`scripts\verify.ps1` runs the broader local verification contract, including formatting, typing, tests, root development Compose configuration, production-manifest structure plus `docker compose -f deploy/compose.production.yml config --quiet`, workflow checks, documentation checks, and a production settings check. It does not start or tear down production services.

### Browser runtime smoke

Playwright checks the browser-reachable shape of the already-running local or
Compose web service. Install the locked Node dependencies and Chromium once,
then run:

```powershell
npm ci
npx playwright install chromium
npm run test:e2e
```

The default base URL is `http://127.0.0.1:8000`; set `PLAYWRIGHT_BASE_URL` for
another disposable local/CI service. The initial suite is read-only and checks
`/healthz/`. Trace is disabled by default; future Judge/Ticket specs must use
disposable data and keep trace/video/screenshots disabled whenever a bearer
token is in a request, so raw credentials cannot enter test artifacts.

The Judge authority browser flow requires a disposable fixture. Prepare it with
`manage.py prepare_judge_e2e --output-file <private-temp-file>`, export
`PLAYWRIGHT_JUDGE_FIXTURE_PATH` for the test process, and delete the file after
the run. The command is disabled when `APP_ENV=production`, writes no grant to
stdout, and the Playwright setup deletes the fixture after reading it.

## Troubleshooting

- If `uv sync --locked` fails, do not edit `requirements.txt` to work around it. Restore the expected lockfile or intentionally update the lockfile and regenerate the compatibility requirements through the provided script.
- If `doctor` reports missing static or media directories, run `scripts\bootstrap.ps1`; it creates media and collects static files. Review its first failing command rather than suppressing the diagnostic.
- If `/healthz/` is unavailable, run `doctor` in the same environment, then inspect the local server output or `docker compose logs` for the failing service.
- If PostgreSQL cannot connect, confirm `DATABASE_ENGINE=postgresql`, all `POSTGRES_*` values, and—inside Compose—the `db` hostname. Do not point a container at a host SQLite file.
- If migrations are unapplied, run `uv run python manage.py migrate --noinput` against the intended database, then rerun `doctor`.

## Security and source control

Never commit `.env`, production credentials, database files, uploads, exports, archives, or generated media. Examples use placeholders only; replace them locally or through deployment secret management. Keep internal submission files behind controlled access views, and do not put sensitive configuration in `doctor`, health, CI, or container logs.

Create a short-lived branch from a clean, updated `main`; verify and commit the scoped change on that branch. The integration owner performs the non-fast-forward merge into `main` after verification. See [repository instructions](../AGENTS.md) for the repository-wide workflow rules.
