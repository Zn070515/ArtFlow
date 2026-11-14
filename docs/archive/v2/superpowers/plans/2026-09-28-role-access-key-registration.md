# Role Access-Key Registration and Login Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the participant-only public registration UX with direct participant, staff, and admin registration/login flows using independent role access keys.

**Architecture:** Keep the existing three persistent `User.Role` values and Judge's temporary grant model. Add `STAFF_ACCESS_KEY` and `ADMIN_ACCESS_KEY` as environment-only secrets, route all role creation through account services under `ACCOUNT_AUTHORITY`, and keep the existing admin verification/last-admin protections. Remove the old `/setup/` user-facing route instead of maintaining an alias.

**Tech Stack:** Django 6, Django forms/authentication, PostgreSQL/SQLite test matrix, server-rendered templates, Playwright browser smoke, Ruff, mypy, Pyright.

**Spec:** `docs/superpowers/specs/2026-09-28-role-access-key-registration-design.md`

## Global Constraints

- Staff and admin registration and login require username, password, and the matching role access key.
- `STAFF_ACCESS_KEY` and `ADMIN_ACCESS_KEY` are environment-only secrets; `ADMIN_LOGIN_KEY` is removed with no compatibility alias.
- Registration and role/status mutations must use account authority services; no view may assign `User.role` directly.
- The existing shared credential throttle remains in use for participant, staff, and admin credential submissions.
- The existing admin recent-verification window and last-effective-admin protection remain unchanged.
- Judge, Ticket, Ruleset, voting, Activity, and event authority code are out of scope.
- Every task ends with its focused gate and a small conventional commit.

---

### Task 1: Replace the environment and deployment configuration contract

**Files:**
- Modify: `config/settings.py` — expose `STAFF_ACCESS_KEY` and `ADMIN_ACCESS_KEY` and remove `ADMIN_LOGIN_KEY`.
- Modify: `config/runtime.py` — require and validate both role keys in production without echoing their values.
- Modify: `config/tests.py` — cover missing, placeholder, and valid role keys.
- Modify: `.env.example`
- Modify: `.env.event.example`
- Modify: `.env.production.example`
- Modify: `deploy/compose.event.yml`
- Modify: `deploy/compose.production.yml`
- Modify: `common/management/commands/doctor.py` and its tests — report non-secret key configuration status using the new names.
- Modify: `docs/deployment-event.md`, `docs/deployment-production.md`, `docs/development-baseline.md`, `docs/production-rehearsal-runbook.md` — replace old key instructions and remove `/setup/` user-facing instructions.

**Interfaces:**
- Produces `settings.STAFF_ACCESS_KEY` and `settings.ADMIN_ACCESS_KEY`.
- Production validation rejects an empty or placeholder value for either key with a generic variable-specific message that never contains the value.
- Both Compose manifests pass both keys into the web service; no manifest passes `ADMIN_LOGIN_KEY`.

- [ ] **Step 1: Write failing configuration tests.** Add assertions that valid production settings require both new keys, reject an empty/placeholder staff or admin key, and do not accept `ADMIN_LOGIN_KEY` as a substitute.

- [ ] **Step 2: Run the focused configuration tests to verify failure.**

Run: `uv run pytest -q config/tests.py tests/test_production_compose_config.py`

Expected: FAIL because settings, runtime validation, and Compose manifests still expose only `ADMIN_LOGIN_KEY`.

- [ ] **Step 3: Implement the minimal configuration change.** Rename the setting, update runtime validation and Compose interpolation, preserve existing `DEBUG`, database, and rate-limit checks, and update the doctor output to show only whether each role key is configured.

- [ ] **Step 4: Update examples and operational documentation.** Every setup example must contain `STAFF_ACCESS_KEY` and `ADMIN_ACCESS_KEY`; production instructions must state that changing them requires service restart and session clearing. Remove instructions that direct users to `/setup/`.

- [ ] **Step 5: Run focused gates.**

Run: `uv run pytest -q config/tests.py tests/test_production_compose_config.py common/tests.py -k "doctor or production or compose"`

Expected: PASS with no secret values in diagnostics or test output.

- [ ] **Step 6: Commit.**

```bash
git add config .env.example .env.event.example .env.production.example deploy common/management/commands/doctor.py common/tests.py docs
git commit -m "feat: split staff and admin access keys"
```

### Task 2: Add role-aware registration services and forms

**Files:**
- Modify: `accounts/forms.py` — replace the generic `RegisterForm` with explicit participant, staff, and admin registration forms; add role-key fields to staff/admin login forms.
- Modify: `accounts/services.py` — add `register_participant_account`, `register_staff_account`, and `register_admin_account`.
- Modify: `accounts/tests.py` — test service and form behavior, authority usage, first-admin initialization, and secret non-persistence.

**Interfaces:**
- `register_participant_account(*, username: str, password: str) -> User`
- `register_staff_account(*, username: str, password: str, access_key: str) -> User`
- `register_admin_account(*, username: str, password: str, access_key: str) -> User`
- Each service normalizes username, validates uniqueness and password policy, and creates the requested role inside `authority_write(ACCOUNT_AUTHORITY)`.
- `register_admin_account` validates `ADMIN_ACCESS_KEY` before delegating the first-admin branch to `provision_first_admin` or creating a normal admin.

- [ ] **Step 1: Write failing service tests.** Cover successful creation of participant/staff/admin, wrong-key rejection before database creation, duplicate username, password validation, first-admin installation-state transition, and creation of a second admin after initialization.

- [ ] **Step 2: Write failing form tests.** Assert staff/admin registration forms expose their own key field, login forms require their own key, and no form references `ADMIN_LOGIN_KEY`.

- [ ] **Step 3: Run the focused account tests to verify failure.**

Run: `uv run pytest -q accounts/tests.py -k "register or login or admin or access_key"`

Expected: FAIL because the new services/forms do not exist.

- [ ] **Step 4: Implement the service layer.** Use a private role-account helper for common username/password validation, compare access keys with `constant_time_compare`, create only the requested role under account authority, and preserve the existing first-admin service and last-admin protections.

- [ ] **Step 5: Implement the explicit forms.** Participant registration remains a normal `UserCreationForm`; staff/admin forms add a `PasswordInput` key field and validate the key through their service-facing cleaned data. Staff/admin authentication forms must reject role mismatches through the existing `confirm_login_allowed` behavior.

- [ ] **Step 6: Run focused tests and type gates.**

Run: `uv run pytest -q accounts/tests.py -k "register or login or admin or access_key"`; `uv run ruff check accounts/forms.py accounts/services.py accounts/tests.py`; `npm run check:pyright`; `npm run check:pyright:entry-access`

Expected: PASS with zero type diagnostics.

- [ ] **Step 7: Commit.**

```bash
git add accounts/forms.py accounts/services.py accounts/tests.py
git commit -m "feat: add role access-key account services"
```

### Task 3: Replace account views, routes, and templates

**Files:**
- Modify: `accounts/urls.py` — add `/register/staff/` and `/register/admin/`, retain `/register/` for participants, and remove `/setup/`.
- Modify: `accounts/views.py` — add role registration view helper, call the new services, pass role-specific forms to login views, and keep shared throttling.
- Modify: `templates/accounts/login.html` — show role cards with matching login/register links and explain that judges use QR/grant access.
- Modify: `templates/accounts/register.html` — make it explicitly participant registration.
- Create: `templates/accounts/staff_register.html`
- Create: `templates/accounts/admin_register.html`
- Modify: `templates/accounts/staff_login.html`, `templates/accounts/admin_login.html`, `templates/accounts/participant_login.html` — provide matching registration links and role-specific key fields.
- Remove: `templates/accounts/first_admin_setup.html`
- Modify: `templates/base.html` — show the role-specific registration choices instead of a misleading “选手注册” link as the only account action.
- Modify: `accounts/tests.py` — cover route status, redirects, rendered links, registration/login success, and cross-role rejection.

**Interfaces:**
- Registration POST handlers call exactly one of the three account services and log the created user in on success.
- Admin registration calls `mark_admin_verified` after successful account creation, including the first-admin branch.
- `/setup/` no longer resolves; there is no compatibility redirect.

- [ ] **Step 1: Write failing view and route tests.** Assert all three registration routes render, `/setup/` is not available, each successful registration lands on the matching role, wrong keys do not create users, and the identity chooser links every role correctly.

- [ ] **Step 2: Run focused HTTP tests to verify failure.**

Run: `uv run pytest -q accounts/tests.py -k "register or login or setup or chooser"`

Expected: FAIL because routes/templates still expose only participant registration and `/setup/`.

- [ ] **Step 3: Implement the view helper and explicit routes.** Keep the existing `_allow_form_submission` limits and `credential-login` identity buckets; use role-specific key validation through the forms/services; remove `first_admin_setup_view` from URL wiring.

- [ ] **Step 4: Implement the templates.** Use plain Chinese copy: “选手注册”, “工作人员注册”, and “管理员注册”; show only the relevant access-key field on staff/admin pages; never render the key value or technical authority/provisioning terms.

- [ ] **Step 5: Run focused HTTP tests and static checks.**

Run: `uv run pytest -q accounts/tests.py`; `uv run python manage.py check`; `uv run ruff check accounts/views.py accounts/urls.py`; `npm run check:pyright`

Expected: PASS.

- [ ] **Step 6: Commit.**

```bash
git add accounts templates/accounts templates/base.html
git commit -m "feat: add direct staff and admin account flows"
```

### Task 4: Update account security regression coverage

**Files:**
- Modify: `accounts/tests.py` — migrate existing admin-key fixtures to `ADMIN_ACCESS_KEY`, add staff-key login/registration matrix, and assert shared throttling.
- Modify: `tests/test_ux_contract.py` — assert the role chooser and registration labels/links.
- Modify: `tests/test_check_docs.py` and any docs contract fixtures — require the new configuration names and forbid stale `ADMIN_LOGIN_KEY`/`/setup/` instructions in active docs.
- Modify: `common/tests.py` — update doctor sentinel tests to prove neither access key value leaks.
- Modify: `tests/e2e/auth-entry.spec.ts` — add browser smoke for participant, staff, and admin entry pages without storing real secrets in traces or screenshots.

**Interfaces:**
- Test-only settings use stable sentinel strings that are never printed as page content.
- Browser tests use environment-provided test keys and assert success/error semantics without recording key values.

- [ ] **Step 1: Add the complete role matrix tests.** Cover participant → participant only, staff → staff only with staff key, admin → admin only with admin key, and all cross-role failures.

- [ ] **Step 2: Add secret-leak and throttle tests.** Check rendered HTML, audit rows, diagnostics, and error responses for absence of key values; verify repeated submissions use the existing shared throttle.

- [ ] **Step 3: Run the focused regression suite.**

Run: `uv run pytest -q accounts/tests.py common/tests.py tests/test_ux_contract.py tests/test_check_docs.py`

Expected: PASS.

- [ ] **Step 4: Run browser and client checks.**

Run: `npm run check:client`; `npm run test:client`; `npx playwright test tests/e2e/auth-entry.spec.ts --project=mobile-chromium`

Expected: PASS; no access key appears in trace, screenshot, or assertion output.

- [ ] **Step 5: Commit.**

```bash
git add accounts/tests.py common/tests.py tests/test_ux_contract.py tests/test_check_docs.py tests/e2e/auth-entry.spec.ts
git commit -m "test: cover role access-key account boundaries"
```

### Task 5: Full verification and merge preparation

**Files:**
- Modify: `CHANGELOG.md` — record the breaking account route/configuration change.
- Modify: `docs/development-baseline.md` and `README.md` — document the three user-facing registration paths and the two environment keys.

- [ ] **Step 1: Run repository gates.**

Run: `python manage.py check`; `python manage.py makemigrations --check --dry-run`; `uv run pytest -q`; `npm run check:css`; `npm run check:client`; `npm run test:client`; `npm run check:pyright`; `npm run check:pyright:entry-access`; `pwsh -NoProfile -File scripts/check_docs.ps1`; `git diff --check`

Expected: PASS; no migration is generated.

- [ ] **Step 2: Perform two self-reviews.**

Review one: trace every registration/login path and confirm the role key is checked before account creation/authentication, with no cross-role fallback.

Review two: search for `ADMIN_LOGIN_KEY`, `/setup/`, direct role assignment in views, key values in logs/templates, and any new type diagnostics; resolve every remaining active-tree hit or document historical-only references.

- [ ] **Step 3: Commit documentation.**

```bash
git add README.md CHANGELOG.md docs/development-baseline.md
git commit -m "docs: document role access-key onboarding"
```

- [ ] **Step 4: Merge and push.**

```bash
git status --short
git switch main
git pull --ff-only origin main
git merge --no-ff feat/role-access-key-registration
git push origin main
```

If push times out, retry through `127.0.0.1:12334` as required by `AGENTS.md`. Keep the branch until the merge and push are confirmed, then verify the final status and remote SHA before deleting it.
