# Pre-M2-D2 Code Cleanup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Execute inline in the current checkout; do not use a worktree or subagent.

**Goal:** Remove confirmed dead scaffolding and obsolete runtime surfaces before M2-D2 without weakening authority boundaries or deleting live data silently.

**Architecture:** Keep the current lifecycle authority in `Activity.phase`; retire the unused `ActivityPhase` and `QRCodeLink` models through a guarded migration. Keep `entry_access` as a Judge transport/service boundary, but remove its unused generic HTTP mutation routes so issuance and revocation remain reachable only through domain-specific services.

**Tech Stack:** Django 6, PostgreSQL/SQLite test database, pytest contract tests, PowerShell scripts, Node rehearsal tooling.

**Spec:** Approved inline design in the 2026-09-21 cleanup discussion; the audit scope is limited to mechanical cleanup, guarded model retirement, and entry-access HTTP surface reduction.

## Global Constraints

- Work inline on the current branch; do not create `.worktree/`, `worktrees/`, or spawn subagents.
- Preserve all historical migrations; add a new migration instead of editing old migration files.
- Never silently delete `ActivityPhase` or `QRCodeLink` rows; the retirement migration must abort if either table contains rows.
- Preserve `entry_access` services, Judge `JUDGE` flow, redeem endpoint, audit actions, and authority checks.
- Every logical change is a separate conventional commit with focused verification.
- Before production Python commits, run `npm run check:pyright` and `npm run check:pyright:entry-access`.

---

### Task 1: Remove confirmed dead scaffolding and helpers

**Files:**
- Delete: `archive/admin.py`, `archive/tests.py`, `archive/views.py`
- Delete: `common/admin.py`
- Delete: `core/views.py`
- Delete: `exports/admin.py`, `exports/tests.py`, `exports/views.py`
- Delete: `files/views.py`
- Delete: `incidents/admin.py`, `incidents/tests.py`, `incidents/views.py`
- Delete: `staff_panel/admin.py`, `staff_panel/models.py`
- Modify: `common/business_rules.py`
- Modify: `common/lifecycle.py`
- Modify: `common/test_contest_domain_characterization.py`
- Delete: `scripts/m2_d1_result_closure_rehearsal.mjs`

**Interfaces:**
- Produces no new production interface.
- Keeps `runtime_approved_singers`, `scope_runtime`, `scope_lifecycle`, and all current M2-D1 mutation rehearsal assets.

- [ ] **Step 1: Confirm no live imports or script consumers**

Run:

```powershell
rg -n "ensure_vote_session_unlocked|runtime_performances|m2_d1_result_closure_rehearsal\.mjs" --glob '!docs/superpowers/**' --glob '!.superpowers/**' .
```

Expected: only the helper definition, the characterization import/tests, and no current rehearsal consumer for the old script.

- [ ] **Step 2: Remove the unused helper/test and empty modules**

Delete only the files listed above and remove the `runtime_performances` import and its two characterization tests. Do not remove app `apps.py`, `models.py`, `admin.py`, or `tests.py` files that contain real code.

- [ ] **Step 3: Run focused verification**

```powershell
python manage.py test common core staff_panel
python manage.py check
git diff --check
```

Expected: all selected Django tests pass, Django check is clean, and diff check exits 0.

- [ ] **Step 4: Commit**

```powershell
git add -u archive common/admin.py common/business_rules.py common/lifecycle.py common/test_contest_domain_characterization.py core/views.py exports files/views.py incidents staff_panel scripts/m2_d1_result_closure_rehearsal.mjs
git commit -m "chore: remove confirmed dead scaffolding"
```

### Task 2: Retire unused core models with a guarded migration

**Files:**
- Create: `core/migrations/0005_retire_unused_phase_and_qr_models.py`
- Modify: `core/models.py`
- Modify: `core/admin.py`
- Modify: `core/tests.py`

**Interfaces:**
- Removes the runtime models `ActivityPhase` and `QRCodeLink`.
- Keeps `Activity.phase`, `Activity.Phase`, lifecycle services, and all phase-policy tests.

- [ ] **Step 1: Write the failing retirement contract**

Add a `CoreModelTests` case that asserts `apps.get_model("core", "ActivityPhase")` and `apps.get_model("core", "QRCodeLink")` raise `LookupError`. Keep the test independent of direct imports of the retired models.

- [ ] **Step 2: Run the contract test to verify RED**

```powershell
python manage.py test core.tests.CoreModelTests.test_retired_phase_and_qr_models_are_not_registered
```

Expected: failure because both models are still registered.

- [ ] **Step 3: Remove runtime references and add the migration**

Remove the two model classes and admin registrations. Remove only the obsolete model-existence test and its imports; retain all tests that exercise `Activity.phase` and phase transitions.

Create migration `0005_retire_unused_phase_and_qr_models.py` depending on `0004_alter_activity_options`. Its first operation must be a `RunPython` preflight that queries the historical models and raises `RuntimeError` with the model name and row count if either table is non-empty. Only after the preflight add `migrations.DeleteModel("QRCodeLink")` and `migrations.DeleteModel("ActivityPhase")`.

- [ ] **Step 4: Run migration and focused verification**

```powershell
python manage.py migrate
python manage.py test core.tests.CoreModelTests core.tests.ActivityPhasePolicyTests core.tests.ActivityPhaseTransitionTests
python manage.py makemigrations --check --dry-run
python manage.py check
```

Expected: migration applies on the verified zero-row local database, the retirement contract passes, phase policy/transition tests pass, and no model changes are pending.

- [ ] **Step 5: Run type gates and commit**

```powershell
npm run check:pyright
npm run check:pyright:entry-access
git diff --check
git add core/models.py core/admin.py core/tests.py core/migrations/0005_retire_unused_phase_and_qr_models.py
git commit -m "chore: retire unused core models"
```

### Task 3: Remove unused generic entry-access HTTP mutations

**Files:**
- Modify: `entry_access/urls.py`
- Modify: `entry_access/views.py`
- Modify: `entry_access/tests.py`
- Modify: `scripts/tests/test_cleanup_contract.py` (create if needed)

**Interfaces:**
- Keeps `entry_access:grant_redeem`, `issue_access_grant`, `revoke_access_grant`, and `revoke_ephemeral_session` service APIs.
- Removes only `entry_access:grant_issue`, `entry_access:grant_revoke`, and `entry_access:session_revoke` HTTP routes and views.
- Keeps `EntryPoint.Kind.JUDGE`, `SCANNER`, and `OPERATIONAL` choices in this task for compatibility.

- [ ] **Step 1: Write the failing route contract**

Add a contract test that requests `/entry-access/grants/issue/`, `/entry-access/grants/<id>/revoke/`, and `/entry-access/sessions/<id>/revoke/` and asserts 404. The test must also assert that the redeem route remains resolvable.

- [ ] **Step 2: Run the contract test to verify RED**

```powershell
pytest scripts/tests/test_cleanup_contract.py -q
```

Expected: failure because the three generic routes currently resolve.

- [ ] **Step 3: Remove only the generic HTTP layer**

Delete the three URL patterns and their view functions/imports. Remove only HTTP tests for those routes; retain service issuance/revocation tests, redeem HTTP tests, authority tests, rate-limit tests, and Judge integration tests.

- [ ] **Step 4: Run entry-access verification**

```powershell
python manage.py test entry_access singer_contest common.test_authority_matrix
pytest scripts/tests/test_cleanup_contract.py -q
python manage.py check
```

Expected: all remaining entry-access and authority tests pass; the generic routes return 404 and redeem remains available.

- [ ] **Step 5: Run type gates and commit**

```powershell
npm run check:pyright
npm run check:pyright:entry-access
git diff --check
git add entry_access scripts/tests/test_cleanup_contract.py
git commit -m "fix: narrow entry access HTTP surface"
```

### Task 4: Cleanup audit and M2-D2 handoff

**Files:**
- Modify: `docs/production-readiness.md` only if the retired models or removed routes are documented as active.
- Modify: `docs/m2-d1-result-closure-matrix.md` only if it names the deleted old rehearsal script.

- [ ] **Step 1: Search for stale references**

```powershell
rg -n "ActivityPhase|QRCodeLink|phase_records|qr_links|grant_issue|grant_revoke|session_revoke|m2_d1_result_closure_rehearsal\.mjs|runtime_performances|ensure_vote_session_unlocked" --glob '!**/migrations/**' .
```

Expected: no active production/docs references except intentional historical migration text and the cleanup plan itself.

- [ ] **Step 2: Run the full local gates**

```powershell
python manage.py check
python manage.py makemigrations --check --dry-run
python manage.py test
npm run check:pyright
npm run check:pyright:entry-access
pwsh -NoProfile -File scripts/check_docs.ps1
git diff --check
git status --short --branch
```

- [ ] **Step 3: Perform two self-reviews**

Review 1: verify every deletion has no live consumer, every removed route is 404, redeem/Judge/service authority remains, and the guarded migration cannot silently discard rows.

Review 2: inspect the complete diff and migration graph for contract drift, stale imports, Pylance diagnostics, security regressions, and accidental M2-D2 behavior changes.

- [ ] **Step 4: Commit documentation corrections separately, if required**

```powershell
git add docs/production-readiness.md docs/m2-d1-result-closure-matrix.md
git commit -m "docs: refresh cleanup references"
```

