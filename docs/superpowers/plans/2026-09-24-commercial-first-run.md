# Commercial First-Run Provisioning Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a one-time, deployment-key-protected browser flow for creating the initial ArtFlow administrator.

**Architecture:** Keep `accounts.services.provision_first_admin()` as the only account and installation-state mutation authority. Add a thin form/view/URL boundary that validates CSRF, the existing admin key, rate limits, and installation status, then delegates to that service; extend the event launcher and purchaser docs only to advertise the route.

**Tech Stack:** Django forms/views/tests, Django session authentication, existing database rate limiter, PowerShell event launcher, Markdown documentation.

**Spec:** `docs/superpowers/specs/2026-09-24-commercial-first-run.md`

## Global Constraints

- The setup key is the existing `ADMIN_LOGIN_KEY`; no new environment variable is introduced.
- `provision_first_admin()` remains the only production write path for `User` and `InstallationState`.
- Setup is available only when provisioning status is `required`; `complete` and `inconsistent` fail closed.
- POST requires CSRF, constant-time key comparison, and the shared per-client rate limit.
- Passwords and setup keys must not appear in templates after submission, audit rows, logs, or command output.
- No competition model, scoring, result, release, permission, Docker volume, firewall, tunnel, or public-ingress behavior changes.

### Task 1: Lock the browser contract with failing tests

**Files:**
- Modify: `accounts/tests.py`
- Modify: `scripts/tests/test_event_runtime_contract.py`

**Interfaces:**
- Tests will require `reverse("accounts:first_admin_setup")` to resolve to the new browser boundary.
- Tests will require a `FirstAdminSetupForm`-backed view to use `provision_first_admin()` and the existing admin verification session marker.

- [ ] **Step 1: Write the failing Django tests**

Add a dedicated `FirstAdminSetupViewTests` class covering:

```python
@override_settings(ADMIN_LOGIN_KEY="setup-secret")
def test_required_installation_renders_one_time_setup_form(self):
    response = self.client.get(reverse("accounts:first_admin_setup"))
    self.assertEqual(response.status_code, 200)
    self.assertContains(response, "首次初始化")
    self.assertContains(response, 'name="setup_key"')

@override_settings(ADMIN_LOGIN_KEY="setup-secret")
def test_wrong_setup_key_does_not_provision(self):
    response = self.client.post(
        reverse("accounts:first_admin_setup"),
        {"username": "event-admin", "password": "a-strong-bootstrap-pass", "password_confirm": "a-strong-bootstrap-pass", "setup_key": "wrong"},
    )
    self.assertEqual(response.status_code, 200)
    self.assertContains(response, "管理员密钥错误")
    self.assertEqual(User.objects.count(), 0)

@override_settings(ADMIN_LOGIN_KEY="setup-secret")
def test_valid_setup_provisions_and_redirects_to_staff(self):
    response = self.client.post(
        reverse("accounts:first_admin_setup"),
        {"username": "event-admin", "password": "a-strong-bootstrap-pass", "password_confirm": "a-strong-bootstrap-pass", "setup_key": "setup-secret"},
    )
    self.assertRedirects(response, reverse("staff:dashboard"), fetch_redirect_response=False)
    user = User.objects.get(username="event-admin")
    self.assertTrue(user.is_admin)
    self.assertFalse(user.is_superuser)
    self.assertTrue(self.client.session.get("artflow_admin_verified"))

@override_settings(ADMIN_LOGIN_KEY="setup-secret")
def test_completed_installation_hides_setup_endpoint(self):
    provision_first_admin(username="event-admin", password="a-strong-bootstrap-pass")
    response = self.client.get(reverse("accounts:first_admin_setup"))
    self.assertEqual(response.status_code, 404)
```

Also add an `enforce_csrf_checks=True` client test proving a POST without a CSRF token is rejected, and a test proving a placeholder setup key is rejected without mutation.

Extend the launcher contract test to require the printed setup URL while preserving the existing unsafe-operation assertions.

- [ ] **Step 2: Run the focused tests and verify the expected RED state**

Run:

```powershell
python -m pytest accounts/tests.py::FirstAdminSetupViewTests scripts/tests/test_event_runtime_contract.py -q
```

Expected result: collection or assertions fail because the form, URL, view, and launcher output do not yet exist. Do not keep implementation changes before this failure is observed.

- [ ] **Step 3: Commit the failing contract tests**

```powershell
git add accounts/tests.py scripts/tests/test_event_runtime_contract.py
git commit -m "test: define commercial first-run setup contract"
```

### Task 2: Add the protected setup boundary

**Files:**
- Modify: `accounts/forms.py`
- Modify: `accounts/views.py`
- Modify: `accounts/urls.py`
- Test: `accounts/tests.py`

**Interfaces:**
- Produce `FirstAdminSetupForm` with fields `username`, `password`, `password_confirm`, and `setup_key`.
- Produce `accounts:first_admin_setup` at `/setup/`.
- The view calls `provision_first_admin(username=..., password=...)` and, on success, calls `login()` and `mark_admin_verified()`.

- [ ] **Step 1: Implement only the minimum form, route, and view needed by the tests**

Use `constant_time_compare` against `settings.ADMIN_LOGIN_KEY`, reject an empty or known placeholder configured key, add the existing `FIRST_ADMIN_SETUP_RATE_LIMIT` boundary through `_allow_form_submission`, and return `Http404` unless `installation_provisioning_status() == "required"`. Catch the service's `ValidationError` and attach only its user-actionable messages to the form; never include submitted secrets.

On success, call:

```python
user = provision_first_admin(
    username=form.cleaned_data["username"],
    password=form.cleaned_data["password"],
)
login(request, user)
mark_admin_verified(request.session)
return redirect("staff:dashboard")
```

Do not add direct model saves, a reset branch, or a superuser flag.

- [ ] **Step 2: Run the focused Django tests**

```powershell
python manage.py test accounts.tests.FirstAdminSetupViewTests
```

Expected result: all setup view tests pass.

- [ ] **Step 3: Run the accounts regression suite**

```powershell
python manage.py test accounts
```

Expected result: all accounts tests pass with no new warnings.

- [ ] **Step 4: Commit the behavior**

```powershell
git add accounts/forms.py accounts/views.py accounts/urls.py accounts/tests.py
git commit -m "feat: add protected commercial first-run setup"
```

### Task 3: Make the purchaser path discoverable

**Files:**
- Create: `templates/accounts/first_admin_setup.html`
- Modify: `scripts/start-event.ps1`
- Modify: `scripts/tests/test_event_runtime_contract.py`
- Modify: `docs/deployment-event.md`
- Modify: `README.md`
- Modify: `docs/development-baseline.md`

**Interfaces:**
- The setup template renders the four form fields, CSRF token, non-secret errors, and no password/setup-key values after a failed POST.
- The event launcher prints a one-time setup URL after health succeeds without inspecting or printing environment values.

- [ ] **Step 1: Add the minimal template and launcher output**

Keep the form copy explicit: the setup key is the value of `ADMIN_LOGIN_KEY`; setup is one-time; the endpoint disappears after success. Add:

```powershell
Write-Host "First-admin setup (before provisioning): http://127.0.0.1:$Port/setup/"
```

Do not change Compose bindings or add secret generation.

- [ ] **Step 2: Run focused contract and template checks**

```powershell
python -m pytest accounts/tests.py::FirstAdminSetupViewTests scripts/tests/test_event_runtime_contract.py -q
```

Expected result: all focused tests pass.

- [ ] **Step 3: Update purchaser documentation**

Document browser setup as the primary event path, keep the CLI command as a technical fallback, state that the setup key is not the admin password, and preserve the existing no-volume-deletion/LAN safety warnings.

- [ ] **Step 4: Run documentation validation**

```powershell
pwsh -NoProfile -File scripts/check_docs.ps1
```

Expected result: documentation validation passes.

- [ ] **Step 5: Commit the purchaser path**

```powershell
git add templates/accounts/first_admin_setup.html scripts/start-event.ps1 scripts/tests/test_event_runtime_contract.py docs/deployment-event.md README.md docs/development-baseline.md
git commit -m "feat: expose commercial first-run setup path"
```

### Task 4: Perform full verification and merge

**Files:**
- Modify: `docs/superpowers/plans/2026-09-24-commercial-first-run.md`

- [ ] **Step 1: Run focused static and type gates**

```powershell
python -m ruff check .
python -m ruff format --check .
python manage.py check
python manage.py makemigrations --check --dry-run
npm run check:pyright
npm run check:pyright:entry-access
npm run check:client
npm run test:client
```

- [ ] **Step 2: Run the complete application and browser checks**

```powershell
python manage.py test
npx playwright test tests/e2e/runtime-smoke.spec.ts tests/e2e/ticket-boundary.spec.ts
```

- [ ] **Step 3: Run Docker PostgreSQL and backup/restore gates without deleting source volumes**

```powershell
pwsh -NoProfile -File scripts/verify_postgres_acceptance.ps1 -StartCompose -VerifyResetSafety
pwsh -NoProfile -File scripts/verify_postgres_backup_restore.ps1 -ComposeProjectName artflow -BackupPath backups/artflow-rehearsal.dump
```

- [ ] **Step 4: Perform two self-reviews**

Review one checks the spec line by line against code/tests/docs, especially the setup-key, CSRF, status, rate-limit, and authority boundaries. Review two checks the diff for secret leakage, direct ORM authority bypasses, session behavior, route exposure, and accidental Docker/data operations.

- [ ] **Step 5: Update the execution record and commit the plan record**

Append exact command results, test counts, and self-review findings to this plan, then commit only the plan record if it changed.

- [ ] **Step 6: Push the feature branch, merge to main, push main, and verify remote gates**

```powershell
git push -u origin feat/commercial-first-run
git switch main
git pull --ff-only origin main
git merge --no-ff feat/commercial-first-run
git push origin main
gh run list --branch main --limit 4
```

Keep the feature branch until the final `git status`, remote SHA, and Docker service status are verified.

## Plan self-review

- Spec coverage: setup UX, key/CSRF/rate-limit protection, one-time service delegation, session behavior, launcher discovery, docs, and full gates are covered by Tasks 1–4.
- Placeholder scan: no task depends on an unspecified function or a future implementation; exact files, route, fields, commands, and expected outcomes are named.
- Type consistency: `FirstAdminSetupForm`, `accounts:first_admin_setup`, and the `provision_first_admin()`/`login()`/`mark_admin_verified()` sequence are used consistently throughout.
