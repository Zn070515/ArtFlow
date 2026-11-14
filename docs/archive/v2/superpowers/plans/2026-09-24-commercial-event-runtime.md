# Commercial Event Runtime Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a safe Windows/Docker event launcher that keeps loopback-only operation as the default and explicitly supports same-LAN phone access.

**Architecture:** Parameterize only the host-side event port publication and the Django host allow-list in `deploy/compose.event.yml`. A PowerShell launcher selects validated values in the current process, starts the existing Compose stack, runs the existing read-only `doctor` command and health endpoint check, then prints access URLs; it never persists secrets or changes database authority.

**Tech Stack:** PowerShell 7/Windows PowerShell, Docker Compose, PostgreSQL, Django management command, pytest static contract tests, YAML parsing.

**Spec:** `docs/superpowers/specs/2026-09-24-commercial-event-runtime.md`

## Global Constraints

- Default event bind address is `127.0.0.1`; LAN exposure requires explicit `-Lan`.
- Do not change competition models, scoring, permissions, result authority, or public release behavior.
- Do not publish PostgreSQL, create a public tunnel, claim HTTPS/DDoS protection, or modify Windows Firewall silently.
- Do not write `.env.event`, credentials, passwords, tokens, or generated configuration files.
- Do not run `docker compose down --volumes`, reset commands, or destructive database commands.
- Keep every logical change in a small conventional commit and verify it before committing.
- Execute inline in the current checkout; do not spawn subagents or create worktrees.

---

### Task 1: Add red tests for the event runtime contract

**Files:**
- Create: `scripts/tests/test_event_runtime_contract.py`
- Modify: `tests/test_production_compose_config.py`

**Interfaces:**
- Consumes: `deploy/compose.event.yml`, the future `scripts/start-event.ps1`, and `.env.event.example`.
- Produces: executable static contract coverage for manifest interpolation, launcher safety, and the event environment template.

- [ ] **Step 1: Write the failing manifest assertions**

Add tests that assert the event manifest contains:

```python
assert web_environment["ALLOWED_HOSTS"] == "${ARTFLOW_EVENT_ALLOWED_HOSTS:-localhost,127.0.0.1}"
assert compose["services"]["web"]["ports"] == [
    "${ARTFLOW_EVENT_BIND_ADDRESS:-127.0.0.1}:${ARTFLOW_EVENT_PORT:-8000}:8000"
]
```

Keep the existing assertions that PostgreSQL has no published ports, the internal network is marked `internal`, and the event manifest contains no tunnel or IPv6 configuration.

- [ ] **Step 2: Write the failing launcher contract assertions**

Read `scripts/start-event.ps1` as text and assert it contains `-Lan`, the three `ARTFLOW_EVENT_*` variables, `docker compose`, `up --build --wait`, `manage.py doctor`, and `/healthz/`. Assert it does not contain `down --volumes`, `New-NetFirewallRule`, or `cloudflared`. Also assert the validation function names/messages cover invalid ports, loopback overrides, APIPA addresses, and malformed host input.

- [ ] **Step 3: Write the failing event environment template assertions**

Assert `.env.event.example` contains the required secret names and `ARTFLOW_ORGANIZATION_NAME`, but no actual password-like value, `ARTFLOW_EVENT_BIND_ADDRESS=0.0.0.0`, or LAN address.

- [ ] **Step 4: Run the focused tests and verify RED**

Run:

```powershell
python -m pytest scripts/tests/test_event_runtime_contract.py tests/test_production_compose_config.py -q
```

Expected: failure because the new manifest interpolation, launcher, and template do not yet exist.

- [ ] **Step 5: Commit the red-test-only change**

```powershell
git add scripts/tests/test_event_runtime_contract.py tests/test_production_compose_config.py
git commit -m "test: define commercial event runtime contract"
```

### Task 2: Parameterize the event Compose manifest

**Files:**
- Modify: `deploy/compose.event.yml:31-45`

**Interfaces:**
- Consumes: launcher-selected process environment values and `.env.event` values.
- Produces: a Compose manifest whose default rendering remains loopback-only and whose LAN rendering changes only host publication and Django host validation.

- [ ] **Step 1: Implement exact interpolation**

Change only the event web environment and port mapping to:

```yaml
      ALLOWED_HOSTS: ${ARTFLOW_EVENT_ALLOWED_HOSTS:-localhost,127.0.0.1}
    ports:
      - "${ARTFLOW_EVENT_BIND_ADDRESS:-127.0.0.1}:${ARTFLOW_EVENT_PORT:-8000}:8000"
```

Keep all existing database, rate-limit, healthcheck, volume, and network settings unchanged.

- [ ] **Step 2: Run the focused manifest tests**

Run:

```powershell
python -m pytest tests/test_production_compose_config.py::test_event_compose_defaults_to_loopback_and_keeps_database_private tests/test_production_compose_config.py::test_compose_manifests_forward_optional_branding_to_web -q
```

Expected: PASS for the parameterized default contract.

- [ ] **Step 3: Commit the manifest change**

```powershell
git add deploy/compose.event.yml tests/test_production_compose_config.py
git commit -m "feat: parameterize local event host binding"
```

### Task 3: Implement the validated event launcher

**Files:**
- Create: `scripts/start-event.ps1`
- Modify: `scripts/tests/test_event_runtime_contract.py`

**Interfaces:**
- Consumes: `.env.event`, `deploy/compose.event.yml`, Docker Compose, and `-Lan`, `-Port`, `-HostAddress` parameters.
- Produces: a process-local launcher that starts the event runtime, executes diagnostics, and prints `http://127.0.0.1:<port>/` plus the LAN URL when enabled.

- [ ] **Step 1: Implement parameter validation before Docker invocation**

Use strict PowerShell mode and define `-Lan`, a `[ValidateRange(1024, 65535)] [int]$Port = 8000`, and an optional `[string]$HostAddress`. Reject supplied loopback, APIPA, non-IPv4, and malformed addresses. In LAN mode, detect one usable local IPv4 address when `-HostAddress` is omitted. In non-LAN mode, select only `localhost,127.0.0.1`.

- [ ] **Step 2: Implement process-local Compose startup**

Set only child-process environment variables:

```powershell
$env:ARTFLOW_EVENT_BIND_ADDRESS = if ($Lan) { "0.0.0.0" } else { "127.0.0.1" }
$env:ARTFLOW_EVENT_PORT = [string]$Port
$env:ARTFLOW_EVENT_ALLOWED_HOSTS = $allowedHosts
```

Invoke `docker compose --env-file .env.event -f deploy/compose.event.yml up --build --wait` and then `docker compose --env-file .env.event -f deploy/compose.event.yml exec -T web python manage.py doctor`. Propagate non-zero exit codes. Never call `down`, `down --volumes`, seed reset, or database deletion.

- [ ] **Step 3: Implement health verification and safe output**

Request `http://127.0.0.1:<Port>/healthz/`, fail unless it returns HTTP 200 and `{"status":"ok"}`, and print only mode and URLs plus the Private-network Firewall note. Never print environment values, secrets, or command output containing them.

- [ ] **Step 4: Run the focused launcher contract tests**

Run:

```powershell
python -m pytest scripts/tests/test_event_runtime_contract.py -q
```

Expected: PASS with no warnings.

- [ ] **Step 5: Commit the launcher**

```powershell
git add scripts/start-event.ps1 scripts/tests/test_event_runtime_contract.py
git commit -m "feat: add safe local event launcher"
```

### Task 4: Add the event environment template and user documentation

**Files:**
- Create: `.env.event.example`
- Create: `docs/deployment-event.md`
- Modify: `README.md:24-82`
- Modify: `docs/development-baseline.md:31-95`

**Interfaces:**
- Consumes: `scripts/start-event.ps1`, `deploy/compose.event.yml`, and the first-admin provisioning command.
- Produces: purchaser-facing instructions distinguishing loopback event mode, LAN event mode, and production HTTPS deployment.

- [ ] **Step 1: Add a non-secret `.env.event.example`**

Include `SECRET_KEY`, `ADMIN_LOGIN_KEY`, PostgreSQL settings, and optional branding with `change-me` placeholders. Do not include a provisioning password, LAN bind value, arbitrary host list, or public hostname.

- [ ] **Step 2: Document the exact event workflow**

Document copying the template, replacing secrets, starting loopback mode, opting into LAN mode, passing `-HostAddress` for multiple adapters, provisioning the first admin, and interpreting `doctor` failures. State that the launcher does not change Firewall rules or provide Internet protection and that volumes are preserved.

- [ ] **Step 3: Link the event workflow from existing entry docs**

Replace the current manual event startup paragraph with links to `docs/deployment-event.md` and the launcher command while preserving the production manifest warning and first-admin security requirements.

- [ ] **Step 4: Run documentation and contract tests**

Run:

```powershell
python -m pytest scripts/tests/test_event_runtime_contract.py tests/test_production_compose_config.py -q
pwsh -NoProfile -File scripts/check_docs.ps1
```

Expected: PASS; documentation must not require a secret or a school-specific organization.

- [ ] **Step 5: Commit the documentation slice**

```powershell
git add .env.event.example docs/deployment-event.md README.md docs/development-baseline.md
git commit -m "docs: document commercial event deployment"
```

### Task 5: Verify, self-review, merge, and publish

**Files:**
- Modify: `docs/superpowers/plans/2026-09-24-commercial-event-runtime.md` (checkboxes and verification notes only)

**Interfaces:**
- Consumes: all P0-B implementation outputs.
- Produces: a verified `main` commit with remote CI evidence and Docker volumes preserved.

- [ ] **Step 1: Run static and focused gates**

Run focused tests, `python manage.py check`, `python manage.py makemigrations --check --dry-run`, Ruff, both Pyright gates, client checks, and documentation checks before the final commit.

- [ ] **Step 2: Render both event modes without starting or deleting services**

Render the default Compose configuration, then render with process-local `ARTFLOW_EVENT_BIND_ADDRESS=0.0.0.0`, `ARTFLOW_EVENT_PORT=18180`, and `ARTFLOW_EVENT_ALLOWED_HOSTS=localhost,127.0.0.1,192.168.1.10`. Confirm only web binding changes and PostgreSQL remains unpublished; clear the three process variables afterwards.

- [ ] **Step 3: Run existing Docker acceptance and safe browser smoke**

Run `verify_postgres_acceptance.ps1 -StartCompose -VerifyResetSafety`, `verify_postgres_backup_restore.ps1`, and the safe runtime/ticket Playwright subset. Do not delete volumes or fabricate missing Judge fixtures.

- [ ] **Step 4: Perform two self-reviews**

Review 1 checks loopback default, explicit LAN opt-in, exact `ALLOWED_HOSTS`, no secret output, no firewall/tunnel, no database publication, no destructive Compose operation, and no authority files changed.

Review 2 checks `.env.event.example`/launcher/Compose consistency, Compose precedence, pre-Docker input rejection, diagnostic failure propagation, event/production documentation separation, and preserved Docker volumes.

- [ ] **Step 5: Update the plan, commit, merge, and push**

Record command results in the plan, run `git diff --check`, commit the verification notes, merge the feature branch into `main` with `--no-ff`, and push through `127.0.0.1:12334` if the direct push times out. Keep the feature branch until local and remote status are confirmed.

## Execution record

- [x] Wrote the contract tests first and observed the expected RED result: 3 missing-implementation failures.
- [x] Parameterized the event Compose manifest while preserving loopback defaults, private PostgreSQL, database rate limiting, volumes, and internal networking.
- [x] Added `scripts/start-event.ps1` with explicit `-Lan`, validated port/address inputs, process-local Compose variables, `doctor`, health verification, safe output, and no destructive operations.
- [x] Added tracked `.env.event.example` with placeholders only and purchaser-facing event deployment documentation.
- [x] Focused contract and Compose tests: 13 passed.
- [x] Documentation check: 18 user-facing Markdown files passed.
- [x] Django checks and migration checks passed; Ruff lint and format checks passed; project and entry-access Pyright reported zero diagnostics; client compile and 25 client tests passed.
- [x] Host Django test suite passed: 1181 tests, 29 skipped.
- [x] Docker PostgreSQL acceptance passed: 1181 tests, 3 skipped; services and volumes left intact.
- [x] PostgreSQL backup/restore passed against an isolated restore target; source database and volumes were not reset.
- [x] Safe Playwright runtime/ticket smoke passed: 3 tests.
- [x] Compose render review passed: default `127.0.0.1:8000`; explicit LAN example `0.0.0.0:18180` with only `192.168.1.10` added to `ALLOWED_HOSTS`; PostgreSQL remained unpublished.
- [x] Launcher preflight review passed: missing `.env.event` failed before Docker invocation; PowerShell parser reported no syntax errors.
- [x] Self-review 1 (authority/security): no competition authority files changed; loopback is default; LAN requires `-Lan`; no database publication, tunnel, firewall mutation, secret output, reset, or volume deletion was introduced.
- [x] Self-review 2 (semantic/operations): template, launcher, Compose precedence, diagnostics, health URL, docs, and volume-preservation behavior were checked against the spec; host input trimming was added and covered by a RED→GREEN test.
