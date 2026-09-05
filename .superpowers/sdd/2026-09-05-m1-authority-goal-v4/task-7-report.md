# Task 7 Report — Explicit Production and Event Compose Contracts

## Status

Implemented and committed on `build/m1-authority-goal-v4` as `61ca9c3 build: add explicit production and event compose contracts`. The root `docker-compose.yml` was not changed and remains the development/integration contract. No production service was started, stopped, or torn down.

## Delivered files

- Created `deploy/compose.production.yml`: production-only Django/PostgreSQL/Caddy topology with `APP_ENV=production`, environment-injected secrets, private database network, persistent PostgreSQL/media/static volumes, database and web health checks, Caddy TLS/reverse-proxy boundary, and no published `web` or database port.
- Created `deploy/compose.event.yml`: one-primary-machine, localhost-only event contract (`127.0.0.1:8000`), private PostgreSQL network, persistent database/media/static volumes, and environment-injected event credentials/host settings.
- Created `tests/test_production_compose_config.py`: parses the real Compose manifests, checks the production authority/network/volume/proxy boundary and runbook reference, and runs `docker compose ... config --quiet` without starting services when Docker is installed.
- Updated `scripts/verify.ps1` with a production manifest structural gate and `docker compose -f deploy/compose.production.yml config --quiet` after injecting non-placeholder verification settings. The script does not invoke production `up`, `down`, or volume teardown.
- Updated `.env.production.example`, `README.md`, `docs/deployment-production.md`, `docs/development-baseline.md`, and `docs/production-rehearsal-runbook.md` with the explicit contracts, Caddy DNS/TLS setting, event ingress constraints, single-primary authority, and independent PowerPoint guidance.

## TDD evidence

RED command:

```text
python -m pytest tests -k "production or compose" -q
.FFFF                                                                    [100%]
4 failed, 1 passed, 14 deselected in 3.09s
```

The four failures were the intended absent production manifest, absent event manifest, absent runbook manifest reference, and missing Compose config target.

GREEN command:

```text
python -m pytest tests -k "production or compose" -q
.....                                                                    [100%]
5 passed, 14 deselected in 3.01s
```

## Final verification output

```text
python -m pytest tests/test_production_compose_config.py tests/test_postgres_acceptance_script.py tests/test_check_docs.py -q
...................                                                      [100%]
19 passed in 11.11s

pwsh -NoProfile -File scripts/check_docs.ps1
Documentation validation passed for 11 user-facing Markdown file(s); docs/superpowers was skipped.

docker compose -f deploy/compose.production.yml config --quiet
[exit 0; no output]

python manage.py check --deploy --fail-level WARNING
System check identified no issues (0 silenced).

git diff --check
[exit 0; only existing CRLF conversion warnings]
```

The expanded verifier was also run:

```text
pwsh -NoProfile -File scripts/verify.ps1
Found 59 errors.
Verification failed.
```

This is an existing repository-wide Ruff baseline: its output identifies unrelated files such as `accounts/admin.py`, `common/test_authority_matrix.py`, `core/models.py`, `singer_contest/tests.py`, and `voting/models.py`. It also initially flagged the new test import order; that new-file issue was corrected and `python -m ruff check tests/test_production_compose_config.py` now reports `All checks passed!`.

## Self-review

- `web` and `db` in the production manifest have no `ports`; only Caddy publishes `80/443`.
- PostgreSQL and web are only on the `internal: true` network; Caddy is the sole bridge between public ingress and that network.
- Production secrets and database password use required Compose environment interpolation; the root development password is absent.
- Database and media named volumes are persistent. Caddy certificate/config volumes are also persistent.
- Event documentation explicitly states localhost operation, optional controlled tunnel/IPv6 ingress, one writable server/database, no cloud authority, and independent PowerPoint.
- Root Compose and application authority semantics were left untouched.

## Concerns

- The full `scripts/verify.ps1` cannot be green until the pre-existing repository-wide Ruff failures are addressed; this task deliberately did not reformat unrelated code.
- A real production deployment still needs an operator-supplied DNS name, publicly reachable ACME `80/443`, and non-placeholder secrets in an ignored `.env.production`; config validation intentionally does not start that stack.

## Fix round 1 — reviewer findings

### Changes

- Escaped the Caddy environment reference as `{$$CADDY_SITE_ADDRESS}` in `deploy/compose.production.yml`. Compose now preserves the placeholder in rendered config for Caddy to expand at runtime; it no longer renders `{artflow.internal}` as the Caddy site label.
- Aligned `.env.production.example` with manifest-fixed values: `TRUST_X_FORWARDED_FOR=true` and `POSTGRES_HOST=db`. Deployment documentation and the rehearsal runbook now state these constraints and explain that Caddy is the trusted header-overwriting proxy and `db` is the private Compose service name.
- Added regression coverage for rendered Compose config, manifest-fixed env values, and Caddy adaptation of the rendered Caddyfile when the Caddy image is locally available.

### Fix-round evidence

The new rendered-config regression first failed against the old manifest with:

```text
expected `{$CADDY_SITE_ADDRESS} {}`, got `{artflow.internal} {}`
```

After the fix:

```text
python -m pytest tests/test_production_compose_config.py tests/test_postgres_acceptance_script.py tests/test_check_docs.py -q
21 passed, 1 skipped
docker compose -f deploy/compose.production.yml config --quiet
[exit 0]
python manage.py check --deploy --fail-level WARNING
System check identified no issues (0 silenced).
pwsh -NoProfile -File scripts/check_docs.ps1
Documentation validation passed for 11 user-facing Markdown file(s); docs/superpowers was skipped.
python -m ruff check tests/test_production_compose_config.py
All checks passed!
git diff --check
[exit 0; existing LF/CRLF conversion warnings only]
```

The optional Caddy adaptation regression was skipped because `caddy:2-alpine` was not present locally; no image pull or service startup was performed. Self-review confirms the root development Compose file and application authority code were not changed, and the final diff is limited to the production manifest, production env/docs, regression test, and this report.

## Final fix verification rerun

Rechecked the actual production manifest and env/documentation files, without invoking the broad `scripts/verify.ps1` gate:

```text
python -m pytest tests/test_production_compose_config.py tests/test_postgres_acceptance_script.py tests/test_check_docs.py -q
21 passed, 1 skipped
docker compose -f deploy/compose.production.yml config --quiet
[exit 0]
python manage.py check --deploy --fail-level WARNING
System check identified no issues (0 silenced).
pwsh -NoProfile -File scripts/check_docs.ps1
Documentation validation passed for 11 user-facing Markdown file(s); docs/superpowers was skipped.
git diff --check
[exit 0]
```

The Caddy image-dependent adaptation check remains skipped only because `caddy:2-alpine` is not locally available. The production file contains the escaped `{$$CADDY_SITE_ADDRESS}` interpolation, while the env template and runbook document manifest-fixed `TRUST_X_FORWARDED_FOR=true` and `POSTGRES_HOST=db`.

## Fix round 2 — Caddy interpolation

### Changes

- Replaced the interpolated inline Caddy config with the file-backed `deploy/Caddyfile` config.
- The mounted/rendered Caddyfile now contains exactly `{$CADDY_SITE_ADDRESS}`; Compose cannot rewrite or retain a double-dollar escape in that payload.
- Updated the regression to inspect the unmodified file-backed rendered config and pass that exact content to Caddy adaptation. The manual `$$` replacement was removed.
- Preserved the existing production env documentation alignment and all service, network, port, volume, healthcheck, and authority constraints.

### Fix-round evidence

```text
python -m pytest tests/test_production_compose_config.py tests/test_postgres_acceptance_script.py tests/test_check_docs.py -q
21 passed, 1 skipped in 8.88s

pwsh -NoProfile -File scripts/check_docs.ps1
Documentation validation passed for 11 user-facing Markdown file(s); docs/superpowers was skipped.

docker compose -f deploy/compose.production.yml config --quiet
[exit 0; no output]

python -m ruff check tests/test_production_compose_config.py
All checks passed!

git diff --check
[exit 0; existing LF/CRLF conversion warnings only]
```

The Caddy adaptation test remains skipped because `caddy:2-alpine` is not available locally; no image pull or service startup was performed.

### Self-review

- `deploy/Caddyfile` is the only source for the production proxy config and has one single-dollar Caddy environment placeholder.
- The production Compose manifest still publishes only Caddy ports `80/443`; `web` and `db` remain private on the internal network.
- Existing env-template documentation alignment (`TRUST_X_FORWARDED_FOR=true`, `POSTGRES_HOST=db`) is unchanged.
- No root development Compose file, application authority code, event topology, or unrelated documentation was changed.
- Scoped diff consists only of the production config source, its regression, and this report.
