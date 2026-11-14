# M2 Toolchain Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add scoped Python typing and reproducible Playwright runtime gates, then make future M2 browser capabilities expand those gates without a broad rewrite.

**Architecture:** Keep Django/PostgreSQL authoritative. Add Playwright as a CI integration companion to the existing Compose web service, and add a separate Pyright project for `entry_access` production code while retaining the existing gradual whole-project baseline. TypeScript remains additive and begins with the M2-B Judge Terminal.

**Tech Stack:** Python 3.12, Django 6, PostgreSQL 16, mypy, Pyright, Node 22, TypeScript 7, `@playwright/test` 1.63.0, Chromium, GitHub Actions, Docker Compose.

**Spec:** `docs/superpowers/specs/2026-09-07-toolchain-hardening-design.md`

## Global Constraints

- Do not use `.worktree/`, `worktrees/`, or linked worktrees.
- Work directly on a short-lived branch from an up-to-date clean `main`.
- Do not migrate the Django monolith, introduce a SPA, or add a second authority database.
- Browser tests use disposable local/CI services only; no real credentials or production URLs.
- Credential-bearing browser tests must not emit raw bearer tokens into artifacts.
- Keep every independently verifiable change in its own small conventional commit.
- `main` is merged with `--no-ff` and pushed only after the branch gates pass.

---

### Task 1: Add the scoped Python typing gates

**Files:**
- Create: `pyrightconfig.entry-access.json`
- Modify: `pyproject.toml`
- Modify: `package.json`
- Modify: `entry_access/models.py`
- Modify: `entry_access/services.py`
- Modify: `entry_access/views.py`
- Modify: `entry_access/tests.py` only for test typing where mypy requires it

**Produces:** `npm run check:pyright:entry-access` and the existing `uv run mypy` both cover the new app without changing runtime behaviour.

- [ ] **Step 1: Write the failing gate configuration and run it**

Create `pyrightconfig.entry-access.json` with `extends: "./pyrightconfig.json"`,
`include: ["entry_access"]`, and excludes for `entry_access/tests.py`,
`entry_access/migrations`, `tests`, `static`, `staticfiles`, and `media`. Add
the npm script `check:pyright:entry-access` invoking
`uv run pyright -p pyrightconfig.entry-access.json`. Run it and record the
current Django-generated relation-attribute diagnostics as the expected red
state.

Run: `npm run check:pyright:entry-access`

Expected: FAIL only on the new app's current dynamic Django relation attributes.

- [ ] **Step 2: Add narrow framework-boundary typing fixes**

Replace dynamic relation-ID reads with typed helper access or narrow
`# type: ignore[attr-defined]` comments matching the repository's existing
pattern. Do not suppress the whole file or disable all Pyright diagnostics.
Use a real `HttpRequest` in the Admin safety test instead of passing `None`,
and fix the two model typing diagnostics without changing model authority
guards or lifecycle semantics.

- [ ] **Step 3: Include the app in blocking Python gates**

Add `entry_access` to the `tool.mypy.files` list and to the coverage `source`
list in `pyproject.toml`. Add it to Ruff's source list for configuration
consistency. Run `uv run mypy`, `uv run ruff check .`, and
`uv run pytest -q --cov`.

- [ ] **Step 4: Run the green gate set**

Run: `npm run check:pyright:entry-access; uv run mypy; uv run pytest -q --cov`

Expected: all commands exit 0 and coverage remains at least 75%.

- [ ] **Step 5: Commit**

```powershell
git add pyrightconfig.entry-access.json pyproject.toml package.json entry_access
git diff --cached --check
git commit -m "chore: add scoped entry access typing gates"
```

### Task 2: Add reproducible Playwright runtime smoke infrastructure

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`
- Create: `playwright.config.ts`
- Create: `tests/e2e/runtime-smoke.spec.ts`
- Modify: `.gitignore` if Playwright output needs an explicit ignored directory
- Modify: `docs/development-baseline.md`

**Produces:** `npm run test:e2e` runs a browser against `PLAYWRIGHT_BASE_URL`,
with a loopback default and no credential-bearing artifacts.

- [ ] **Step 1: Add the pinned dependency and failing smoke test**

Install `@playwright/test@1.63.0` as a dev dependency with `npm install
--save-dev --save-exact @playwright/test@1.63.0`. Create a smoke test that
opens `/healthz/`, asserts HTTP 200, and asserts the body contains the minimal
health response. Use `page.goto`, not only an API request, so the browser path
is exercised.

- [ ] **Step 2: Add the safe Playwright configuration**

Configure `testDir: "tests/e2e"`, `baseURL` from
`PLAYWRIGHT_BASE_URL` with default `http://127.0.0.1:8000`, Chromium project,
`forbidOnly` in CI, one retry in CI, and `trace: "retain-on-failure"` for the
read-only smoke suite. Set `outputDir` to an ignored `test-results/playwright`
directory. Add `test:e2e` to run `playwright test`.

- [ ] **Step 3: Verify local runtime smoke**

Run the existing service with `docker compose up --build --wait`, then run:
`npm ci; npx playwright install chromium; npm run test:e2e`.

Expected: the browser smoke test passes against `http://127.0.0.1:8000`.

- [ ] **Step 4: Document the command and artifact boundary**

Add the install and run commands to `docs/development-baseline.md`. State that
future token-bearing specs must set `trace: "off"` and must never upload raw
credentials in screenshots, traces, videos, or test output.

- [ ] **Step 5: Commit**

```powershell
git add package.json package-lock.json playwright.config.ts tests/e2e docs/development-baseline.md .gitignore
git diff --cached --check
git commit -m "test: add Playwright runtime smoke gate"
```

### Task 3: Wire the gates into CI's existing integration stack

**Files:**
- Modify: `.github/workflows/ci.yml`
- Modify: `.github/workflows/integration.yml`
- Modify: `AGENTS.md`
- Modify: `docs/development-baseline.md`

**Produces:** CI runs the scoped Pyright gate with quality checks and runs
Playwright after the existing PostgreSQL Compose health gate, without starting
another database or changing volume cleanup semantics.

- [ ] **Step 1: Add the scoped Pyright command to CI**

Add `npm run check:pyright:entry-access` after Node/npm setup in the SQLite
quality job. Keep the existing non-blocking whole-project `check:pyright`
description unchanged unless its scope is independently expanded later.

- [ ] **Step 2: Add Playwright to the PostgreSQL integration job**

Set up Node 22 with npm cache, run `npm ci`, install Chromium with
`npx playwright install --with-deps chromium`, then run
`PLAYWRIGHT_BASE_URL=http://127.0.0.1:8000 npm run test:e2e` after the published
web health check. Keep the existing final `docker compose down` (without
`--volumes`) and do not add a second service.

- [ ] **Step 3: Verify workflow and documentation contracts**

Run `pwsh -NoProfile -File scripts/check_docs.ps1`,
`uv run python scripts/verify_workflows.py .github/workflows`,
`npm run check:client`, `npm run test:client`, and inspect the
workflow diff to ensure no secret or production URL enters the test command.

- [ ] **Step 4: Commit**

```powershell
git add .github/workflows/ci.yml .github/workflows/integration.yml AGENTS.md docs/development-baseline.md
git diff --cached --check
git commit -m "ci: enforce progressive M2 quality gates"
```

### Task 4: Add the progressive gate contract for M2-B

**Files:**
- Modify: `docs/development-baseline.md`
- Modify: `docs/production-readiness.md`
- Modify: `GOAL.md` only if the current M2 checklist needs a direct gate reference

**Produces:** A maintained capability-to-gate matrix that prevents a new
Judge/Ticket capability from being called Production without browser,
PostgreSQL, recovery, and fallback coverage appropriate to its risk.

- [ ] **Step 1: Add the gate matrix and phase rules**

Document the M2-A baseline gates, the additional JudgeSeat/Ticket/direct-score
gates, the rule that credential-bearing browser specs disable traces, and the
rule that every new capability adds gates without removing previous ones.

- [ ] **Step 2: Validate documentation and commands**

Run `pwsh -NoProfile -File scripts/check_docs.ps1`,
`uv run python manage.py check`, and `git diff --check`.

- [ ] **Step 3: Commit**

```powershell
git add docs/development-baseline.md docs/production-readiness.md GOAL.md
git diff --cached --check
git commit -m "docs: define progressive M2 gate coverage"
```

### Task 5: Two-pass review and integration

**Files:**
- Review only; no new files unless a review finding requires a separate fix commit.

- [ ] **Step 1: Contract and semantic review**

Compare the implementation against the design: existing M1 gates remain,
Pyright scope is explicit, mypy sees `entry_access`, Playwright targets only
disposable loopback services, and gate coverage grows by capability.

- [ ] **Step 2: Security and logic review**

Search for raw tokens in Playwright logs/artifacts, production URLs, external
credentials, trace/video retention on bearer-token specs, accidental second
databases, unsafe Docker volume cleanup, and CI steps that bypass existing
health/migration checks.

- [ ] **Step 3: Full verification**

Run:

```powershell
uv run python manage.py check
uv run python manage.py makemigrations --check --dry-run
uv run ruff check .
uv run ruff format --check .
uv run mypy
uv run pytest -q --cov
npm ci
npm run check:client
npm run test:client
npm run check:pyright:entry-access
npx playwright install chromium
npm run test:e2e
pwsh -NoProfile -File scripts/check_docs.ps1
docker compose up --build --wait
docker compose exec -T web python manage.py test
```

- [ ] **Step 4: Commit any review fixes independently**

Use `fix:` or `test:` commits with only the files needed for the finding.

- [ ] **Step 5: Merge and push**

After a clean branch and verified remote state, merge
`build/toolchain-hardening` into `main` with `git merge --no-ff`, push
`origin/main`, verify `git ls-remote`, and then delete the local feature
branch. If push times out, retry through `http://127.0.0.1:12334` as required
by `AGENTS.md`.
