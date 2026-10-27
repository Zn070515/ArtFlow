# Repository Guidelines

## Project Structure & Module Organization
ArtFlow is a two-era repository. `main` is the **1.x production line** (Django monolith); `artflow-plus` is the **v2 development line (ArtFlow-Plus)** under `plus/`. This section describes v1; the v2 layout follows it.

Core project settings live in `config/`; feature apps are split by domain:

- `accounts/`: custom user model, roles, login/register flows.
- `entry_access/`: entry points, access grants, and ephemeral entry sessions.
- `tickets/`: tickets and ticket access sessions for the operator/check-in flow.
- `core/`: shared `Activity` model and activity phase/lock state.
- `ruleset/`: ruleset templates, contest rulesets, and versioned rulesets.
- `questionnaire/`: the participant questionnaire DSL, its compiled plan, registration drafts and submissions, and the staff designer. Frozen with the ruleset it belongs to.
- `common/`: audit, authority, business-rule, lifecycle, and maintenance helpers.
- `public_portal/`: public homepage, announcements, showcases, result posts.
- `files/`: submission files, material requirements, material checks.
- `singer_contest/`: singer registrations, rounds, judges, scores, awards.
- `farewell_show/`: graduation show program submissions and program order.
- `voting/`: audience vote sessions, options, records.
- `staff_panel/`: staff/admin dashboard views and operational workflows.
- `realtime/`: WebSocket consumers, presence, and notification events. Notifications only — no authority decision may depend on them, and every flow must still complete over plain HTTP when they are down.
- `exports/`, `archive/`, `incidents/`: export, archive, and incident records.

Templates are under `templates/`. Tests live in the app that owns the behavior, either in `tests.py` or in `test_*.py` modules beside it. Local media under `media/` must not be committed.

### ArtFlow-Plus (v2) layout

v2 is a pnpm 12 workspace with Node 24, Fastify 5, Kysely/PostgreSQL 18, and React 19:

- `plus/apps/api/`: Fastify HTTP + the single `/api/realtime` WebSocket endpoint; command routes, public reads, cookie sessions/CSRF.
- `plus/apps/web/`: React + Vite + TanStack Router/Query; Studio, Ops, Live, Portal, and `/vote/<sessionId>`.
- `plus/apps/worker/`: outbox relay (in-process 250ms loop + pg-boss backstop).
- `plus/packages/domain/`: pure domain, capability registry, packs, compilers, command/event model.
- `plus/packages/runtime/`: command handlers, projections, and capability services.
- `plus/packages/db/`: Kysely schema, module-owned migrations, repositories.
- `plus/packages/contracts/`: shared TypeBox schemas.
- `plus/packages/realtime/`: the protected WebSocket core (`/protocol`, `/server`, `/client`); read `CORE.md` before touching it. Feature code registers `RealtimeTopic` definitions and must not open sockets directly (`GATE-REALTIME-CORE-01`).

v2 commands (from the repository root):

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

The v2 API migrates on start. Browser E2E uses the `artflow_e2e` schema and `workers: 1`. Structural gates (`uv run pytest tests/gates -q`) include `GATE-PLUS-BOUNDARY-01` and `GATE-REALTIME-CORE-01`. Do not mechanically merge `main` into `artflow-plus`; implement v2 behavior from its own domain specs.

## Build, Test, and Development Commands
Prefix shell commands with `rtk` in agent workflows when `rtk` is installed. If the command is unavailable on the current machine, run the command directly and report that fallback; do not block repository work on an optional wrapper.

```bash
uv sync --locked --extra dev
uv run python manage.py migrate --noinput
uv run python manage.py runserver
uv run python manage.py check
uv run python manage.py makemigrations --check --dry-run
uv run python manage.py test
uv run python manage.py test staff_panel
uv run python manage.py doctor
pwsh -NoProfile -File scripts/check_docs.ps1
pwsh -NoProfile -File scripts/verify_postgres_acceptance.ps1 -StartCompose -VerifyResetSafety
npm ci
npm run check:css
npm run check:client
npm run check:e2e
npm run test:client
npm run check:pyright
npx playwright install chromium
npm run test:e2e
pwsh -NoProfile -File scripts/verify_postgres_backup_restore.ps1 -ComposeProjectName artflow -BackupPath backups/artflow-rehearsal.dump
```

Use `migrate` after pulling migrations, `runserver` locally, `check` for Django validation, `doctor` for read-only runtime diagnostics, and `test` before committing. Install the locked development environment with `uv sync --locked --extra dev`; use `check_docs.ps1` after user-facing documentation changes. `check:client` compiles every `frontend/**/*.ts` entry and fails when tracked `static/dist/` output is stale; `test:client` executes the compiled client artifact. `check:pyright` is the blocking project baseline and must be zero-diagnostic; it covers every app directory, including the hardened entry-access boundary. `check:e2e` type-checks `tests/e2e/**` and `playwright.config.ts` against `tsconfig.e2e.json`; Playwright only transpiles those files, so without this gate they are checked by nothing. The PostgreSQL acceptance command requires Docker Compose and leaves its services and volumes intact; `-VerifyResetSafety` makes the demo-data reset check explicit. The CSS gate rebuilds the pinned Tailwind asset and fails if the tracked output is stale. `test:e2e` requires an already-running local or Compose web service and runs the read-only Playwright browser smoke. The backup/restore rehearsal creates a custom-format dump from the running Compose database, restores it into a separate temporary database container, runs Django checks, and cleans up only that temporary target. It must never use `docker compose down --volumes`, reset, or drop the source database/volumes.

## Coding Style & Naming Conventions
Use Python 4-space indentation and Django conventions: models as `PascalCase`, functions/views as `snake_case`, URL names as concise action names such as `vote_session_unlock`. Keep cross-flow rules in shared helpers, e.g. `common/business_rules.py`. Do not enforce permissions only in templates; validate before mutation.

## Testing Guidelines
Use Django `TestCase`. Add regression tests for permission, lock-state, audit, file-access, export, and destructive-data paths. Prefer tests in the app that owns the behavior; cross-flow staff/admin tests can live in `staff_panel/tests.py`. Name tests by behavior, for example `test_locked_activity_blocks_staff_score_entry`.

## Commit & Pull Request Guidelines

Every logical change must be a small, independently verifiable commit. Separate test additions, one security or behavior fix, one focused type-hygiene batch, and rule/documentation changes into different commits. Run the relevant focused gate before each commit; do not accumulate multiple unverified changes and commit them together. Keep the feature branch history reviewable and use a conventional prefix for every commit.

### Pylance & Pyright Type Checking

VS Code Pylance must use the repository-root `pyrightconfig.json`. Before committing production Python changes, run `npm run check:pyright`; it is a blocking gate and must report zero errors, warnings, and informations. When Django runtime-generated fields, reverse managers, annotated queryset fields, or choice display methods are not visible to Pylance, add a narrow `TYPE_CHECKING` declaration in the owning model module. Do not globally disable `reportAttributeAccessIssue`, lower the project checking mode, or hide a new diagnostic with a broad `Any`/file-level suppression. The baseline lists whole app directories, so a new production Python module is covered without further work. When only one of the two type checkers needs a suppression, use `# pyright: ignore[...]` — `# type: ignore` is also read by mypy, which reports it as unused where it has no matching error.
Commit messages follow conventional prefixes seen in history: `feat:`, `fix:`, `style:`, `docs:`, `test:`, `chore:`. Keep commits scoped and push feature-branch commits after verification; push `main` only after the verified non-fast-forward merge.

## Agent Execution & Git Network Rules

- Execute repository work inline in the current conversation. Do not spawn subagents or delegate
  inspection, editing, testing, verification, cleanup, commits, or merges; the primary agent must
  perform and report those actions directly.
- If `git push` times out, retry through the local VPN proxy at `127.0.0.1:12334`:

```bash
git -c http.proxy=http://127.0.0.1:12334 -c https.proxy=http://127.0.0.1:12334 push origin <branch>
```

## Branch & Worktree Workflow

Do not use `.worktree/`, `worktrees/`, or any other linked worktree for ArtFlow development. Work directly in the repository checkout on a short-lived branch created from the clean, up-to-date base of the line you are changing: `main` for 1.x production fixes, `artflow-plus` for v2 work. Never merge across lines; the only cross-line step is the deliberate cutover.

```bash
git status --short --branch
git switch main
git pull --ff-only origin main
git switch -c build/<short-name>
```

Use `feat/`, `fix/`, `docs/`, `test/`, or `build/` prefixes as appropriate. Do not start work if the base line (`main` or `artflow-plus`) has uncommitted changes; preserve existing user changes and ask before proceeding.

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

For v2 work, substitute `artflow-plus` for `main` in the commands above; the feature branch merges back into `artflow-plus`, not `main`.

Keep the feature branch until the merge and push have been confirmed. Delete it only after the final Git status and remote state are verified.

Before opening a PR, run:

```bash
# 1.x
python manage.py check
python manage.py makemigrations --check --dry-run
python manage.py test

# v2
pnpm -C plus run check
pnpm -C plus run test          # REQUIRE_DB=1 against PostgreSQL
uv run pytest tests/gates -q
```

PRs should summarize behavior changes, list migrations, note verification, and include screenshots for UI changes.

## Configuration Sweep

Configuration files drift silently: a whitelist keeps passing while the tree grows past it, and a new module that appears in no list is checked by nothing.

After each round of changes, check the configuration against what the tree now contains:

- `pyrightconfig.json` `include` — every production module is covered, or the omission is deliberate and written down.
- `pyproject.toml` `[tool.mypy] files` and `[tool.ruff] src` — every app directory is listed.
- `tailwind.config.js` `content` — matches everywhere class names are actually written, including `frontend/**/*.ts`.
- `tsconfig*.json` `include` — every TypeScript source is type-checked, not only transpiled: `frontend/**` by `check:client`, the browser specs and `playwright.config.ts` by `check:e2e`.
- `.env.example` / `.env.production.example` / `.env.event.example` — every knob `config/settings.py` reads is documented, with its real default.
- `.dockerignore` / `.gitignore` — local artifact directories (media, backups, node_modules, databases) are excluded.
- `.github/dependabot.yml` — one entry per package ecosystem the repository actually uses.

## Security & Configuration Tips
Never commit `.env`, SQLite databases, generated exports, archives, or uploaded files. Use `.env.example` for required variables such as `SECRET_KEY`, `STAFF_ACCESS_KEY`, `ADMIN_ACCESS_KEY`, database settings, and `ALLOWED_HOSTS`. Internal submission files must go through controlled access views; do not reintroduce direct static media serving for private files.

## Authority Baseline
Raw scoring, criterion scores, vote ballots/records, and round performance/group facts are
authoritative inputs. After their round/session is locked, or after a confirmed stage has
consumed them, do not mutate them through direct ORM writes; use the corresponding audited
service and explicit unlock flow. `StageAwardDecision` is a computed candidate only;
`Award` rows sourced from a stage may be materialized only when that stage is confirmed.
Ruleset templates must expose `builtin_key` and capability status; only `Production`
templates may be cloned into a production workflow. The built-in 2026 live format
(`builtin_key = live_challenge_2026`) additionally provisions the first physical round and
the format's binding keys when a ruleset is created from it — it pre-fills those values, it
does not lock them. Nothing about the shape is a constant: the runtime reads
`participant_count` / `seat_count` / `group_count` / `group_size` off the frozen binding
(踢馆人数 is derived as 参赛人数 − 晋级数 and never read from storage), and
`ruleset.services.validate_binding` enforces only that the numbers relate coherently. The
two weight pairs and three judge lists are deliberately left empty for staff to fill. Vote sessions must declare their
purpose, and a ruleset vote source must match that purpose at bound freeze time. An
activity may be archived only while its result line is closed: the archive package is the
permanent record, so it is built on `build_result_closure(...).closeable`, never on the
phase or on the existence of any confirmed row — and the exemption for activities with no
ruleset-driven result line is decided by `activity_type`, never by which blocker the
closure happens to report. Exports, retention and the archive report the same populations
the resolver computes (`voting.services.valid_vote_count`, never a raw record count), and
the permanent archive carries only what GOAL §19.1 keeps durable — a temporary staff note
stays in the pre-event execution package. The archive's stage view is likewise driven by
the closure, so a checkpoint the current frozen ruleset no longer declares cannot appear
beside the ones that are current.

GOAL §19.3 holds on every staff path, not only the Django admin form: an image bound for
the public site passes `forms.ImageField` (which rejects a payload that is not decodable)
and `files.imaging.sanitize_upload` (which bakes EXIF orientation into the pixels and
writes no metadata back). A view that assigns `request.FILES[...]` to a public image field
is a bypass, however legitimate the page is.

Bootstrap authority is authority. A URL that mints a session is a credential, and a public
route that mints one is a public credential: the shared judge entry carries an HMAC
capability in its URL fragment (`singer_contest.judge_entry`, versioned by
`Activity.judge_entry_version`) precisely because `/e/<code>/judge/` is public and the
public code is printed on posters. When adding an entry point, ask what the caller has to
*have* — not only what the code checks after they hold it. A capability that resolves while
its door is closed is told so; a code that does not resolve is refused as if the activity
did not exist.

A credential that has to be resolved before a row lock is taken must be re-checked against
the locked row before it authorises anything. `rotate_ticket_credential` promises that the
old code dies the moment it commits, and `Activity.judge_entry_version` promises the same
for a reissued judge QR; a request that resolved the code a millisecond earlier would
otherwise still check in, or take a seat right after the reissue. `state` is re-checked by
each caller's own guard; the credential's version is not, so it needs its own recheck —
`judge_entry_authorizes_activity` recomputes the signature from the locked row rather than
trusting the token's claim.

The door's *own* switches are part of the same decision: `judge_entry_open` is read from the
locked row too, or "closing refuses new scans" is only true for requests that start
afterwards. And the service owns the whole sequence — resolve, lock, revalidate, act — so a
view cannot assemble it and quietly omit a step. Both doors are opened and closed under the
activity row lock for the same reason every other mutation is.

Bytes written to storage are not rolled back with the transaction that references them:
`files.services` compensates by deleting what it just wrote, while superseded files keep
using `transaction.on_commit` (they are only garbage once their replacement has really
committed). The two directions are deliberately opposite. The compensation block must span
the caller's whole unit of work — the audit row written after an upload is inside the same
transaction — which is why `_store_file` takes the recording list as a required argument
rather than opening the block itself.
