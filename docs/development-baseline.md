# ArtFlow Development Baseline

This guide describes the repository's verified development and runtime paths. It is
operational documentation, not a replacement for activity-level permission, audit, or
data-retention rules.

## Single repository line

`main` carries ArtFlow-Plus (v2, Node 24 + Fastify 5 + React 19 + PostgreSQL 18) under
`plus/`. The 1.x Django monolith has been removed from `main`; its complete source is
preserved in tag `v1.0.2`, and its feature record lives in
[`docs/archive/v1/`](archive/v1/README.md). There is no v1 compatibility bridge (legacy
bundle import, operational adoption, participant claim, or v1 media bridge). See
[`docs/artflow-plus/README.md`](artflow-plus/README.md) and the
[coverage audit](artflow-plus/skeleton-coverage.md).

## ArtFlow-Plus baseline

- **Toolchain**: Node 24, pnpm 12, TypeScript 7, Fastify 5, Kysely, PostgreSQL 18.
  The local dev database container is `artflow-plus-postgres` on `127.0.0.1:5433`
  (database `artflow_plus`, user `artflow`, development password `artflow_dev`).
- **Install and typecheck**:

  ```powershell
  Set-Location plus
  pnpm install
  pnpm run check
  ```

- **Tests** (PostgreSQL required; `REQUIRE_DB=1` makes database tests fail instead of
  silently skipping):

  ```powershell
  $env:ARTFLOW_PLUS_DATABASE_URL = "postgresql://artflow:artflow_dev@127.0.0.1:5433/artflow_plus"
  $env:REQUIRE_DB = "1"
  pnpm run test
  pnpm run schema:check
  ```

- **Schema source of truth**: migrations are the source.
  `pnpm --filter @artflow-plus/db run schema:snapshot` writes
  `packages/db/schema.snapshot.json` from a disposable migrated schema;
  `pnpm --filter @artflow-plus/db run schema:types` derives `packages/db/src/types.ts`
  from that snapshot.
  `schema:check` fails when either artifact is stale, so do not edit the snapshot or
  the row types by hand. Add migrations under `packages/db/src/migrations/` and keep
  the ordered list in `migrations.ts`.
- **Contract and audit tooling** (development/CI only, never in runtime images):

  ```powershell
  pnpm -C plus --filter @artflow-plus/contract-tools run test
  pnpm -C plus --filter @artflow-plus/contract-tools run graph:check
  pnpm -C plus --filter @artflow-plus/contract-tools run audit:check
  pnpm -C plus --filter @artflow-plus/contract-tools run mutation:audit
  ```

  The contract suite includes the fast-check lifecycle model and the data-driven
  journey specs under `plus/tools/contracts/journeys/`.

- **Run locally**: `pnpm --filter @artflow-plus/api start` (migrates on start,
  default `127.0.0.1:3000`) and `pnpm --filter @artflow-plus/web dev` (Vite proxies
  `/api`). Set `ARTFLOW_PLUS_INLINE_RELAY=1` to run the outbox relay inside the API
  process (single-process deployments and E2E); production uses the separately
  built `plus-worker` image and keeps the API value at `0`.
- **First organizer**: `/login` only self-registers a participant. It does not
  grant Studio, Ops, or Live. After the database has been migrated (the script
  migrates on its own, and so does API startup), create the operator account:

  ```powershell
  $env:ARTFLOW_PLUS_DATABASE_URL = "postgresql://artflow:artflow_dev@127.0.0.1:5433/artflow_plus"
  $env:ARTFLOW_PLUS_ACCOUNT_PASSWORD = "<at least 8 characters; do not commit>"
  pnpm --filter @artflow-plus/api create-account --username organizer
  ```

  The password is read from `ARTFLOW_PLUS_ACCOUNT_PASSWORD` so it does not have
  to appear in the command line. Running the command again updates that
  username. The default permission set covers Studio, registration review,
  roster finalization, competition, judge entry, ticketing, voting, results,
  archive, materials, and attendance. Pass `--permissions a,b` to replace that
  set, or `--roles` to replace the default `admin` role. Production runs the
  same command against the production database URL with a secret-managed
  password. Do not reuse the development password.
- **Production proxy boundary**: `ARTFLOW_PLUS_TRUST_PROXY` is an explicit,
  comma-separated list of internal proxy IPs/CIDRs. It defaults to empty, so
  public `X-Forwarded-For` headers cannot change rate-limit identity. The Plus
  Nginx/Caddy transport ceiling is 128 MiB; released material policies remain the
  domain authority below that ceiling.
- **Deployment**: `deploy/compose.production.yml` runs `plus-db`, `plus-api`,
  `plus-worker`, `plus-web`, and Caddy against the three digest-pinned Plus images.
  Copy `.env.production.example` and replace every placeholder. Backups and restores
  follow [`docs/artflow-plus/backup-restore.md`](artflow-plus/backup-restore.md).

## Gate tooling

Python is used only for structural and documentation gates:

```powershell
uv sync --locked --extra dev
uv run pytest tests/gates -q
uv run python tests/golden/validate_fixtures.py
uv run ruff check tests/gates tests/golden scripts/tests
pwsh -NoProfile -File scripts/check_docs.ps1
```

The gates cover the Plus capability boundary (`GATE-PLUS-BOUNDARY-01`), the realtime
core (`GATE-REALTIME-CORE-01`), the HTTP route-module boundary, the schema drift check,
release artifacts, and tracked-artifact safety. They do not import Django.

## Local PostgreSQL

The dev container is disposable; it stores only local development data:

```powershell
docker run -d --name artflow-plus-postgres --restart unless-stopped `
  -e POSTGRES_USER=artflow -e POSTGRES_PASSWORD=artflow_dev -e POSTGRES_DB=artflow_plus `
  -p 127.0.0.1:5433:5432 -v artflow-plus-postgres:/var/lib/postgresql postgres:18.6
```

PostgreSQL 18 images must mount `/var/lib/postgresql` (not `/var/lib/postgresql/data`);
otherwise startup reports an unused mount.

## Browser E2E

The browser suite uses the isolated `artflow_e2e` schema and `workers: 1`:

```powershell
pnpm --filter @artflow-plus/web exec playwright install --with-deps chromium
pnpm --filter @artflow-plus/web test:e2e
```

The E2E seed command populates the public result, registration, live, grouping, and
voting journeys. It never touches the development schema.

## Troubleshooting

- If `pnpm install --frozen-lockfile` fails, do not edit the lockfile by hand; restore
  the expected lockfile or regenerate it intentionally with `pnpm install`.
- If the API cannot connect, check `ARTFLOW_PLUS_DATABASE_URL` and that
  `artflow-plus-postgres` is listening on `127.0.0.1:5433`.
- If `schema:check` fails, compare `plus/packages/db/src/types.ts` with
  `plus/packages/db/src/migrations.ts`; the gate reports the table/column/nullability
  difference.
- If the worker healthcheck fails, check that `startWorker` wrote
  `/tmp/artflow-worker-ready` and that pg-boss can reach the database.
- If migrations are unapplied, start the API once (it migrates on start) or run the
  migration path through the API/worker boot.

## Security and source control

Never commit `.env`, credentials, database files, uploads, exports, archives, or
generated media. Examples use placeholders only; replace them locally or through
deployment secret management. Private material bytes and archive packages are served
only through the controlled Plus APIs.

Work on a short-lived branch from the clean, updated `main`; verify and commit the
scoped change on that branch. The integration owner performs the non-fast-forward merge
into `main` after verification. See [repository instructions](../AGENTS.md) for the
repository-wide workflow rules.
