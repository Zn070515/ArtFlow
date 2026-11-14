# M1 Authority and Goal v4 Closure Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement every applicable fix in `ChatGPT.md` while preserving the `GOAL.md v4` authority, single-primary, offline-tolerant, and no-invented-result invariants.

**Architecture:** Keep the Django monolith and existing service-layer authority model. Add model/queryset/admin defense-in-depth for formal data, a transactionally idempotent score receipt for the existing Rapid Score API, and explicit deployment/rate-limit contracts without introducing a second database authority or a distributed infrastructure dependency.

**Tech Stack:** Python 3.12/3.13, Django 6, SQLite development tests, PostgreSQL 16 acceptance/concurrency tests, Django templates, native JavaScript/localStorage, Docker Compose, Gunicorn, Caddy/Nginx-compatible production ingress, openpyxl, pytest-django, Ruff, mypy.

**Spec:** `docs/superpowers/specs/2026-09-04-m1-authority-goal-v4-design.md`

## Global Constraints

- Work directly in the repository checkout; never create or use `.worktree/`, `worktrees/`, or another linked worktree.
- Start from a clean, up-to-date `main` and use a short-lived `build/`, `fix/`, `docs/`, `feat/`, or `test/` branch.
- `GOAL.md v4` is the product authority; unknown rules remain HOLD/NEEDS_RULE_CLARIFICATION and are never guessed.
- Formal data has one write authority; client pending data is not a second database.
- Keep `STAFF` as one daily role; do not add department sub-roles or require judge/audience accounts.
- Do not add microservices, Kafka, Kubernetes, Redis Cluster, Celery, Active-Active PostgreSQL, or PPT playback control.
- Every behavior change follows RED → GREEN → REFACTOR; record the failing test command and the passing command in the commit/hand-off notes.
- Do not reduce test coverage or bypass a failing gate to make CI green.
- Private files continue through controlled media access; no direct private media serving.
- Every high-risk service locks and rereads the authoritative parent before mutation and writes an AuditLog where the existing operation is auditable.
- Keep the root `docker-compose.yml` as development/integration only; production and event manifests must be explicit.

---

### Task 1: Lock down parent creation and deletion authority

**Files:**
- Modify: `common/authority.py`
- Modify: `core/models.py`, `core/services.py`, `core/admin.py`
- Modify: `singer_contest/models.py`, `singer_contest/services.py`, `singer_contest/admin.py`
- Modify: `voting/models.py`, `voting/services.py`, `voting/admin.py`
- Test: `core/tests.py`, `singer_contest/test_m1_core_final.py`, `voting/tests.py`

**Interfaces:**
- Consumes: existing `authority_write`, `ACTIVITY_STATE`, `CONTEST_ROUND_STATE`, `VOTE_SESSION_STATE`, `clear_test_data`, and activity/round/vote lifecycle services.
- Produces: guarded `save`, `delete`, `QuerySet.delete`, `bulk_create`, `bulk_update`, and `_base_manager` behavior for Activity, ContestRound, and VoteSession.

- [ ] **Step 1: Write failing parent-creation tests.** Add tests that call the default manager and `_base_manager` with `Activity(phase=LIVE)`, `Activity.bulk_create([ARCHIVED])`, `ContestRound(status=LOCKED, is_locked=True)`, `ContestRound.bulk_create([SCORING])`, `VoteSession(is_open=True)`, and `VoteSession.bulk_create([is_locked=True])`; assert `ValidationError` and no row is persisted.
- [ ] **Step 2: Run only those tests and verify RED.** Run `python -m pytest core/tests.py singer_contest/test_m1_core_final.py voting/tests.py -k "creation or bulk_create" -q`; verify each failure is caused by the missing initial-state guard rather than test setup.
- [ ] **Step 3: Implement the smallest creation guards.** In each model `save()` and queryset `bulk_create()`, allow only the documented initial state outside the model’s authority scope; ensure `bulk_create(update_conflicts=True)` applies the same protected-field checks as the update path. Preserve explicit authority scopes for seed/migration/service paths; do not add public bypass kwargs.
- [ ] **Step 4: Write failing deletion tests.** Cover instance delete, default queryset delete, and `_base_manager.delete` for formal, locked, non-DRAFT, and consumed parents. Cover the allowed TEST+DRAFT cleanup path and ContestRound child `PROTECT` behavior.
- [ ] **Step 5: Run deletion tests and verify RED.** Run `python -m pytest core/tests.py singer_contest/test_m1_core_final.py voting/tests.py -k "delete or cleanup" -q`; capture the current cascade/deletion bypass.
- [ ] **Step 6: Implement parent deletion guards.** Reject formal Activity, locked Activity, non-DRAFT formal Activity, and any Activity with formal result/archive/runtime data; reject consumed/locked VoteSession and non-DRAFT/consumed ContestRound. Make `clear_test_data()` use an explicit cleanup authority that first closes/unlocks locked test VoteSession rows without weakening ordinary ORM deletion.
- [ ] **Step 7: Update Admin and service tests.** Formal Activity delete must be disabled; non-DRAFT ContestRound creation/deletion must not be offered as a direct Admin path; ordinary lifecycle/reset/archive services must continue to pass under their explicit scopes.
- [ ] **Step 8: Run focused GREEN tests and commit.** Run the focused tests plus `python manage.py check` and `python manage.py makemigrations --check --dry-run`; commit `fix: close parent authority creation and deletion gaps`.

### Task 2: Protect account authority and identity ownership

**Files:**
- Modify: `common/authority.py`
- Modify: `accounts/models.py`, `accounts/services.py`, `accounts/admin.py`
- Modify: `singer_contest/models.py`, `singer_contest/admin.py`
- Modify: `accounts/tests.py`, `singer_contest/test_authority_closure.py`

**Interfaces:**
- Consumes: `change_user_role`, `set_user_active`, effective-admin checks, `SingerRegistration`, `Judge`, and existing audit helpers.
- Produces: `ACCOUNT_AUTHORITY`, protected User fields, immutable registration/judge identity fields, and service-only account/identity mutation.

- [ ] **Step 1: Write failing User authority tests.** Cover instance `save`, `objects.update`, `_base_manager.update`, `bulk_update`, and Admin form/change behavior for `role`, `is_active`, and `is_superuser`; assert direct mutation is rejected while `change_user_role` and `set_user_active` succeed with AuditLog and preserve at least one effective admin.
- [ ] **Step 2: Run the account RED suite.** Run `python -m pytest accounts/tests.py -k "role or active or superuser or admin" -q`; verify direct writes currently bypass the service.
- [ ] **Step 3: Implement `ACCOUNT_AUTHORITY`.** Add the scope and a User queryset/manager. In `User.save`, compare persisted protected values through `_base_manager` and reject changes outside the scope; continue deriving `is_staff` from role/superuser.
- [ ] **Step 4: Route account services through the scope.** After transaction locking and last-admin checks, wrap only the protected save in `authority_write(ACCOUNT_AUTHORITY)`. Keep bootstrap/`seed_dev_admin` on an explicit provisioning path.
- [ ] **Step 5: Write failing identity tests.** Create two activities and a prepared round referencing a singer and judge. Assert changes to `SingerRegistration.activity_id`, `SingerRegistration.user_id`, and `Judge.activity_id` fail through instance save, queryset update, bulk update, and `_base_manager`; assert ordinary name/phone/song and `Judge.is_active` edits remain allowed.
- [ ] **Step 6: Run identity RED tests.** Run `python -m pytest singer_contest/test_authority_closure.py -k "identity or activity" -q`; verify the tests fail only because FK ownership is mutable.
- [ ] **Step 7: Implement identity guards and Admin read-only fields.** Protect only ownership fields, use persisted values rather than relation caches, and set existing-object Admin fields readonly without blocking legitimate profile corrections.
- [ ] **Step 8: Run GREEN and commit.** Run account and identity tests, `python manage.py check`, and the account migration check; commit `fix: protect account and contest identity authority`.

### Task 3: Build the reusable authority mutation matrix

**Files:**
- Create: `common/test_authority_matrix.py`
- Test: `common/test_authority_matrix.py`

**Interfaces:**
- Consumes: all protected managers and services from Tasks 1–2 and existing raw/confirmed fact guards.
- Produces: parameterized invariant tests for instance, queryset, bulk, base-manager, Admin-canonical, cross-identity, and authorized-service paths.

- [ ] **Step 1: Define the matrix fixture table.** Register model factories and mutation descriptors for User, Activity, ContestRound, VoteSession, ScoreRecord, ScoreSummary, AudienceScore, VoteOption, VoteBallot, VoteRecord, PerformanceGroup, Performance, RubricCriterion, CriterionScore, StageResult, StageDecision, StageAwardDecision, CompositeResult, Award, SingerRegistration, Judge, and RulesetVersion.
- [ ] **Step 2: Add the failing matrix assertions.** For each descriptor, assert protected mutation paths reject unauthorized writes, old protected → new unprotected and old unprotected → new protected relation changes reject, and the documented service scope succeeds. Do not assert view copy or exception wording.
- [ ] **Step 3: Run the matrix and classify failures.** Run `python -m pytest common/test_authority_matrix.py -q`; map each failure to the owning model/service before editing production code. Do not bulk-fix unrelated failures.
- [ ] **Step 4: Close remaining gaps one model at a time.** Apply the existing model-specific guard pattern, adding only the missing queryset/base-manager/delete/FK path. Keep confirmed/derived facts distinct from raw inputs.
- [ ] **Step 5: Run the matrix on SQLite and PostgreSQL.** Run `python -m pytest common/test_authority_matrix.py -q` locally and include it in the Docker acceptance suite; commit `test: add unified authority mutation matrix` after all rows are green.

### Task 4: Add transactionally idempotent Rapid Score receipts

**Files:**
- Modify: `singer_contest/models.py`, `singer_contest/services.py`
- Modify: `staff_panel/views.py`, `staff_panel/forms.py`
- Modify: `singer_contest/tests.py`, `singer_contest/test_authority_closure.py`
- Create: `singer_contest/migrations/0033_score_write_receipt.py`

**Interfaces:**
- Consumes: `round_scores_api`, `apply_scores`, `ScoreRecord`, `ContestRound.score_version`, existing score audit behavior.
- Produces: `ScoreWriteReceipt(command_id, operator, operation, payload_hash, result_version, result_payload/status, created_at)` and an idempotent score-apply service returning the first result for an identical command.

- [ ] **Step 1: Write failing receipt tests.** Add a service-level test where the same `command_id` and payload are applied twice; assert one score mutation, one version increment, and the second call returns the first response. Add a same-command/different-payload test expecting stable `IDEMPOTENCY_CONFLICT` with no mutation.
- [ ] **Step 2: Run receipt RED tests.** Run `python -m pytest singer_contest/test_authority_closure.py -k "receipt or idempot" -q`; verify the current API has no receipt and duplicate calls mutate twice.
- [ ] **Step 3: Implement the receipt model and migration.** Hash a canonical JSON payload server-side, enforce unique `command_id`, keep payload/result bounded, and do not log full sensitive request data. Add the model to the existing base-manager/authority policy as a transaction record, not a replacement for ScoreRecord.
- [ ] **Step 4: Wrap apply and receipt in one transaction.** Lock the round, revalidate activity/round/operator/entry/version context, look up the receipt, reject hash conflicts, apply scores and audit, persist the receipt, and return the stored result on identical retry.
- [ ] **Step 5: Thread `command_id` through the API.** Require or validate a client command ID on Rapid Score POST, return a stable JSON result/version/reason code, and preserve existing stale-version 409 semantics for commands that are not idempotent replays.
- [ ] **Step 6: Run GREEN tests and PostgreSQL concurrency tests.** Run the focused receipt tests, existing score tests, and the PostgreSQL-only concurrency test against Docker; assert serialized receipt/score behavior and no partial mutation.
- [ ] **Step 7: Commit.** Commit `feat: make rapid score writes idempotent`.

### Task 5: Make Rapid Score resilient to weak networks and stale pages

**Files:**
- Modify: `static/js/rapid_score.js`
- Modify: `templates/staff_panel/round_score_entry.html`
- Modify: `staff_panel/views.py` only for response payloads required by the existing API contract
- Create: `tests/rapid_score_client.test.mjs`
- Test: `tests/rapid_score_client.test.mjs`, `singer_contest/test_authority_closure.py`

**Interfaces:**
- Consumes: Task 4 `command_id`, `base_version`, score grid JSON, existing Rapid Score API 409 payload.
- Produces: local pending record keyed by activity/round/endpoint, saved/pending counters, retry controls, unload warning, rebase/conflict payload handling.

- [ ] **Step 1: Characterize the current client contract.** Read `static/js/rapid_score.js`, the score-entry template, and `round_scores_api`; record grid, version, dirty-cell, and 409 fields in a small test fixture without changing them.
- [ ] **Step 2: Write failing pending-store tests.** Test valid input persists before fetch, network failure retains pending, reload restores the same round’s pending cells, `online` and manual retry resend, and pending unload triggers a warning.
- [ ] **Step 3: Run the client RED tests.** Run `node --test tests/rapid_score_client.test.mjs`; use Node’s built-in test runner with a fake `window`, `localStorage`, `fetch`, and `navigator` boundary so the test observes real Rapid Score code without adding a JavaScript dependency. Verify current code drops or forgets pending data.
- [ ] **Step 4: Implement a narrow localStorage store.** Store `activity`, `round`, `endpoint`, `base_version`, pending cell values, `command_id`, and `updated_at`; normalize/validate values before storage; remove only after a matching server ACK.
- [ ] **Step 5: Write failing rebase/conflict tests.** Given a server grid and local pending grid, assert unchanged server cells rebase automatically and same-cell divergent edits become explicit conflicts with both values retained; assert a 409 never clears all dirty state.
- [ ] **Step 6: Implement rebase, retry, and status UI.** Use bounded exponential delay, immediate `online` retry, manual retry button, saved/pending counters, conflict display, and `beforeunload` warning. Never silently choose either side of a conflict.
- [ ] **Step 7: Run GREEN client/API regression tests.** Include a server-side test for malformed command IDs, wrong round/activity context, and stable 409 payloads; commit `fix: preserve rapid score drafts across retries`.

### Task 6: Fix round sequence allocation and explicit duplicate errors

**Files:**
- Modify: `staff_panel/forms.py`, `staff_panel/views.py`
- Modify: `singer_contest/models.py`
- Test: `staff_panel/tests.py`, `singer_contest/tests.py`

**Interfaces:**
- Consumes: `ContestRoundManager.create`, `round_create`, `(activity, sequence)` unique constraint, Activity row lock.
- Produces: blank sequence → next sequence allocation; explicit duplicate sequence → form error and no 500; non-DRAFT sequence editing rejected.

- [ ] **Step 1: Write failing Staff HTTP tests.** Post two default round forms for one Activity and assert sequences 1 and 2; post an explicit existing sequence and assert 400/200 with form error, no IntegrityError/500.
- [ ] **Step 2: Run RED.** Run `python -m pytest staff_panel/tests.py -k "round.*create or sequence" -q`; verify the current form coerces blank to 1 or leaks an integrity failure.
- [ ] **Step 3: Implement form/view behavior.** Make sequence optional on creation, leave blank values for the manager to allocate under the existing Activity row lock, validate explicit duplicates inside the transaction, and catch the race-safe IntegrityError into a readable form error.
- [ ] **Step 4: Add DRAFT-only edit assertions.** Verify reordering/configuration is allowed only in DRAFT and preserves the unique constraint.
- [ ] **Step 5: Run GREEN tests and commit.** Run focused staff tests plus migrations check; commit `fix: make contest round sequence allocation safe`.

### Task 7: Add explicit production and event deployment manifests

**Files:**
- Create: `deploy/compose.production.yml`
- Create: `deploy/compose.event.yml`
- Modify: `docs/deployment-production.md`, `docs/development-baseline.md`, `docs/production-rehearsal-runbook.md`, `README.md`
- Modify: `scripts/verify.ps1`
- Create: `tests/test_production_compose_config.py`
- Test: `tests/test_postgres_acceptance_script.py`, `tests/test_production_compose_config.py`

**Interfaces:**
- Consumes: root development `docker-compose.yml`, production settings validation, current healthcheck, backup/restore scripts.
- Produces: production manifest with env-injected secrets, private PostgreSQL network, reverse-proxy boundary, persistent volumes, truthful healthchecks, and an event/local-only runbook.

- [ ] **Step 1: Write failing config tests.** Assert the production manifest has `APP_ENV=production`, no development password literal, no direct public web port, internal-only database, persistent database/media volumes, and a reverse-proxy service or documented external proxy boundary. Assert `production-rehearsal-runbook.md` names the explicit manifest.
- [ ] **Step 2: Run RED.** Run `python -m pytest tests -k "production or compose" -q`; verify the current bare Compose/runbook contradiction is detected.
- [ ] **Step 3: Implement production manifest.** Use `${...}` env interpolation or `env_file`; keep web on an internal network; expose only the proxy; set production security settings; preserve healthchecks; never reuse the development hard-coded password.
- [ ] **Step 4: Implement event/local-only manifest and documentation.** Document localhost Staff operation, optional public tunnel/IPv6 ingress, the single primary authority rule, and the fact that PowerPoint remains independent.
- [ ] **Step 5: Add config gate.** Make `scripts/verify.ps1` validate manifest structure and run `docker compose -f deploy/compose.production.yml config`; do not start or tear down production services in the config-only test.
- [ ] **Step 6: Run GREEN checks and commit.** Run production config tests, `python manage.py check --deploy` under a non-placeholder production env, and docs checks; commit `build: add explicit production and event compose contracts`.

### Task 8: Implement shared production rate limiting

**Files:**
- Modify: `common/rate_limit.py` (it already exists and must be extended/reused rather than duplicated)
- Create: `common/migrations/0010_rate_limit.py` if the shared store requires a schema change
- Modify: `config/settings.py`
- Modify: `accounts/views.py`, `voting/views.py`
- Test: `accounts/tests.py`, `voting/tests.py`

**Interfaces:**
- Consumes: existing admin-login and vote-passcode throttling keys, `client_ip`, Django cache/settings.
- Produces: environment-selected shared backend; atomic `allow(key, limit, window)` semantics; common use by admin login and vote passcode paths.

- [ ] **Step 1: Write failing shared-throttle tests.** With two database connections/process-like transactions, assert increments share one key/window, expire/reset atomically, and reject the next request after the limit. Assert development/test keeps LocMem and production selects the database backend.
- [ ] **Step 2: Run RED.** Run `python -m pytest accounts/tests.py voting/tests.py -k "throttle or rate" -q` and the PostgreSQL-only concurrency test; verify per-worker LocMem behavior or absent shared backend.
- [ ] **Step 3: Implement the database backend.** Extend the existing `common/rate_limit.py` with unique key, window start, count, expiry; use transaction-safe row creation/update with PostgreSQL conflict handling and a SQLite-safe fallback for tests. Return only allow/deny and retry metadata, not sensitive payloads.
- [ ] **Step 4: Route both callers through one helper.** Keep IP as coarse rate-limit input only; do not use it for audience identity or one-person-one-vote semantics.
- [ ] **Step 5: Run GREEN and commit.** Run focused SQLite tests and PostgreSQL concurrency tests; commit `feat: share production throttling across workers`.

### Task 9: Correct award rehearsal contracts and Admin authority surfaces

**Files:**
- Modify: `docs/production-readiness.md`, `docs/production-rehearsal-runbook.md`
- Modify: `singer_contest/admin.py`, `ruleset/admin.py`, `core/admin.py`, `voting/admin.py`, `files/admin.py`
- Test: `singer_contest/test_m1_core_final.py`, `ruleset/test_compiler.py`, `tests/test_check_docs.py`

**Interfaces:**
- Consumes: Ruleset AWARD resolution, `StageAwardDecision`, `StageResult` confirmation, `Award` materialization, existing Admin readonly rules.
- Produces: truthful documented award flow and Admin as observation/maintenance surface rather than an alternate business write path.

- [ ] **Step 1: Write failing documentation-contract tests.** Assert the rehearsal docs do not require VoteSession lock to create an Award and do describe `AWARD → StageAwardDecision → CONFIRM → Award`, including retry/stale/unlock cases.
- [ ] **Step 2: Run RED.** Run `python -m pytest tests/test_check_docs.py singer_contest/test_m1_core_final.py -k "award or readiness or rehearsal" -q`; verify stale wording or missing candidate checks.
- [ ] **Step 3: Update the docs.** Replace old popularity-award lock/relock steps with the confirmed-stage materialization flow; explicitly retain `source_vote_session` only as legacy provenance if historical rows require it.
- [ ] **Step 4: Tighten Admin.** Disable direct add/change/delete for protected raw/derived facts and account authority fields; keep Staff services as the normal operation path.
- [ ] **Step 5: Run GREEN docs and domain tests and commit.** Commit `docs: align award rehearsal with confirmed-stage authority`.

### Task 10: Integrate, self-review twice, and complete all gates

**Files:**
- Modify: `docs/development-baseline.md`, `README.md` for the verified new commands and invariants
- Test: all repository test and verification surfaces

**Interfaces:**
- Consumes: Tasks 1–9 and the spec/GOAL v4 invariants.
- Produces: a verified feature branch merged non-fast-forward into `main`, pushed remotely, with the feature branch retained until final remote verification.

- [ ] **Step 1: Run focused suites.** Run authority matrix, account/core/voting/ruleset/singer/staff tests, Rapid Score contract tests, and docs/config tests.
- [ ] **Step 2: Run static and Django gates.** Run `uv sync --locked --extra dev`, `python manage.py check`, `python manage.py check --deploy` with the production test environment, `python manage.py makemigrations --check --dry-run`, Ruff format/check, mypy, and `npm run check:css`.
- [ ] **Step 3: Run full local suite.** Run `python -m pytest -q`; record pass/skip counts and investigate every warning because pytest warnings are errors.
- [ ] **Step 4: Run Docker gates.** Run `pwsh -NoProfile -File scripts/verify_postgres_acceptance.ps1 -StartCompose -VerifyResetSafety` and `pwsh -NoProfile -File scripts/verify_postgres_backup_restore.ps1 -ComposeProjectName artflow -BackupPath backups/artflow-rehearsal.dump`; verify source services/volumes remain intact.
- [ ] **Step 5: Self-review round one.** Review the full diff against `ChatGPT.md`, the spec, and GOAL v4. Trace Activity → child → result data flow, every state/identity mutation, idempotency transaction, and all HOLD/CONFLICT paths. Fix findings with tests.
- [ ] **Step 6: Self-review round two.** Review migration safety, `_base_manager`/bulk/delete/Admin bypasses, cross-activity leakage, secret/log exposure, multi-worker rate limit, stale browser behavior, production manifest topology, and fallback semantics. Fix findings with tests.
- [ ] **Step 7: Final verification and branch handoff.** Run `git diff --check`, inspect `git status --short`, commit any final scoped changes, push the feature branch, switch to `main`, pull fast-forward, merge with `--no-ff`, push `main`, and verify remote SHAs and CI runs. Keep the feature branch as required by repository policy.
