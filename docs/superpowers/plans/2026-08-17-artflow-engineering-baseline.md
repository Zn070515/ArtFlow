# ArtFlow Engineering Baseline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将已批准的 ArtFlow 工程化基线落地为可锁定、可验证、可在 SQLite/PostgreSQL 和 Windows/Linux 上重复运行的 Django 服务开发体系。

**Architecture:** 继续使用一个 Django 单体和一个 `config.settings` 入口，通过 `APP_ENV` 区分 development/test/production。`pyproject.toml` 与 `uv.lock` 成为依赖和工具配置单一来源；Docker Compose 提供 PostgreSQL/Web/静态文件/媒体卷；CI 分成纯 SQLite、PostgreSQL 集成、Windows 矩阵、安全扫描和 workflow lint。

**Tech Stack:** Django 6.0.6, Python 3.12/3.13, uv, PostgreSQL, Docker Compose, pytest/pytest-django/pytest-cov, Ruff, mypy/django-stubs, gunicorn（仅 production/container extra）, GitHub Actions, actionlint, pip-audit, CodeQL, gitleaks。

**Spec:** `docs/superpowers/specs/2026-08-17-artflow-engineering-baseline-design.md`

## Global Constraints

- 不使用 linked worktree；全部工作在 `build/engineering-baseline` 分支完成，验证后 `git merge --no-ff` 回 `main` 并 push。
- Python 命令使用 `uv run`；当前机器没有 `rtk` 时直接运行命令并记录 fallback。
- 既有 URL、权限、活动/轮次/投票锁定、审计、受控媒体访问和正式数据语义不得回退。
- 只有显式 `-SeedDemoData` 才写入演示业务数据；默认 bootstrap 不写业务数据。
- `seed_demo_data --reset` 只能清理带 `is_test_data=True` 或 `is_test=True` 的运行数据；无测试标记的 seed 配置只更新不删除。
- 生产配置不得回退 SQLite，不得使用开发密钥、明文命令行密码或默认公网数据库绑定。
- 新行为先写失败测试再写实现；纯配置文件、workflow、Dockerfile 和文档按配置验证命令验证。
- 每个任务结束后运行该任务的验证命令，提交只包含该任务的文件。

---

### Task 1: 建立 uv 项目和质量工具单一来源

**Files:**
- Create: `pyproject.toml`
- Create: `.python-version`
- Create: `uv.lock`
- Modify: `requirements.txt`
- Modify: `.gitignore`
- Test: tool configuration commands, no application test change

**Interfaces:**
- Produces `uv sync --locked --extra dev` as the canonical development environment command.
- Produces `uv sync --locked --extra production` for the Linux container image.
- Produces `uv export --frozen --no-dev --no-emit-project` output for the compatibility `requirements.txt`.
- Configures pytest to use `DJANGO_SETTINGS_MODULE=config.settings`, collect `tests.py`, enable strict markers, and treat warnings as errors.

- [ ] **Step 1: Add project metadata and dependency groups**

  Create a non-package Django project definition with `requires-python = ">=3.12,<3.14"`. Move the current pinned runtime dependencies into `[project.dependencies]`; add `python-dotenv` for `.env` loading. Put `pytest`, `pytest-django`, `pytest-cov`, `ruff`, `mypy`, and `django-stubs` in the `dev` extra. Put `gunicorn` in a `production` extra guarded for non-Windows container use.

- [ ] **Step 2: Add tool configuration**

  Configure Ruff for Python 3.12, line length 100, source/test roots, and explicit migration/cache/media exclusions. Configure pytest with:

  ```toml
  DJANGO_SETTINGS_MODULE = "config.settings"
  python_files = ["tests.py", "test_*.py", "*_tests.py"]
  addopts = "-ra --strict-markers"
  filterwarnings = ["error"]
  ```

  Configure coverage to measure the ArtFlow apps while omitting migrations and generated media. Configure mypy with `django-stubs`, `strict = true` for `config`, `common`, `accounts/management`, and `public_portal/management`, and `check_untyped_defs = true` for existing business views without using global `ignore_errors`.

- [ ] **Step 3: Generate and verify the lock/export files**

  Run:

  ```powershell
  uv lock
  uv sync --locked --extra dev
  uv export --frozen --no-dev --no-emit-project -o requirements.txt
  uv run python -m compileall accounts archive common config core exports farewell_show files incidents public_portal singer_contest staff_panel voting
  ```

  Confirm the lock is reproducible and the exported requirements contain no local file URLs.

- [ ] **Step 4: Run the first tool baseline**

  Run `uv run pytest --collect-only -q`, `uv run ruff check .`, `uv run ruff format --check .`, and `uv run mypy`. Record every existing failure before changing application code; use the failures to define the next task's red tests.

- [ ] **Step 5: Commit**

  ```powershell
  git add pyproject.toml .python-version uv.lock requirements.txt .gitignore
  git commit -m "build: establish uv and quality toolchain"
  git push -u origin build/engineering-baseline
  ```

### Task 2: Make environment loading and production validation explicit

**Files:**
- Create: `config/runtime.py`
- Create: `config/checks.py`
- Create: `config/tests.py`
- Create: `.env.production.example`
- Create: `static/.gitkeep`
- Modify: `config/settings.py`
- Modify: `.env.example`
- Modify: `.gitignore`
- Test: `config/tests.py`

**Interfaces:**
- `config.runtime.load_environment(base_dir: Path) -> None` loads `.env` without overriding process environment variables.
- `config.runtime.get_app_env() -> Literal["development", "test", "production"]` rejects unknown values.
- `config.runtime.validate_production_environment(env: Mapping[str, str]) -> None` raises `ImproperlyConfigured` for missing or development-default production values.
- `config.checks.register_checks()` exposes configuration checks for `manage.py check`.

- [ ] **Step 1: Write failing runtime tests**

  Add tests proving: environment variables override `.env`; unknown `APP_ENV` is rejected; production rejects the development secret, empty admin key, missing hosts, missing CSRF origins, and SQLite; development defaults to SQLite; the missing `static/` warning is eliminated; and production values enable secure cookies, proxy SSL handling, and HSTS settings.

- [ ] **Step 2: Run the focused tests and verify red**

  Run `uv run pytest config/tests.py -q`. The tests must fail because the runtime loader and validators do not exist yet; fix collection/setup errors until the failures are about the requested behavior.

- [ ] **Step 3: Implement runtime loading and settings validation**

  Load dotenv with `override=False`, parse booleans/CSV values centrally, validate `APP_ENV`, and keep `config.settings` as the only Django settings entry. Use development SQLite defaults, test SQLite defaults, and require PostgreSQL plus all production security variables when `APP_ENV=production`. Never log or include secret values in exceptions.

- [ ] **Step 4: Run focused tests and Django checks**

  Run `uv run pytest config/tests.py -q`, `uv run python manage.py check`, and a production check with temporary process variables and `uv run python manage.py check --deploy --fail-level WARNING`. All must pass.

- [ ] **Step 5: Commit**

  ```powershell
  git add config .env.example .env.production.example static .gitignore
  git commit -m "build: add explicit environment contracts"
  git push origin build/engineering-baseline
  ```

### Task 3: Add healthz and the doctor command

**Files:**
- Create: `config/health.py`
- Create: `common/management/__init__.py`
- Create: `common/management/commands/__init__.py`
- Create: `common/management/commands/doctor.py`
- Create: `common/tests.py` additions
- Modify: `config/urls.py`
- Test: `config/tests.py`, `common/tests.py`

**Interfaces:**
- `GET /healthz/` returns `{"status": "ok"}` with HTTP 200 only when Django configuration and database access are healthy.
- `python manage.py doctor` returns 0 on a healthy configuration and nonzero on configuration/database/migration/static/media failure; it reports the already-loaded `APP_ENV` and never switches Django settings after startup.
- Doctor output contains environment name, database engine, migration state, and directory state, but never secret values or full database URLs.

- [ ] **Step 1: Write failing endpoint and command tests**

  Test an unauthenticated health request returns 200 and does not include a user or database detail. Test `doctor` output is safe and reports the current environment. Test an invalid production configuration returns a nonzero command result without printing `SECRET_KEY`, `ADMIN_LOGIN_KEY`, or database password.

- [ ] **Step 2: Run the focused tests and verify red**

  Run `uv run pytest config/tests.py common/tests.py -q`. Confirm failures are caused by missing route/command behavior.

- [ ] **Step 3: Implement health and doctor behavior**

  Add a GET-only health view that performs a minimal database connection check and maps failures to a generic non-200 JSON response. Implement doctor as a read-only management command that calls Django checks, validates migration state without applying migrations, checks `STATIC_ROOT`/`MEDIA_ROOT`, and returns explicit exit codes.

- [ ] **Step 4: Run focused and full tests**

  Run `uv run pytest config/tests.py common/tests.py -q` and `uv run pytest -q`. Confirm no health response or doctor output leaks secrets.

- [ ] **Step 5: Commit**

  ```powershell
  git add config common
  git commit -m "feat: add health and environment diagnostics"
  git push origin build/engineering-baseline
  ```

### Task 4: Add safe seed ownership and idempotent demo data

**Files:**
- Modify: `common/models.py`
- Create: `common/migrations/0002_seedrecord.py`
- Create: `common/management/commands/seed_demo_data.py`
- Modify: `accounts/management/commands/seed_dev_admin.py`
- Modify: `accounts/tests.py`
- Modify: `common/tests.py`
- Modify: `staff_panel/tests.py` only if shared fixture assertions are required
- Test: `accounts/tests.py`, `common/tests.py`

**Interfaces:**
- `SeedRecord(key, content_type, object_id, created_at)` stores only built-in deterministic seed ownership.
- `python manage.py seed_demo_data` creates/updates the demo fixture without duplicate rows.
- `python manage.py seed_demo_data --reset` deletes only runtime rows carrying `is_test_data=True` or `is_test=True`; it never deletes unmarked seed configuration or audit logs.
- `seed_dev_admin` accepts `DEV_ADMIN_PASSWORD` or hidden interactive input and never accepts a plaintext password option.

- [ ] **Step 1: Write failing seed tests**

  Add tests for first seed, second seed with stable counts and IDs, reset preserving a formal registration/vote/activity/configuration, and safe output. Add a test that `seed_dev_admin` fails without a password and updates an existing admin with a hidden/input-provided password.

- [ ] **Step 2: Run the focused tests and verify red**

  Run `uv run pytest common/tests.py accounts/tests.py -q`. Confirm the new behavior fails before the model/command implementation.

- [ ] **Step 3: Add the SeedRecord model and migration**

  Add a unique key, `ContentType` foreign key, positive object ID, and creation timestamp. Add a uniqueness constraint for `(content_type, object_id)` and register no public route. Generate the migration with `uv run python manage.py makemigrations common` and inspect it before applying.

- [ ] **Step 4: Implement deterministic demo fixtures**

  Use one transaction and fixed internal keys for the admin, two activities, public posts/templates, singers/programs, judges/rounds/scores, vote sessions/options/records, and operational data. Mark supported runtime rows as test data. Use SeedRecord for unmarked configuration rows, update by key, and keep audit logs.

- [ ] **Step 5: Implement safe reset and admin initialization**

  Restrict reset to the exact registered demo activity scope and model fields carrying test flags. Do not accept arbitrary model names, object IDs, or deletion keys from command-line input. Use `getpass` for interactive password entry and environment variables for automation.

- [ ] **Step 6: Run focused and full tests**

  Run `uv run python manage.py migrate`, `uv run pytest common/tests.py accounts/tests.py -q`, and `uv run pytest -q`. Run the command twice against a disposable SQLite database and assert stable counts.

- [ ] **Step 7: Commit**

  ```powershell
  git add common accounts staff_panel
  git commit -m "feat: add safe idempotent demo data"
  git push origin build/engineering-baseline
  ```

### Task 5: Build the PostgreSQL Docker runtime

**Files:**
- Create: `Dockerfile`
- Create: `.dockerignore`
- Create: `docker-compose.yml`
- Create: `scripts/docker-entrypoint.sh`
- Create: `scripts/wait-for-postgres.sh`
- Create: `scripts/bootstrap.ps1`
- Create: `scripts/verify.ps1`
- Create: `scripts/export-requirements.ps1`
- Create: `scripts/check_docs.ps1`
- Test: `docker compose config`, Docker build/health smoke

**Interfaces:**
- `docker compose up --build --wait` starts a healthy PostgreSQL/Web stack on localhost.
- `docker compose down` stops the stack without deleting named volumes.
- `scripts/bootstrap.ps1 [-SeedDemoData]` synchronizes dependencies, prepares `.env`, migrates, checks configuration, and performs a local doctor/health validation; it never resets data.
- `scripts/verify.ps1` runs the complete local quality gate and a temporary production `check --deploy`.
- `scripts/export-requirements.ps1` regenerates `requirements.txt` from the frozen lock and fails if the output is not reproducible.

- [ ] **Step 1: Write shell/config validation checks**

  Add PowerShell assertions that the compose file has `db`, `web`, healthchecks, named media/static/database volumes, localhost-only optional database ports, and no `.env`/`.git` copied into the image. Add shell `set -Eeuo pipefail` and argument validation requirements to the design tests/documented checks.

- [ ] **Step 2: Run config checks and verify red**

  Run `docker compose config` and the script checks before creating the files; confirm the missing file/config failures are expected.

- [ ] **Step 3: Implement the image and compose stack**

  Use a slim Python 3.12 image, install production dependencies plus `postgresql-client`, create a non-root user, copy only application files, and run gunicorn after migrations and `collectstatic --noinput`. Configure PostgreSQL with a healthcheck and internal network; bind any host port to `127.0.0.1` only.

- [ ] **Step 4: Implement bootstrap, verify, wait, and export scripts**

  Make scripts fail on the first failing command, avoid printing secrets, and return the failing subprocess exit code. `bootstrap.ps1` creates/updates `.env` only from `.env.example`, uses `uv sync --locked`, and calls `doctor`; `verify.ps1` runs all local gates; the wait script uses `pg_isready` with bounded retries.

- [ ] **Step 5: Run Docker smoke**

  Run:

  ```powershell
  docker compose config
  docker compose up --build --wait
  docker compose exec web python manage.py showmigrations --plan
  Invoke-WebRequest http://127.0.0.1:8000/healthz/
  docker compose down
  ```

  Confirm migration failure prevents Web startup and that the health endpoint is the only public diagnostic response.

- [ ] **Step 6: Commit**

  ```powershell
  git add Dockerfile .dockerignore docker-compose.yml scripts
  git commit -m "build: add PostgreSQL container runtime"
  git push origin build/engineering-baseline
  ```

### Task 6: Add CI, security, and dependency automation

**Files:**
- Create: `.github/workflows/ci.yml`
- Create: `.github/workflows/integration.yml`
- Create: `.github/workflows/security.yml`
- Create: `.github/workflows/workflow-lint.yml`
- Create: `.github/dependabot.yml`
- Test: actionlint and `gh workflow list`/`gh run list`

**Interfaces:**
- Every push/PR runs required quality checks with minimal read permissions, bounded timeouts, and concurrency cancellation.
- CI SQLite job runs lock installation, Ruff, format, mypy, Django checks, migration checks, pytest, and coverage.
- Windows matrix runs Python 3.12 and 3.13 with the same application test gate.
- PostgreSQL integration runs migrations, doctor, healthz, seed idempotency, and full tests without production credentials.
- Security workflow runs CodeQL, pip-audit on frozen exported dependencies, and gitleaks over full history.

- [ ] **Step 1: Write workflow contract checks**

  Add a local verification script section that asserts every workflow has `permissions`, `timeout-minutes`, pinned action SHAs, and no job exposes the PostgreSQL service beyond localhost. Do not test GitHub-hosted behavior through mocks.

- [ ] **Step 2: Run actionlint before implementation**

  Run `uvx actionlint` against the current repository and record the expected missing-workflow state; after each workflow file is added rerun it so YAML errors fail immediately.

- [ ] **Step 3: Implement CI and integration workflows**

  Use `astral-sh/setup-uv`, `actions/setup-python`, and cache keyed by `uv.lock`, pinning each action to an exact commit SHA with a version comment. Use `uv sync --locked`; configure Django environment variables per job and upload coverage only when the file exists.

- [ ] **Step 4: Implement security and dependency workflows**

  Export production dependencies from the frozen lock to a temporary file, run pip-audit, scan Python with CodeQL, scan full history with gitleaks, and configure Dependabot for pip/uv, GitHub Actions, and Docker. Do not put credentials in workflow YAML.

- [ ] **Step 5: Validate workflows remotely**

  Run `uvx actionlint`, `gh workflow list --repo Zn070515/ArtFlow`, and after pushing the feature branch use `gh run list --repo Zn070515/ArtFlow --branch build/engineering-baseline --limit 10`. Inspect failing logs with `gh run view <run-id> --log-failed` before changing code.

- [ ] **Step 6: Commit**

  ```powershell
  git add .github
  git commit -m "build: add CI and security gates"
  git push origin build/engineering-baseline
  ```

### Task 7: Synchronize repository documentation and change records

**Files:**
- Create: `docs/development-baseline.md`
- Create: `CHANGELOG.md`
- Modify: `README.md`
- Modify: `CLAUDE.md`
- Modify: `AGENTS.md` only when implementation adds a verified command
- Modify: `.env.example`
- Test: documentation grep/link checks

**Interfaces:**
- README contains one canonical Windows startup path, one Docker PostgreSQL path, required environment variables, migration/seed/test commands, and branch/merge workflow.
- Development baseline documents SQLite vs PostgreSQL, doctor/healthz, reset safety, Docker volumes, CI gates, and troubleshooting.
- Changelog records the engineering baseline as a dated entry without inventing a release version.

- [ ] **Step 1: Write documentation consistency checks**

  Implement `scripts/check_docs.ps1` to fail if `seed_data`, `docker-compose up -d` as the only documented startup, hardcoded `admin/admin123`, or stale model/view/route counts remain in user-facing docs. The script must also resolve every relative Markdown link under `README.md`, `CLAUDE.md`, `AGENTS.md`, and `docs/` against the repository root.

- [ ] **Step 2: Update documentation**

  Replace the stale seed command with `seed_dev_admin` and `seed_demo_data`, document `uv sync --locked`, explain production/container extras, and link to the development baseline. Keep security warnings explicit and never include a real secret.

- [ ] **Step 3: Build and inspect documentation**

  Run `scripts\check_docs.ps1`, then run `git diff --check` and inspect the complete diff for contradictory commands.

- [ ] **Step 4: Commit**

  ```powershell
  git add README.md CLAUDE.md AGENTS.md CHANGELOG.md docs .env.example
  git commit -m "docs: document ArtFlow engineering baseline"
  git push origin build/engineering-baseline
  ```

### Task 8: Full verification and main merge

**Files:**
- Modify: only files required by failing verification
- Test: full local and remote gates

**Interfaces:**
- `scripts/verify.ps1` is the local acceptance command.
- `main` receives one non-fast-forward merge commit after the feature branch is green.

- [ ] **Step 1: Run the full local gate**

  Run `scripts\verify.ps1` from PowerShell. It must execute uv lock verification, Ruff check/format, mypy, `manage.py check`, production `check --deploy --fail-level WARNING` with `APP_ENV=production`, migration check, pytest with coverage, and documentation/workflow checks.

- [ ] **Step 2: Run the full PostgreSQL gate**

  Run `docker compose up --build --wait`, execute migrations, `doctor`, `/healthz/`, seed twice, and the complete test suite against PostgreSQL. Save logs outside the repository if they contain generated output.

- [ ] **Step 3: Inspect repository and branch state**

  ```powershell
  git status --short
  git diff --check
  git log --oneline --decorate -12
  gh run list --repo Zn070515/ArtFlow --branch build/engineering-baseline --limit 10
  ```

  Do not merge if any required check is pending, failed, or absent.

- [ ] **Step 4: Merge and push main**

  ```powershell
  git switch main
  git pull --ff-only origin main
  git merge --no-ff build/engineering-baseline -m "merge: establish ArtFlow engineering baseline"
  git push origin main
  ```

- [ ] **Step 5: Verify the remote main result**

  Run `gh run list --repo Zn070515/ArtFlow --branch main --limit 10`, `git status --short --branch`, and `git log -3 --oneline --decorate`. Keep the feature branch until the merge and remote checks are confirmed; delete it only after the final status is clean.

- [ ] **Step 6: Commit any final documentation-only correction separately**

  If remote verification reveals a documentation-only mismatch, create a new `docs/` branch from updated `main`, fix it with a focused commit, rerun the documentation gate, and merge with the same `--no-ff` rule. Never amend a published baseline commit.
