# Human Acceptance Batch 2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让首次完成管理员注册的活动负责人能够仅通过后台可见页面完成活动、问卷、赛制、轮次、现场和结果准备，同时保持现有 authority、锁定和私有文件边界。

**Architecture:** 保留当前 Django 单体、Ruleset/Questionnaire DSL、StageResult authority 和 forward-only 编辑契约；在表单和服务边界增加可完成性校验，在模板层提供结构化操作，在启动层幂等初始化内置模板。正式 Award 继续只有 `StageResult → StageAwardDecision → CONFIRMED → Award` 一条写入链，人工决策只影响冻结 Ruleset 已声明的晋级链。

**Tech Stack:** Django 5、PostgreSQL/SQLite 测试矩阵、Django TestCase、Playwright、Tailwind 构建产物、PowerShell/Docker Compose。

**Spec:** `docs/superpowers/specs/2026-09-29-human-acceptance-batch2-design.md`

## Global Constraints

- 不使用 `.worktree/`、不派生 subagent，所有修改在当前短期分支内 inline 完成。
- 每个逻辑改动单独提交；提交前运行对应聚焦测试和 `git diff --check`。
- 不改变 resolver 评分数学、投票量纲、StageResult fingerprint、锁定模型或私有文件访问 authority。
- 不以模板隐藏替代后端 permission、activity scope、lifecycle、锁定和 authority 校验。
- 不删除历史 migration、历史 Award 或用户数据；只新增必要 migration/测试。
- Access Key、session token、上传内容和完整环境变量不得进入日志或测试 artifact。
- 正式 Award 只能由确认的 StageResult 及其 StageAwardDecision 物化；不得恢复任意手填奖项直发。
- Python 生产改动提交前运行 `npm run check:pyright` 与 `npm run check:pyright:entry-access`，两者必须零诊断。

---

### Task 1: 修复问卷题型死路并建立结构化题目配置接口

**Files:**
- Modify: `questionnaire/builder.py`
- Modify: `questionnaire/staff_views.py`
- Modify: `templates/staff_panel/questionnaire_builder.html`
- Test: `questionnaire/test_builder.py`
- Test: `questionnaire/test_builder_views.py`

**Interfaces:**
- Produces `default_question(question_type: str, *, key: str) -> dict` 可生成经过 `parse_questionnaire()` 接受的 `single_choice`、`multiple_choice`、`select`、`file`。
- Produces a staff builder question-type list containing all supported types, including `file`.

- [ ] **Step 1: Write failing builder tests**

  Add tests proving each advertised choice type can be added, has two editable default options, and validates. Add a file-question test proving the generated shape contains a registered purpose, non-empty extensions, `max_mb <= MAX_FILE_MB_HARD_LIMIT`, and `max_files == 1`.

- [ ] **Step 2: Run the focused tests and verify the current failure**

  Run `uv run python manage.py test questionnaire.test_builder questionnaire.test_builder_views`.
  Expected: the choice tests fail because `single_choice` and `multiple_choice` are absent from `DEFAULT_KEYS`; the file test fails because file questions are not offered by the builder.

- [ ] **Step 3: Implement the smallest valid defaults**

  Add the three choice labels to `DEFAULT_KEYS`. Add a file default using the existing registered `accompaniment` purpose, `['.mp3', '.wav', '.mp4']`, `max_mb=500`, and `max_files=1`; keep the hard schema ceiling authoritative. Add `file` to the staff view type list.

- [ ] **Step 4: Add structured question editing tests**

  Add view tests that submit a choice option add/update/remove action and a file policy update action, then assert the stored questionnaire contains the requested values and no raw JSON is needed for the normal path.

- [ ] **Step 5: Render the structured editor controls**

  Replace the normal-path JSON-only affordance in `questionnaire_builder.html` with labels and controls for question label, required, round, choice options, and file purpose/extensions/max size. Keep the raw JSON editor inside a clearly labelled advanced disclosure block, and keep schema validation on the server.

- [ ] **Step 6: Run focused tests and commit**

  Run `uv run python manage.py test questionnaire.test_builder questionnaire.test_builder_views` and `git diff --check`.
  Commit: `feat: make questionnaire question types operable`.

### Task 2: Close activity lifecycle, archive, type, and message dead ends

**Files:**
- Modify: `core/services.py`
- Modify: `core/models.py`
- Modify: `staff_panel/forms.py`
- Modify: `staff_panel/views.py`
- Modify: `templates/staff_panel/activity_form.html`
- Modify: `templates/staff_panel/activity_detail.html`
- Modify: `templates/staff_panel/activity_list.html`
- Modify: `templates/staff_panel/export_center.html`
- Modify: `templates/base.html` and affected staff templates with duplicate message loops
- Test: `core/tests.py`
- Test: `staff_panel/tests.py`

**Interfaces:**
- Produces `phase_choices_for_activity(activity: Activity) -> list[tuple[str, str]]`, returning current phase plus only `PHASE_EDGES[current]` for an existing activity and only `CREATE_PHASE_CHOICES` for creation.
- `Activity.save()` rejects a persisted `activity_type` change with `ValidationError` unless the existing activity is being created.

- [ ] **Step 1: Add lifecycle/type regression tests**

  Add tests for: new activity POST always persists `DRAFT`; an existing activity form exposes only current/legal successor phases; an illegal target never reaches the transition service; a persisted `activity_type` change is rejected through both `save()` and the staff edit path; an archived activity exposes only unarchive.

- [ ] **Step 2: Run the tests to capture failures**

  Run `uv run python manage.py test core.tests staff_panel.tests` with the new test names selected. Expected failures include the all-phase edit choices, mutable `activity_type`, and archive affordance assertions.

- [ ] **Step 3: Implement legal phase choices and immutable type**

  Add the helper in `core/services.py`, use it from `activity_edit`, remove the create-page phase control or render it as a non-editable “新活动从草稿开始” statement, and make `Activity.save()` compare the stored `activity_type` before saving an existing row. Do not weaken `PHASE_EDGES` or authority contexts.

- [ ] **Step 4: Make archived/locked UI match backend authority**

  Hide normal edit/unlock actions when the activity state makes them fail, expose `activity_unarchive` for archived rows, and change export-center links so they never imply that a normal unlock is available. Preserve backend checks and return a domain-level message for stale/invalid submissions.

- [ ] **Step 5: Remove duplicate message rendering**

  Keep the single message loop in `base.html`; remove page-local loops from ruleset/questionnaire and any other templates that render the same Django message list. Add a response test that a single success/error message appears once.

- [ ] **Step 6: Run focused tests and commit**

  Run the selected core/staff tests, `uv run python manage.py check`, and `git diff --check`.
  Commit: `fix: close activity lifecycle and archive dead ends`.

### Task 3: Make fresh installation and event startup self-diagnosing

**Files:**
- Modify: `scripts/docker-entrypoint.sh`
- Modify: `scripts/start-event.ps1`
- Modify: `common/management/commands/doctor.py`
- Test: `ruleset/test_seed_templates.py`
- Test: `scripts/tests/test_posix_operations_contract.py` or the existing script-contract test module
- Test: `staff_panel/tests.py` for template visibility after initialization

**Interfaces:**
- Container startup sequence becomes `wait-for-postgres → migrate → seed_ruleset_templates → collectstatic → gunicorn`.
- Event launcher failure output includes the original Compose output plus bounded `docker compose ps` and web/db log tails without environment values.
- `doctor --require-access-keys` reports only configured/missing/placeholder status for both keys.

- [ ] **Step 1: Add idempotent startup tests**

  Extend seed tests to run `seed_ruleset_templates()` twice and assert one builtin row per key, no overwrite of custom rows, and no mutation of frozen versions. Add an entrypoint contract test asserting the seed command appears after migrate and before collectstatic.

- [ ] **Step 2: Add doctor and launcher failure tests**

  Assert doctor output contains `STAFF_ACCESS_KEY` and `ADMIN_ACCESS_KEY` readiness without their values. Assert the PowerShell script includes the captured Compose output and bounded `ps`/log diagnostics on failure, and excludes password/key variable names from emitted diagnostics.

- [ ] **Step 3: Implement startup seeding and diagnostics**

  Insert `python manage.py seed_ruleset_templates` after migration, using the command’s existing DRAFT default and its idempotency/frozen-version protections. Do not invent a new command option or mark templates frozen during container startup. Add the doctor readiness check and preserve non-zero failure for `--require-access-keys`.

- [ ] **Step 4: Preserve stderr and bounded logs in PowerShell**

  In `Invoke-ComposeStep`, retain and print the captured output before throwing. On failure, run only `docker compose ps` and `logs --tail 80 web db`, redact lines matching configured secret/key names, and then throw the original command failure. Do not print `.env.event`.

- [ ] **Step 5: Run the runtime-focused checks and commit**

  Run `uv run python manage.py test ruleset.test_seed_templates`, the script contract tests, and `git diff --check`.
  Commit: `fix: make fresh event startup self diagnosing`.

### Task 4: Complete visible navigation and activity-scoped context

**Files:**
- Modify: `templates/staff_panel/dashboard.html`
- Modify: `templates/staff_panel/activity_detail.html`
- Modify: `templates/staff_panel/round_list.html`
- Modify: `templates/staff_panel/export_center.html`
- Modify: `staff_panel/views.py`
- Modify: `staff_panel/forms.py`
- Test: `staff_panel/tests.py`
- Test: `staff_panel/test_*.py` modules that cover voting/judging/rubrics

**Interfaces:**
- Dashboard and activity workspace expose `judge_control`, `audience_score_entry`, `rubric_create`, `user_list`, and `activity_unarchive` with labels matching their targets.
- `ContestRoundForm`, `VoteSessionForm`, rubric creation, and award/result flows receive activity-scoped querysets and reject a posted object from another activity before mutation.

- [ ] **Step 1: Add navigation contract tests**

  Log in as staff/admin, request dashboard/activity/round/export pages, and assert the five route names and activity context links are present. Assert the judge link points to judge control rather than round list.

- [ ] **Step 2: Add cross-activity rejection tests**

  Create two activities and one candidate/rubric/round object in each. Post IDs from activity B while operating on activity A; assert `400`/domain error and zero writes in activity A.

- [ ] **Step 3: Implement visible workspace navigation**

  Add a current-activity summary and task links; keep global user management visible only to authorized staff/admin. Add the unarchive entry only for archived activities.

- [ ] **Step 4: Narrow candidate querysets and retain service checks**

  Pass `activity_id` into forms on GET and POST, filter singer/rubric/group candidates by that activity, and validate posted IDs again in the service/view transaction. Never rely on a hidden activity input as authority.

- [ ] **Step 5: Run focused navigation/context tests and commit**

  Run the staff navigation, vote, round, rubric, judge-control, and award-related test classes plus `git diff --check`.
  Commit: `feat: add activity workspace navigation and scoping`.

### Task 5: Replace staff JSON/ID configuration with structured editors and legal moves

**Files:**
- Modify: `staff_panel/forms.py`
- Modify: `staff_panel/views.py`
- Modify: `questionnaire/builder.py`
- Modify: `templates/staff_panel/ruleset_editor.html`
- Modify: `templates/staff_panel/questionnaire_builder.html`
- Modify: `templates/staff_panel/round_groups.html`
- Modify: `templates/staff_panel/round_running_order.html`
- Modify: `templates/staff_panel/rubric_form.html`
- Test: `staff_panel/tests.py`
- Test: `questionnaire/test_builder.py`
- Test: `ruleset/test_schema.py` and/or the ruleset editor test module

**Interfaces:**
- Structured form handlers keep `PARTITION.by` as text and `SELECT.by` as a `GROUP_MAP` source, while advanced JSON remains explicitly folded and schema-validated.
- Round groups accept selected singer names/IDs through controlled form fields and serialize only server-validated IDs.
- Running order posts ordered singer IDs generated by visible names and action buttons, not a free-text database-ID instruction.
- Rubric criteria use repeated `name`/`max_score` fields and serialize to the existing criteria JSON only after service validation.

- [ ] **Step 1: Add failing tests for legal editor operations**

  Cover ruleset reference choices, human-readable schema errors, questionnaire nearest-legal move or pre-disabled explanation, structured round groups, ordered running order, and repeated rubric criteria. Include a test that invalid cross-node references never save.

- [ ] **Step 2: Implement legal move calculation**

  Add a pure helper that attempts each destination in the requested direction and returns the nearest position accepted by the existing parser. If no position is legal, expose a disabled action plus a Chinese reason. Keep the current forward-only schema/compiler unchanged.

- [ ] **Step 3: Implement structured configuration forms**

  Build fieldsets from the current activity/version candidates; normalize them to the existing JSON shape; run the existing parser/compiler/service before persistence; preserve advanced JSON as a `<details>` escape hatch with a warning.

- [ ] **Step 4: Translate schema errors at the view boundary**

  Map known forward-only, missing-source, wrong-output-type, and frozen-version errors to operator language. Do not expose raw exception strings such as `source 'assess_r1' is not defined before this node` in normal responses; retain technical details only in server logs without secrets.

- [ ] **Step 5: Run focused editor tests and commit**

  Run ruleset/questionnaire/staff editor tests, `uv run ruff check ruleset questionnaire staff_panel`, and `git diff --check`.
  Commit: `feat: add structured staff configuration editors`.

### Task 6: Remove direct Manual Award writes and preserve result authority

**Files:**
- Modify: `singer_contest/services.py`
- Modify: `staff_panel/views.py`
- Modify: `staff_panel/urls.py`
- Modify: `templates/staff_panel/award_list.html`
- Replace or modify: `templates/staff_panel/award_form.html`
- Test: `staff_panel/tests.py`
- Test: `singer_contest/tests.py`

**Interfaces:**
- `create_manual_award()` is removed or changed to raise a domain `ValidationError` without creating an `Award`.
- The old `staff:award_create` route redirects to the result/ruleset workflow with a clear message and performs no write.
- Manual correction remains `set_manual_decision()` on a frozen Ruleset; resolver-generated `StageAwardDecision` is the only candidate source.

- [ ] **Step 1: Add the authority regression tests**

  Assert that POSTing the old award form creates no Award and shows the migration message. Assert that direct service invocation cannot create `source_node="MANUAL"`. Assert that a frozen definition containing `MANUAL_SELECT` and `AWARD` produces a candidate only through resolver persistence and materializes only after `confirm_stage_result()`.

- [ ] **Step 2: Run the tests and verify the old path fails the new contract**

  Run the new staff/singer tests. Expected: the legacy manual-award tests fail because the current view/service creates an Award directly.

- [ ] **Step 3: Remove the direct creation implementation**

  Delete the view’s `create_manual_award()` call and remove the service’s direct `Award.objects.create(...)` path. Keep historical Award reads and `official_stage_award_queryset()` compatibility. Render the award list as “奖项由已核定结果自动生成” with a link to the result/ruleset workflow.

- [ ] **Step 4: Verify the full source chain**

  Re-run the new tests plus existing StageResult confirmation/materialization tests. Confirm no route, form, or service can write a formal Award without `source_stage_result` and `source_award_decision` under the materialization authority.

- [ ] **Step 5: Commit the authority change**

  Run the focused tests, `uv run ruff check singer_contest staff_panel`, and `git diff --check`.
  Commit: `fix: enforce confirmed result award authority`.

### Task 7: Preserve form input, improve accessibility, and add safe operator actions

**Files:**
- Modify: `staff_panel/forms.py`
- Modify: `staff_panel/views.py`
- Modify: `templates/staff_panel/*.html` for affected forms/tables
- Modify: `templates/base.html`
- Test: `staff_panel/tests.py`
- Test: `tests/test_ux_contract.py`

**Interfaces:**
- Invalid POST responses render the bound form and its submitted values, including round groups, running order, vote candidates, and farewell fields.
- Every visible label has a matching input/select/textarea `id`; destructive role/active/reset/delete controls require confirmation.
- Staff tables use an overflow wrapper; primary mobile controls meet at least 24×24 CSS pixels; internal enum/context strings are translated to operator labels.

- [ ] **Step 1: Add form-retention and UX contract tests**

  Submit invalid round/vote/farewell/rubric forms and assert submitted values remain in HTML. Add static template tests for label `for`/control `id`, a single message loop, confirmation attributes, overflow wrappers, and the absence of raw `context_version`/technical enum text in operator-facing controls.

- [ ] **Step 2: Bind invalid forms instead of rebuilding them**

  Ensure each invalid branch passes the original bound form and the same activity-scoped querysets back to the template. Do not reconstruct an unbound form from model defaults after validation failure.

- [ ] **Step 3: Normalize labels, controls, and destructive actions**

  Add stable IDs, Chinese help text, `aria-label` where icon-only controls remain, `onsubmit`/data-confirm handling for destructive operations, and minimum touch padding. Keep CSRF and POST-only mutation behavior.

- [ ] **Step 4: Fix mobile tables and operational status language**

  Wrap wide tables with `overflow-x-auto`, replace internal run-state/context displays with business status text, and keep technical diagnostics in a collapsed block.

- [ ] **Step 5: Run UX tests and commit**

  Run `uv run python manage.py test staff_panel.tests tests.test_ux_contract`, `npm run check:css`, and `git diff --check`.
  Commit: `fix: improve staff form usability and accessibility`.

### Task 8: Add the human acceptance journey and complete verification

**Files:**
- Create: `recording/human_acceptance_batch2.spec.mjs`
- Modify: `playwright.config.*` only if the existing local-service contract cannot select the existing event URL
- Modify: `docs/production-readiness.md` or the current rehearsal matrix to record evidence and known external holds
- Test: the new Playwright journey and existing Django/client gates

**Interfaces:**
- Playwright uses visible links/forms as a fresh Admin, Staff, Participant, and Judge; it does not jump directly to hidden mutation URLs for the main journey.
- The journey runs at desktop and `375px` viewport and records failures without credentials or uploaded-content artifacts.

- [ ] **Step 1: Prepare deterministic test data and write the failing journey**

  Use the repository’s existing test-data preparation command/fixture. The journey must create/login the first Admin, verify built-in templates, create a DRAFT activity, open questionnaire/ruleset pages, create a round/rubric, follow the visible judge-control and audience-score links, and inspect archive/unarchive. Add assertions that the old manual-award affordance is absent or explains the confirmed-result workflow.

- [ ] **Step 2: Run the browser journey at both viewports**

  Run `npx playwright test recording/human_acceptance_batch2.spec.mjs --project=chromium` with the local event service already running. Expected initial failures identify remaining visible-navigation or selector issues; fix only the product code/templates responsible.

- [ ] **Step 3: Add cross-activity and authority assertions**

  Use a second activity/candidate in the test fixture, attempt a cross-activity POST through the visible form, and assert rejection plus unchanged database state. Complete the manual-decision path only when the frozen definition has both `MANUAL_SELECT` and `AWARD` nodes.

- [ ] **Step 4: Run all required repository gates**

  Run, in order:

  ```powershell
  uv run python manage.py check
  uv run python manage.py makemigrations --check --dry-run
  uv run ruff check .
  npm run check:pyright
  npm run check:pyright:entry-access
  npm run check:css
  npm run check:client
  npm run test:client
  uv run python manage.py test
  npx playwright test recording/human_acceptance_batch2.spec.mjs --project=chromium
  ```

- [ ] **Step 5: Perform the two implementation self-reviews**

  First review the diff against every spec acceptance item and authority constraint. Second review fresh-install, desktop/mobile, cross-activity, manual Award, and invalid-form paths using the browser and focused tests. Fix findings before declaring the branch complete.

- [ ] **Step 6: Commit, merge, and push**

  Commit the journey/readiness evidence as `test: add human acceptance journey`, verify clean status, switch to `main`, pull with `--ff-only`, merge the branch with `--no-ff`, and push `main`. If push times out, retry through `http://127.0.0.1:12334` as defined in `AGENTS.md`. Keep the feature branch until remote `main` and final status are confirmed.

## Plan Self-Review

### Spec coverage

| Spec requirement | Plan task |
|---|---|
| Award provenance and no direct Manual Award | Task 6 |
| Legal activity phase choices, immutable type, archive/unarchive | Task 2 |
| Questionnaire choice/file editing and legal movement | Tasks 1 and 5 |
| Ruleset structured references, advanced JSON boundary, readable errors | Task 5 |
| Activity workspace navigation and scoped candidates | Task 4 |
| Form retention, Chinese labels, confirmations, mobile layout, single messages | Task 7 |
| Idempotent template initialization and launcher diagnostics | Task 3 |
| Fresh Admin visible journey at desktop/mobile | Task 8 |
| No resolver math/fingerprint/lock redesign | Global Constraints and Tasks 5–6 |

### Placeholder scan

The plan contains no unfinished-marker or “similar to Task” instruction, and no unassigned edge-case step. Every task names files, interfaces, tests, focused commands, and a conventional commit boundary.

### Type and interface consistency

- `phase_choices_for_activity()` is defined once in Task 2 and consumed by the activity form/view in that task.
- `default_question()` and `DEFAULT_KEYS` remain the existing pure builder interface used by Task 1 tests and views.
- `set_manual_decision()` remains the existing authority service; Task 6 removes only the direct `create_manual_award()` write path.
- Activity-scoped form querysets are passed from views into existing form constructors; no new untyped transport boundary is introduced.
