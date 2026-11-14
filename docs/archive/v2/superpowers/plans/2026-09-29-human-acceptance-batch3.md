# Human Acceptance Batch 3 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Execute this plan inline with test-first changes and small independently verifiable commits. Do not use linked worktrees or delegate repository work to subagents.

**Goal:** Close the current human-acceptance audit so that a newly provisioned operator can create an activity, configure a singer contest, prepare rounds, and edit public/questionnaire content without guaranteed-failure controls, misleading fields, or authority drift.

**Architecture:** Keep authority in domain services and derive every operational selector from the current activity/round scope. Add presentation helpers only at the staff boundary; do not weaken model guards. Centralize file-purpose policy data and make forms/widgets consume it instead of duplicating defaults. Add regression tests at the owning app boundary before each production change.

**Tech Stack:** Django forms/views/services/models, Django `TestCase`, pytest-compatible project tests, Tailwind-generated CSS, Playwright E2E, Ruff, Pyright/Pylance.

**Spec:** `C:/Users/16275/Desktop/advices/ChatGPT.md`

## Global Constraints

- Keep `main` clean before branching and use `build/human-acceptance-batch3` for this batch.
- Every logical change is a conventional, independently verifiable commit.
- Do not add a second authority path or direct ORM write for locked/confirmed facts.
- Do not expose access keys, uploaded media, or private file paths in logs, templates, or tests.
- Preserve historical source-less `Award` rows for reads while denying new source-less production writes.
- Keep production and event activity selectors restricted to singer-contest activities where the downstream service requires it.
- Run the focused test before each commit; run the required project gates before merge.

---

### Task 1: Restore the blocking formatting gate

**Files:**
- Modify: `questionnaire/builder.py`
- Modify: `ruleset/editor.py`
- Modify: `staff_panel/forms.py`
- Modify: `staff_panel/test_operator_forms.py`
- Modify: `staff_panel/tests.py`
- Modify: `staff_panel/views.py`

**Interfaces:** No runtime interface changes; only Ruff formatter output changes.

- [ ] **Step 1: Record the failing gate.**

Run:

```powershell
uv run ruff format --check .
```

Expected: the six files above are reported as unformatted.

- [ ] **Step 2: Apply the formatter only to the reported files.**

```powershell
uv run ruff format questionnaire/builder.py ruleset/editor.py staff_panel/forms.py staff_panel/test_operator_forms.py staff_panel/tests.py staff_panel/views.py
```

- [ ] **Step 3: Verify and commit.**

```powershell
uv run ruff format --check .
git diff --check
git add questionnaire/builder.py ruleset/editor.py staff_panel/forms.py staff_panel/test_operator_forms.py staff_panel/tests.py staff_panel/views.py
git commit -m "style: satisfy ruff format gate"
```

---

### Task 2: Make current-round roster selection authoritative

**Files:**
- Modify: `singer_contest/services.py`
- Modify: `staff_panel/views.py`
- Test: `staff_panel/tests.py` or `staff_panel/tests_operator_e2e.py`

**Interfaces:** Add/reuse one service-level selector that returns the authoritative singer queryset for a specific `ContestRound`; `round_running_order`, `round_groups`, judge controls, and related staff reads consume it.

- [ ] **Step 1: Add failing tests.**

Cover both cases:

```python
def test_draft_round_running_order_uses_current_round_roster_before_prepare(self):
    # Create an approved singer who is eligible for the draft round but no RoundEntry yet.
    response = self.client.get(reverse("staff:round_running_order", args=[self.round.pk]))
    self.assertEqual(response.context["order_rows"], [self.singer.pk])

def test_later_round_groups_exclude_singers_not_in_round_roster(self):
    # The later round has a stage/advancement source containing only the eligible singer.
    response = self.client.get(reverse("staff:round_groups", args=[self.round.pk]))
    choices = {value for value, _label in response.context["form"].fields["group_1"].choices}
    self.assertNotIn(str(self.eliminated.pk), choices)
```

Run the focused tests and confirm the first currently renders an empty order or the second exposes an eliminated singer.

- [ ] **Step 2: Trace the existing roster-source service and round-entry creation path.**

Use the existing `roster_source`, `roster_source_stage`, `StageResult`, and `ContestRoundEntry` rules. Do not fall back to all approved singers for a later round.

- [ ] **Step 3: Implement the selector once and replace the staff view queries.**

The selector must return:

```python
current_round_roster(contest_round) -> QuerySet[SingerRegistration]
```

For a prepared round, prefer the persisted round entries; for an unprepared round, resolve the configured source using the same service used by `prepare_round()`. Keep the result scoped to the current activity.

- [ ] **Step 4: Verify and commit.**

```powershell
uv run python manage.py test staff_panel singer_contest --keepdb
git diff --check
git add singer_contest/services.py staff_panel/views.py staff_panel/tests.py staff_panel/tests_operator_e2e.py
git commit -m "fix: align operator roster reads with round authority"
```

---

### Task 3: Enforce scoring rubric percentages at the service boundary

**Files:**
- Modify: `singer_contest/services.py`
- Modify: `staff_panel/forms.py`
- Modify: `templates/staff_panel/rubric_form.html`
- Test: `singer_contest/tests.py` and `staff_panel/test_operator_forms.py`

**Interfaces:** `create_scoring_rubric()` rejects criteria whose `Decimal` weights do not total `Decimal("100")`; the form displays the total and preserves the server-side error.

- [ ] **Step 1: Write and run failing service/form tests.**

```python
def test_create_scoring_rubric_rejects_non_100_percent_criteria(self):
    with self.assertRaisesMessage(ValidationError, "100"):
        create_scoring_rubric(self.activity, name="评委评分", criteria=[
            {"name": "演唱", "max_score": "40"},
            {"name": "表现", "max_score": "40"},
        ], operator=self.admin)
```

Add a form assertion that the rendered form exposes the current total and a clear instruction.

- [ ] **Step 2: Validate the normalized criteria total in the service before persistence.**

Use `Decimal("100")`, not floats. Keep the existing rubric configuration error contract for judge execution.

- [ ] **Step 3: Add a small total-display script or server-rendered total to the form.**

The client display is UX only; the service remains authoritative.

- [ ] **Step 4: Run focused tests and commit.**

```powershell
uv run python manage.py test singer_contest staff_panel.test_operator_forms
git add singer_contest/services.py staff_panel/forms.py templates/staff_panel/rubric_form.html singer_contest/tests.py staff_panel/test_operator_forms.py
git commit -m "fix: require scoring rubric weights to total one hundred"
```

---

### Task 4: Centralize questionnaire file-purpose policies

**Files:**
- Create: `files/policies.py`
- Modify: `files/services.py`
- Modify: `questionnaire/schema.py`
- Modify: `questionnaire/builder.py`
- Modify: `questionnaire/staff_views.py`
- Modify: relevant questionnaire/file templates
- Test: `files/tests.py` and `questionnaire/test_builder.py`

**Interfaces:** `FILE_PURPOSE_POLICIES` and `file_purpose_policy(purpose)` are the single registry for extensions and maximum size. Upload validation and questionnaire parsing use the same data.

- [ ] **Step 1: Add failing policy-consistency tests.**

Assert that the accompaniment policy includes the actual supported extensions and 100 MB ceiling, excludes `.mp4`, and rejects questionnaire definitions exceeding the policy for the selected purpose.

- [ ] **Step 2: Implement the registry without importing questionnaire code from `files`.**

Keep the registry dependency-free and use normalized lower-case extensions. Preserve the hard server ceiling as an outer bound.

- [ ] **Step 3: Replace upload constants, schema checks, and builder defaults with the registry.**

The structured editor must only offer policy-valid extensions/max values; participant help must display the same values.

- [ ] **Step 4: Verify and commit.**

```powershell
uv run python manage.py test files questionnaire
git add files/policies.py files/services.py questionnaire/schema.py questionnaire/builder.py questionnaire/staff_views.py templates
git commit -m "fix: unify file upload policies across questionnaire flows"
```

---

### Task 5: Close ruleset and activity lifecycle contract gaps

**Files:**
- Modify: `staff_panel/views.py`
- Modify: `staff_panel/forms.py`
- Modify: `ruleset/models.py` or the owning ruleset model module
- Modify: `templates/staff_panel/ruleset_create.html`
- Test: `staff_panel/tests.py`

**Interfaces:** Ruleset creation only offers unlocked, non-archived singer-contest activities; `ContestRoundForm` receives validated stage choices; invalid activity edits roll back phase/audit writes.

- [ ] **Step 1: Add failing tests for three cases.**

```python
def test_ruleset_create_does_not_offer_farewell_activity(self): ...
def test_invalid_activity_type_does_not_commit_phase_transition(self): ...
def test_round_stage_source_must_match_current_ruleset_checkpoint(self): ...
```

- [ ] **Step 2: Filter the view querysets and validate domain errors into form errors.**

Keep model-level validation intact; the UI must not offer guaranteed-invalid choices.

- [ ] **Step 3: Validate `roster_source_stage` against the current ruleset’s real stage/checkpoint keys.**

Use a choice field for normal UI and retain service-side validation for crafted POSTs.

- [ ] **Step 4: Prevent partial activity edits.**

Validate immutable activity-type intent before `transition_activity_phase()`, and mark the atomic transaction for rollback on any later `ValidationError`.

- [ ] **Step 5: Verify and commit.**

```powershell
uv run python manage.py test staff_panel ruleset core
git add staff_panel/views.py staff_panel/forms.py ruleset core templates/staff_panel/ruleset_create.html
git commit -m "fix: close activity and ruleset form authority gaps"
```

---

### Task 6: Enforce audience pool scope and Award creation authority

**Files:**
- Modify: `staff_panel/views.py`
- Modify: `singer_contest/models.py`
- Modify: `singer_contest/services.py`
- Modify: `common/authority.py` if a narrowly scoped materialization context is required
- Test: `staff_panel/tests.py` and `singer_contest/tests.py`

**Interfaces:** Audience score POST accepts only singers in the authoritative current set; new source-less `Award` creation is rejected outside an explicit internal legacy import/materialization path, while existing source-less rows remain readable.

- [ ] **Step 1: Write failing security tests.**

```python
def test_audience_score_rejects_singer_outside_current_set(self): ...
def test_new_source_less_award_cannot_be_created_by_direct_orm(self): ...
def test_historical_source_less_award_remains_readable(self): ...
```

Create the historical row only through a test fixture mechanism that represents an existing database row; do not add a public bypass.

- [ ] **Step 2: Make the audience POST derive and enforce the same pool used for display.**

If the set is not ready, fail closed instead of broadening to all approved singers.

- [ ] **Step 3: Add a model save gate for new source-less Award rows.**

Require the existing materialization authority and source provenance for new rows. Keep ordinary reads and admin observation of historical rows unchanged.

- [ ] **Step 4: Verify and commit.**

```powershell
uv run python manage.py test staff_panel singer_contest
git add staff_panel/views.py singer_contest/models.py singer_contest/services.py common/authority.py staff_panel/tests.py singer_contest/tests.py
git commit -m "fix: enforce audience and award result authority"
```

---

### Task 7: Restore scoped operator navigation and usable controls

**Files:**
- Modify: `staff_panel/views.py`
- Modify: `staff_panel/forms.py`
- Modify: `staff_panel/urls.py`
- Create or modify: `templates/staff_panel/activity_workspace.html`
- Modify: `templates/staff_panel/dashboard.html`, `activity_list.html`, `round_form.html`, `vote_session_form.html`, `rubric_form.html`
- Test: `staff_panel/tests.py`

**Interfaces:** Add an activity workspace route; propagate `activity_id` through rubric → round and activity → round/vote links; bare create pages choose or explain a valid singer activity instead of silently showing empty dependent fields.

- [ ] **Step 1: Add failing navigation tests.**

Assert that the workspace links include `activity_id`, rubric success redirects to the scoped round URL, and a normal dashboard path exposes at least one valid rubric/singer choice.

- [ ] **Step 2: Add the workspace view/template and URL.**

The workspace is a navigation boundary, not a new authority layer. Each card points to the existing scoped staff flow.

- [ ] **Step 3: Propagate and default activity context in create views.**

Use only eligible singer-contest activities. Never expand a queryset to all activities merely to make a selector non-empty.

- [ ] **Step 4: Add reusable field widgets/classes and `datetime-local` inputs.**

Apply the same class contract to round, vote, rubric, and date-time fields without changing stored values.

- [ ] **Step 5: Verify and commit.**

```powershell
uv run python manage.py test staff_panel
git add staff_panel/views.py staff_panel/forms.py staff_panel/urls.py templates/staff_panel
git commit -m "fix: make activity-scoped operator flows usable"
```

---

### Task 8: Make public-post forms honest and lossless

**Files:**
- Modify: `staff_panel/views.py`
- Modify: `templates/staff_panel/post_form.html`
- Test: `staff_panel/tests.py`

**Interfaces:** Invalid create/edit POSTs re-render submitted bound values; non-admins cannot select a status that the backend will reject as published.

- [ ] **Step 1: Add failing tests for invalid retention and staff status choices.**

```python
def test_post_create_invalid_retains_submitted_fields(self): ...
def test_post_edit_invalid_retains_submitted_fields(self): ...
def test_staff_post_form_does_not_offer_published(self): ...
```

- [ ] **Step 2: Pass the bound form back to both templates and filter status choices by current role.**

Keep the server-side admin-only publication guard.

- [ ] **Step 3: Verify and commit.**

```powershell
uv run python manage.py test staff_panel
git add staff_panel/views.py templates/staff_panel/post_form.html staff_panel/tests.py
git commit -m "fix: make public post editing preserve user input"
```

---

### Task 9: Add the first human-acceptance browser journey

**Files:**
- Create: `tests/e2e/human_acceptance_batch3.spec.mjs`
- Modify: Playwright workflow/config only if the existing gate needs registration
- Modify: `docs/production-readiness.md` or the active human-acceptance runbook

**Interfaces:** A visible-navigation Playwright path covers fresh Admin → activity workspace → rubric → round → vote/ruleset controls at desktop and 375px. It must not create fixtures by direct ORM or jump to deep URLs as its primary path.

- [ ] **Step 1: Add a failing spec against the current UI.**

Use the existing login/register helpers and assert visible Chinese business labels, no blank dependent selector, no guaranteed-failure status, and no visible low-contrast brand badge.

- [ ] **Step 2: Run the spec and record the first failure.**

```powershell
npx playwright test tests/e2e/human_acceptance_batch3.spec.mjs --project=chromium
```

- [ ] **Step 3: Wire the already-fixed flows into the journey and add mobile viewport coverage.**

Keep the existing fixture env contract explicit; do not silently skip this journey when its fixture is absent.

- [ ] **Step 4: Verify and commit.**

```powershell
npx playwright test tests/e2e/human_acceptance_batch3.spec.mjs --project=chromium
git add tests/e2e/human_acceptance_batch3.spec.mjs docs/production-readiness.md .github/workflows
git commit -m "test: add human acceptance operator journey"
```

---

### Task 10: Final gates and two-pass self-review

**Files:** Any files from the completed tasks only.

- [ ] **Step 1: Run focused tests for every changed subsystem.**
- [ ] **Step 2: Run repository gates.**

```powershell
uv run python manage.py check
uv run python manage.py makemigrations --check --dry-run
uv run ruff check .
uv run ruff format --check .
npm run check:pyright
npm run check:pyright:entry-access
npm run check:css
npm run check:client
npm run test:client
```

- [ ] **Step 3: Review pass one — contract and authority.**

Re-read the advice matrix and inspect every changed route/service/model for activity scope, role checks, lock/confirmation rules, transaction rollback, and source provenance. Search for direct ORM writes and all old duplicate file-policy constants.

- [ ] **Step 4: Review pass two — human behavior and operations.**

Walk the browser journey at desktop and mobile, inspect invalid form retention, labels, button affordances, status choices, and error copy. Review `git diff --check`, migration state, tracked files, and secret/media exclusion.

- [ ] **Step 5: Commit verification metadata and report only fresh evidence.**

Do not merge until the local gates and relevant Playwright path are green. Keep the feature branch until the non-fast-forward merge, push, and remote CI result are confirmed.
