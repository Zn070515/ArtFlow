# Ruleset Planning Audit Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the ruleset planning workbench preserve historical execution semantics, collect every business fact it needs, and report application readiness truthfully before any executable state is written.

**Architecture:** Keep `ruleset.planning` as the pure business-payload compiler, keep `ruleset.services` as the activity-locked authority for round/rubric materialization, and let the staff view ask for a database-aware preflight result. Stable `round_key` is the identity of a real `ContestRound`; `execution_refs` is an input authority map validated before materialization and updated only after the same transaction succeeds. The browser renders the current payload and current preview result instead of a page-load snapshot.

**Tech Stack:** Django services and `TestCase`/`SimpleTestCase`, Python `Decimal`, existing ruleset compiler, TypeScript browser bundle, Node client tests, Tailwind templates.

**Spec:** `C:\Users\16275\Desktop\advices\ChatGPT.md`

## Global Constraints

- Do not create a `ContestRound` during save or preview; only the audited apply service may materialize a draft round.
- One stable `round_key` maps to at most one activity-owned `ContestRound`, even when multiple stages consume that score source.
- No unknown business fact may silently become `average`, `0%`, `top_n`, or “no audience score”; missing or conflicting facts remain blocking planning issues.
- `execution_refs` must be validated before a round is reused or created, and stale/mismatched ids must fail closed.
- Existing professional-editor, authority-lock, audit, and freeze services remain the source of truth; the workbench must not bypass them.
- Every production Python/TypeScript behavior change gets a regression test before implementation and runs the relevant focused gate before commit.
- Keep the current branch workflow: commit small logical batches, merge with `--no-ff` into `main`, push, and monitor all CI workflows.

---

### Task 1: Preserve stable historical round identity

**Files:**
- Modify: `ruleset/planning.py:332-552,555-679` — preserve source `round_key`, carry source scoring metadata, and build authoritative execution references.
- Modify: `ruleset/services.py:457-570` — deduplicate round configurations by `round_key`, validate incoming `execution_refs` before any create/configure call, and map every stage source to the shared configured round.
- Test: `ruleset/test_planning.py` — add the 2025 Golden Case projection/compile assertions and stale execution-reference rejection.

**Interfaces:**
- `PlanningCompileResult.round_configurations` contains one configuration per unique stable `round_key`, with `business_ids` listing every source occurrence.
- Planning payload `execution_refs` contains `rounds[round_key] = {"round_key": round_key, "round_id": optional integer}` and `stages[stage_business_id] = {"stage_key": ..., "round_keys": [...]}`.

- [ ] **Step 1: Write the failing Golden Case tests.**

  Add assertions that `planning_projection_from_definition(golden_schidui())` keeps `r3` in both stage 2 and stage 3, that `prepare_planning_compile()` returns exactly four unique round configurations (`r1`, `r2`, `r3`, `r4`), and that both stage sources still point to `r3`.

  Add a service test that supplies an `execution_refs.rounds.r3.round_id` belonging to another activity and asserts `apply_planning_to_ruleset()` raises before creating any round.

- [ ] **Step 2: Run the focused tests and verify they fail for the current implementation.**

  Run:

  ```powershell
  uv run python manage.py test ruleset.test_planning.PlanningProjectionTests ruleset.test_planning.PlanningApplyServiceTests
  ```

  Expected failures: the historical projection currently invents `stage2-1`/`stage3-1`, and the current apply path ignores the submitted execution reference.

- [ ] **Step 3: Implement stable identity and authoritative mapping.**

  In `_historical_stage_payload()`, use the inferred source `round_key` for both `business_id` and `round_key`, retain the inferred `scoring_mode`, and make `execution_rounds` use the same key. In `planning_projection_from_definition()`, build the `rounds` map from all stage sources and reject conflicting metadata for the same key.

  In `prepare_planning_compile()`, aggregate repeated sources by `round_key` while retaining all source business ids. In `apply_planning_to_ruleset()`, normalize the submitted `execution_refs`, compare each submitted id with the current `ContestRuleset.round_keys`, reject cross-activity/stale ids, materialize/configure each unique key once, and assign its configured id to every matching source before calling `save_business_ruleset()`.

- [ ] **Step 4: Run the focused tests and the existing planning suite.**

  Run:

  ```powershell
  uv run python manage.py test ruleset.test_planning
  ```

  Expected: the Golden Case has four actual rounds, three checkpoints, and one shared `r3` source.

- [ ] **Step 5: Commit the identity fix.**

  ```powershell
  git add ruleset/planning.py ruleset/services.py ruleset/test_planning.py
  git commit -m "fix: preserve planning round identity across stages"
  ```

---

### Task 2: Remove implicit business defaults and collect complete round facts

**Files:**
- Modify: `ruleset/planning.py:190-442` — validate nested field objects, require explicit result/weight/scoring/rubric facts, and emit complete round configurations.
- Modify: `ruleset/business_editor.py:80-190,430-657` — preserve round format, participant/group declarations, and scoring metadata in the business context without changing graph semantics.
- Modify: `ruleset/services.py:470-558` — pass judge count, minimum judge count, rubric definition, and source format through the audited round configuration call.
- Modify: `singer_contest/services.py:722-845` only if the planning configuration needs a narrow validated rubric/round input adapter; retain existing authority checks.
- Test: `ruleset/test_planning.py` — add missing-fact and explicit-fact tests.

**Interfaces:**
- A planning round carries confirmed fields for `scoring_mode`, `judge_count`, `minimum_judge_count`, and `rubric` (`name`, `description`, and criteria with `name`, `max_score`, `description`).
- A stage carries confirmed `participants`, `advance_count`, `result_method`, `previous_weight`, and `audience_weight`; `format` may be `solo` or `collaboration`, with collaboration described as “每名选手分别评分” when applicable.
- `planning_payload_to_business_stages()` raises a blocking `ValidationError` for unsupported `result_method` instead of silently choosing `top_n`.

- [ ] **Step 1: Add failing tests for every removed default.**

  Cover these cases:

  ```python
  def test_nested_pending_participant_count_blocks_apply(self): ...
  def test_missing_scoring_mode_does_not_become_average(self): ...
  def test_missing_audience_weight_does_not_become_zero(self): ...
  def test_missing_result_method_does_not_become_top_n(self): ...
  def test_round_configuration_preserves_judge_count_and_rubric(self): ...
  def test_same_round_reused_by_two_stages_has_one_configuration(self): ...
  ```

  The tests must assert both the issue code/message and the absence of an executable candidate when the fact is not confirmed.

- [ ] **Step 2: Run the new tests before production changes.**

  Run:

  ```powershell
  uv run python manage.py test ruleset.test_planning.PlanningValidationTests ruleset.test_planning.PlanningCompileTests
  ```

  Expected: the tests fail because nested values are not inspected and the converter currently supplies `average`, `0`, and `top_n` defaults.

- [ ] **Step 3: Implement explicit business-field validation.**

  Add recursive field-object validation for stage fields, participant counts, audience fields, rubric fields, and rubric criteria. Update `validate_planning_draft()` to report pending/null nested values using their full field path. Make the converter read the confirmed values through `_planning_value()` and validate scoring-mode choices, positive judge counts, rubric criteria, and a 100-point rubric total.

  Preserve the first-stage structural fact (`previous_weight = 0`) only when the payload explicitly marks it confirmed with evidence; all later-stage previous weights and every audience decision must be present in the payload.

- [ ] **Step 4: Preserve non-graph business facts and pass execution configuration.**

  Extend the normalized business context with `participants`, `format`, collaboration declaration, per-source `scoring_mode`, judge counts, and rubric descriptors. Extend each unique round configuration with the fields needed by `configure_draft_round_from_planning()`. Create a rubric through the existing audited rubric service only during apply, reuse the id supplied by `execution_refs` when present, and never mutate a prepared/locked rubric.

- [ ] **Step 5: Run planning and round-configuration tests.**

  ```powershell
  uv run python manage.py test ruleset.test_planning singer_contest.tests --keepdb
  ```

- [ ] **Step 6: Commit the no-defaults and business-facts fix.**

  ```powershell
  git add ruleset/planning.py ruleset/business_editor.py ruleset/services.py singer_contest/services.py ruleset/test_planning.py
  git commit -m "fix: require explicit planning execution facts"
  ```

---

### Task 3: Add database-aware candidate, binding, and freeze preflight states

**Files:**
- Modify: `ruleset/planning.py:45-75,445-552` — add `business_complete`, `binding_ready`, and `freeze_ready` result fields and structured issue serialization.
- Modify: `ruleset/services.py:397-570,1203-1290` — add a read-only planning preflight that resolves execution refs, current round/vote bindings, candidate bound context, and compiler status without writing.
- Modify: `staff_panel/views.py:4755-4862` — use the version-aware preflight for both GET and POST preview and return the result state in JSON.
- Test: `ruleset/test_planning.py` and `staff_panel/test_ruleset_planning.py` — assert preview does not claim apply readiness when bindings or audience sources are missing and that a valid candidate reports separate states.

**Interfaces:**
- `PlanningCompileResult` exposes `business_complete`, `binding_ready`, `freeze_ready`, and `can_apply`; `can_apply` is true only when business compilation and draft execution binding are both ready.
- `_planning_result_json()` returns all four booleans plus categorized issues and summaries.
- Preview remains read-only: it may inspect database bindings and run `compile_definition()`, but it may not create/update rounds, rubrics, bindings, definitions, or drafts.

- [ ] **Step 1: Add failing service/view tests for three distinct states.**

  Test:

  ```python
  def test_business_complete_but_unbound_round_is_not_apply_ready(self): ...
  def test_audience_weight_requires_a_bound_vote_source_before_apply(self): ...
  def test_preview_reports_freeze_readiness_separately_from_apply_readiness(self): ...
  def test_preview_never_materializes_rounds_or_rubrics(self): ...
  ```

- [ ] **Step 2: Run the tests and verify the current false-positive behavior.**

  ```powershell
  uv run python manage.py test ruleset.test_planning staff_panel.test_ruleset_planning
  ```

  Expected: current preview returns a single optimistic `can_apply` value without checking the activity-owned binding or compiler.

- [ ] **Step 3: Implement read-only preflight.**

  Validate every execution reference against the locked activity and current ruleset mapping. Build an in-memory round context from existing rows plus the confirmed planning configuration for not-yet-materialized draft rounds. Validate vote-purpose/source binding when audience weight is non-zero. Compile the candidate with the existing compiler and convert compiler errors into `PlanningIssue` values. Keep roster-dependent freeze checks visible as `freeze_ready=False` instead of treating a draft candidate as frozen.

- [ ] **Step 4: Route all preview calls through the version-aware preflight.**

  The POST path must use the submitted payload under the version/activity lock; the GET path must use the current draft. The HTTP response may remain `200` for a valid preview with blocking issues, but `result.can_apply` must be authoritative and no success copy may be emitted at the HTTP layer alone.

- [ ] **Step 5: Run focused backend tests and static gates.**

  ```powershell
  uv run python manage.py test ruleset.test_planning staff_panel.test_ruleset_planning
  uv run ruff check ruleset staff_panel
  uv run mypy ruleset staff_panel
  ```

- [ ] **Step 6: Commit the preflight state fix.**

  ```powershell
  git add ruleset/planning.py ruleset/services.py staff_panel/views.py ruleset/test_planning.py staff_panel/test_ruleset_planning.py
  git commit -m "fix: make planning preview binding-aware"
  ```

---

### Task 4: Make the ordinary workbench express and display the business facts

**Files:**
- Modify: `frontend/ruleset_planning.ts:4-298` — render units, inputs/selects for all planning facts, live percentage totals, current-result rendering, and current-payload copy.
- Modify: `templates/staff_panel/ruleset_planning.html:20-150` — render historical summaries, state labels, unit/help text, and only expose editable controls for a draft editable projection.
- Modify: `tests/client/ruleset_planning.test.mjs` — cover real DOM helpers and browser state transitions.
- Modify: `frontend/ruleset_planning.ts` tests/build output through the existing npm check; do not hand-edit `static/dist/`.

**Interfaces:**
- `renderStages()` renders participant count in `人`, advancement in `人`, all percentages with `%` labels/placeholders, scoring mode, judge count in `人`, rubric criteria/max scores in `分`, previous/audience weights, audience source, and result method.
- `post()` returns `{ok, revision, result, ...}` and updates the in-memory `currentResult`; it does not use a page-load-only `result` snapshot.
- `formatPercentageTotal()` is called after every relevant input and its label is rendered near the stage inputs.

- [ ] **Step 1: Add failing client tests.**

  Add tests for:

  ```javascript
  test("new stage leaves result method and audience decision pending", ...)
  test("percentage total is rendered from current inputs", ...)
  test("preview false result does not show candidate ready", ...)
  test("copy pending uses the latest preview issues", ...)
  test("input labels expose person, percent, judge, and score units", ...)
  ```

- [ ] **Step 2: Run the client tests before implementation.**

  ```powershell
  npm run test:client
  ```

  Expected: the new DOM/state assertions fail against the current page-only result and minimal input renderer.

- [ ] **Step 3: Implement the business-language controls.**

  Change `addStage()` so unknown fields are `pending` with null values. Add typed helpers for input/select/field rendering, explicit units, placeholders, and live total badges. Render the complete stage/round form without exposing internal node keys, content hashes, or binding signatures. Keep collaboration as a declaration that does not create a group partition or silently change who is scored.

- [ ] **Step 4: Implement current preview state and pending-copy behavior.**

  Make `post()` parse the optional `result`, update `currentResult`, render the issues/pending section, and use `result.can_apply` for the preview message. The apply button must stop after save/preview if the returned result is not apply-ready. Copy must read the latest in-memory result, not the initial JSON script.

- [ ] **Step 5: Render complex historical summaries and frozen read-only state.**

  Render `planning_projection.summary.human`, node-type warnings, checkpoint names, and the notice when the workbench is read-only. Add a service read-only loader for frozen versions so the GET path never calls the DRAFT-only mutation loader.

- [ ] **Step 6: Run client build/tests and staff view tests.**

  ```powershell
  npm run check:client
  npm run test:client
  uv run python manage.py test staff_panel.test_ruleset_planning
  ```

- [ ] **Step 7: Commit the workbench UX/state fix.**

  ```powershell
  git add frontend/ruleset_planning.ts templates/staff_panel/ruleset_planning.html tests/client/ruleset_planning.test.mjs static/dist/ruleset_planning.js staff_panel/views.py ruleset/services.py staff_panel/test_ruleset_planning.py
  git commit -m "feat: complete ruleset planning business editor"
  ```

---

### Task 5: Configuration sweep, full verification, and CI

**Files:**
- Modify only if verification finds drift: `pyrightconfig.json`, `pyproject.toml`, `tailwind.config.js`, `tsconfig*.json`, `.env*.example`, `.gitignore`, `.dockerignore`, `.github/dependabot.yml`.
- Review: all files changed by Tasks 1–4 and the complete advice document.

- [ ] **Step 1: Run the repository configuration sweep.**

  Confirm every new production Python/TypeScript module is covered by the configured type/content globs and that generated static output is current.

- [ ] **Step 2: Run focused and full verification.**

  ```powershell
  git diff --check
  uv run python manage.py check
  uv run python manage.py makemigrations --check --dry-run
  uv run ruff check .
  uv run ruff format --check .
  uv run mypy
  npm run check:css
  npm run check:client
  npm run check:e2e
  uv run python manage.py test
  pwsh -NoProfile -File scripts/check_docs.ps1
  ```

- [ ] **Step 3: Verify the Golden Case semantically.**

  Assert the candidate and applied definition have three checkpoints, four unique actual contest rounds, `r3` referenced by both stage 2 and stage 3, preserved weights `60/40` and `30/50/20`, and no newly invented score source.

- [ ] **Step 4: Commit any final test-only/configuration fixes separately.**

  Use `test:` for regression-only changes and `chore:` for configuration-only changes; run the relevant focused gate before each commit.

- [ ] **Step 5: Merge and monitor CI.**

  ```powershell
  git status --short
  git switch main
  git pull --ff-only origin main
  git merge --no-ff feat/ruleset-planning-audit-fixes
  git push origin main
  gh run list --repo Zn070515/ArtFlow --branch main --limit 8
  ```

  Wait for CI, Security, PostgreSQL integration, and Workflow lint to complete; inspect and fix any failure caused by this change before reporting completion.

---

## Self-review checklist

- [ ] P1-1 is covered by stable `round_key`, deduplicated actual rounds, authoritative `execution_refs`, and the `r3` Golden Case.
- [ ] P1-2 is covered by explicit result/scoring/audience/previous/judge/rubric/participant/group business inputs, with no silent defaults.
- [ ] P1-3 is covered by separate business, binding/apply, and freeze-preflight states.
- [ ] P2 units and live percentage totals are visible in the browser.
- [ ] Preview false results and current pending issues are rendered from the latest response.
- [ ] Complex summaries and frozen-version GET are readable without mutation permission.
- [ ] Full verification evidence and final CI conclusions are collected before claiming completion.
