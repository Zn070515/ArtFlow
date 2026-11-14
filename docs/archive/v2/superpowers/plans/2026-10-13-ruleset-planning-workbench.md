# 赛制规则准备工作台实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在不污染现有正式赛制和冻结链路的前提下，增加面向普通工作人员的“比赛规则准备”草稿、检查、候选预览和安全应用工作流。

**Architecture:** 以 `RulesetPlanningDraft` 保存业务 JSON 草稿，以 `ruleset.planning` 保存纯函数 schema、Decimal 百分比解析、问题清单和线性适配器；普通 Staff 只访问新的 planning 工作台。正式应用在事务内重新读取 Activity → ContestRuleset → RulesetVersion → Draft，复用现有 `save_business_ruleset()` 的哈希、绑定、轮次保护和审计，然后仍由管理员调用 `freeze_ruleset_version()`。

**Tech Stack:** Django 6、Django migrations、Python 3.12 `Decimal`/dataclasses、Django templates、现有 TypeScript 编译链、Django `TestCase`/`SimpleTestCase`。

**Spec:** `docs/superpowers/specs/2026-10-13-ruleset-planning-workbench-design.md`

## Global Constraints

- 保留现有 `ruleset_edit`、`ruleset_bind`、高级节点编辑器和冻结入口，以兼容既有后台页面及测试。
- 草稿保存只更新规划草稿及审计信息，不写 `RulesetVersion.definition`、`ContestRuleset.round_keys`、`ContestRound` 或 FROZEN 版本。
- 正式候选应用必须通过 `validate_planning_draft()`、`prepare_planning_compile()`，再调用既有 `save_business_ruleset()`。
- 复杂节点图不能被强制投影成线性阶段；不能因为“5 组 × 3 人”推导按组晋级规则。
- 页面不能要求工作人员填写 `stage_key`、`round_key`、`source_stage_key`、节点类型、`ContestRound` 主键、binding JSON、依赖拓扑、创建技术轮次复选框或裸权重小数。
- 所有百分比正式计算使用 Python `Decimal`；前端总计只用于即时提示，不能把 JS float 作为权威输入。
- 草稿和正式应用遵循 Activity → ContestRuleset → RulesetVersion → RulesetPlanningDraft 锁顺序；旧 revision 必须拒绝，不能静默覆盖。
- 不引入 React、Vue、Redis、外部模型或新的运行服务。
- 普通 Staff 只能准备草稿和候选；正式 Freeze 继续由 `freeze_ruleset_version()` 和管理员入口完成。
- 仓库 `AGENTS.md` 禁止派生代理；本计划由当前会话内联执行。每个任务完成后运行其独立验证并提交小范围 Conventional Commit。

## File Map

- Create: `ruleset/planning.py` — 业务 payload schema、`ParsedPercentage`、`PlanningIssue`、校验、历史投影、候选转换和差异摘要。
- Create: `ruleset/test_planning.py` — 纯函数、模型边界和规划服务回归测试。
- Modify: `common/authority.py` — 新增规划草稿写入 authority scope。
- Modify: `common/models.py` — 新增 `AuditLog.ActionType.UPDATE_RULESET_PLANNING`。
- Create: `common/migrations/0022_alter_auditlog_action_type.py` — 新审计动作迁移。
- Modify: `ruleset/models.py` — 新增 `RulesetPlanningDraft` 及 DRAFT/authority 守卫。
- Create: `ruleset/migrations/0019_rulesetplanningdraft.py` — 草稿表迁移。
- Modify: `ruleset/services.py` — 草稿加载/保存、候选准备、应用事务和 round/rubric 映射。
- Modify: `ruleset/test_services.py` — 与现有规则服务锁、绑定和冻结测试相邻的集成回归。
- Modify: `singer_contest/services.py` — 新增只允许 DRAFT 轮次的规划配置服务；不改变现场评分服务。
- Modify: `staff_panel/urls.py` — planning、preview、apply 路由。
- Modify: `staff_panel/views.py` — 普通工作台、保存失败回显、候选预览、应用和创建/克隆跳转。
- Create: `templates/staff_panel/ruleset_planning.html` — 普通业务工作台；不渲染技术字段。
- Modify: `templates/staff_panel/ruleset_editor.html` — 增加普通工作台入口，保留专业工具内容。
- Modify: `templates/staff_panel/activity_workspace.html`, `templates/staff_panel/dashboard.html`, `templates/staff_panel/questionnaire_builder.html` — 把普通入口文字和链接改为“比赛规则准备”。
- Create: `frontend/ruleset_planning.ts` — 使用干净业务数据对象维护阶段/轮次，不克隆 DOM，不计算正式 Decimal。
- Create: `tests/client/ruleset_planning.test.mjs` — 规划工作台客户端稳定 ID、百分比总计和原始 JSON 提交测试。
- Create: `static/dist/ruleset_planning.js` — `npm run build:client` 生成并纳入检查。

---

### Task 1: 建立规划 schema、单位解析和草稿模型

**Files:**
- Create: `ruleset/planning.py`
- Create: `ruleset/test_planning.py`
- Modify: `common/authority.py`
- Modify: `common/models.py`
- Create: `common/migrations/0022_alter_auditlog_action_type.py`
- Modify: `ruleset/models.py`
- Create: `ruleset/migrations/0019_rulesetplanningdraft.py`

**Interfaces:**
- Produces `ParsedPercentage`, `PlanningIssue`, `parse_percentage(value)`, `validate_planning_draft(payload)`, `default_planning_payload()`, `planning_field(value, resolution, evidence, unit)`.
- Produces `RulesetPlanningDraft` with `ruleset_version`, `payload`, `revision`, `source`, `updated_by`, `created_at`, `updated_at`.
- Authority constant: `PLANNING_DRAFT_WRITE = "ruleset.planning_draft.write"`.

- [ ] **Step 1: Write failing tests for Decimal percentage semantics.**

```python
class PercentageParsingTests(SimpleTestCase):
    def test_plain_number_is_percentage_not_coefficient(self):
        parsed = parse_percentage("50")
        self.assertEqual(parsed.percent, Decimal("50"))
        self.assertEqual(parsed.coefficient, Decimal("0.5"))
        self.assertFalse(parsed.requires_confirmation)

    def test_percent_suffix_keeps_percentage_meaning(self):
        self.assertEqual(parse_percentage("50%").coefficient, Decimal("0.5"))

    def test_fraction_without_suffix_requires_confirmation(self):
        parsed = parse_percentage("0.5")
        self.assertEqual(parsed.percent, Decimal("0.5"))
        self.assertEqual(parsed.coefficient, Decimal("0.005"))
        self.assertTrue(parsed.requires_confirmation)

    def test_invalid_percentage_values_are_rejected(self):
        for value in ("-1", "100.01", "NaN", "Infinity", "50%%"):
            with self.subTest(value=value):
                with self.assertRaises(ValidationError):
                    parse_percentage(value)
```

- [ ] **Step 2: Run the focused test and confirm it fails for the missing API.**

Run: `uv run python manage.py test ruleset.test_planning.PercentageParsingTests`

Expected: import failure for `ruleset.planning` or missing `parse_percentage`, not a database/configuration failure.

- [ ] **Step 3: Implement the minimal schema primitives.**

Implement these exact types in `ruleset/planning.py`:

```python
class PlanningResolution(StrEnum):
    CONFIRMED = "confirmed"
    PENDING = "pending"
    CONFLICT = "conflict"

class PlanningSeverity(StrEnum):
    MISSING_INFORMATION = "missing_information"
    BUSINESS_CONFLICT = "business_conflict"
    EXECUTION_RISK = "execution_risk"

@dataclass(frozen=True)
class ParsedPercentage:
    percent: Decimal
    coefficient: Decimal
    requires_confirmation: bool
    had_percent_sign: bool

@dataclass(frozen=True)
class PlanningIssue:
    code: str
    severity: PlanningSeverity
    stage_id: str = ""
    round_id: str = ""
    field_path: str = ""
    message: str = ""
    why: str = ""
    confirm_with: str = ""
    blocks_apply: bool = False

    def to_dict(self) -> dict[str, object]: ...
```

`parse_percentage()` strips one trailing `%`, constructs `Decimal` from text, rejects bool/empty/non-finite/out-of-range values, and sets `requires_confirmation=True` only for a suffix-free value strictly between 0 and 1. `planning_field()` accepts only units `text`, `person`, `group`, `judge`, `minute`, `score`, `percent`, `vote`, and only the three resolutions above. `default_planning_payload()` returns exactly `{"schema_version": 1, "stages": [], "execution_refs": {}}`; it must not add guessed counts, weights, judges or scoring modes.

- [ ] **Step 4: Run the focused test and confirm the percentage tests pass.**

Run: `uv run python manage.py test ruleset.test_planning.PercentageParsingTests`

Expected: all percentage cases pass with no warnings.

- [ ] **Step 5: Write failing tests for payload resolution, units, and issues.**

```python
class PlanningValidationTests(SimpleTestCase):
    def test_missing_participant_count_is_saveable_but_blocks_apply(self):
        payload = {"schema_version": 1, "stages": [{
            "business_id": "stage-1",
            "participants": {"source": "all_finalists", "count": None},
        }]}
        issue = next(i for i in validate_planning_draft(payload) if i.code == "MISSING_PARTICIPANT_COUNT")
        self.assertEqual(issue.severity, PlanningSeverity.MISSING_INFORMATION)
        self.assertTrue(issue.blocks_apply)
        self.assertEqual(issue.stage_id, "stage-1")

    def test_confirmed_false_is_not_missing(self):
        value = planning_field(False, PlanningResolution.CONFIRMED, "老师确认不计观众分", "score")
        self.assertIs(value["value"], False)

    def test_conflicting_evidence_is_a_business_conflict(self):
        payload = {"schema_version": 1, "stages": [{
            "business_id": "stage-1",
            "name": {"value": "初赛", "resolution": "conflict", "evidence": "两份材料分别写 30% 和 40%", "unit": "text"},
        }]}
        self.assertEqual(validate_planning_draft(payload)[0].severity, PlanningSeverity.BUSINESS_CONFLICT)
```

- [ ] **Step 6: Run the validation tests and confirm they fail for missing implementation.**

Run: `uv run python manage.py test ruleset.test_planning.PlanningValidationTests`

Expected: failure because `planning_field()`/`validate_planning_draft()` do not yet implement the required issue codes.

- [ ] **Step 7: Implement schema validation without inventing values.**

Validate root `schema_version == 1`, stable non-empty `business_id`, field object shape, fixed units, resolution semantics, positive integer count fields, non-negative vote counts, finite Decimal score fields, and percentage totals. Return `PlanningIssue` for incomplete fields instead of raising. Raise `ValidationError` only for malformed root/list/object shape that cannot safely be preserved. Use issue codes `MISSING_*`, `CONFLICTING_EVIDENCE`, `WEIGHTS_INCOMPLETE`, `MISSING_SCORE_DEPENDENCY`, and `UNSUPPORTED_RESULT_METHOD` with the severity/blocking values from the design.

Support participant sources `all_finalists`, `previous_stage`, `named_result`, `pending`; round formats `solo`, `collaboration`, `group_performance`, `helping_guest`, `other`; score sources `judge_round`, `previous_stage`, `other_round`, `audience`, `manual`; result methods `top_n`, `per_group_top_n`, `manual`, `revival`, `fill_quota`, `pending`.

- [ ] **Step 8: Run all Task 1 pure tests.**

Run: `uv run python manage.py test ruleset.test_planning.PercentageParsingTests ruleset.test_planning.PlanningValidationTests`

Expected: PASS.

- [ ] **Step 9: Write failing model/authority tests.**

```python
class PlanningDraftAuthorityTests(TestCase):
    def test_direct_draft_save_is_rejected_outside_planning_service(self):
        draft = RulesetPlanningDraft(ruleset_version=self.version, payload=default_planning_payload())
        with self.assertRaises(ValidationError):
            draft.save()

    def test_draft_cannot_attach_to_frozen_version(self):
        self.version.status = RulesetVersion.Status.FROZEN
        with self.assertRaises(ValidationError):
            RulesetPlanningDraft(ruleset_version=self.version, payload=default_planning_payload()).full_clean()
```

The fixture creates the Activity, ContestRuleset and DRAFT RulesetVersion with the existing authority helpers; it does not manufacture a FROZEN row through raw ORM writes.

- [ ] **Step 10: Implement model, authority scope, audit enum, and migrations.**

Add `PLANNING_DRAFT_WRITE`, guard `RulesetPlanningDraft.save/delete/update/bulk_update`, and enforce `ruleset_version.status == DRAFT` in `clean()`. Use `OneToOneField(..., related_name="planning_draft", on_delete=models.CASCADE)`, `JSONField(default=dict)`, `PositiveIntegerField(default=0)`, `CharField(max_length=24, default="manual")`, nullable `updated_by`, and timestamps. Add `UPDATE_RULESET_PLANNING` to `AuditLog.ActionType`; create migrations depending on common `0021_auditlog_query_indexes` and ruleset `0018_contestruleset_group_stage_keys`.

- [ ] **Step 11: Run model tests and migration checks.**

Run: `uv run python manage.py test ruleset.test_planning.PlanningDraftAuthorityTests`

Then run: `uv run python manage.py makemigrations --check --dry-run`

Expected: model tests PASS and no pending migrations.

- [ ] **Step 12: Commit Task 1.**

```bash
git add common/authority.py common/models.py common/migrations/0022_alter_auditlog_action_type.py ruleset/models.py ruleset/migrations/0019_rulesetplanningdraft.py ruleset/planning.py ruleset/test_planning.py
git commit -m "feat: add ruleset planning draft domain"
```

### Task 2: Add draft services, historical projection, and CAS persistence

**Files:**
- Modify: `ruleset/planning.py`
- Modify: `ruleset/services.py`
- Modify: `ruleset/test_planning.py`
- Modify: `ruleset/test_services.py`

**Interfaces:**
- Consumes Task 1 `RulesetPlanningDraft`, `validate_planning_draft()`, `default_planning_payload()`, and `PLANNING_DRAFT_WRITE`.
- Produces `load_planning_draft(version)`, `save_planning_draft(version, *, payload, operator, expected_revision)`, `planning_projection_from_definition(definition)`, and `PlanningProjection`.

- [ ] **Step 1: Write failing service tests for save isolation and CAS.**

```python
class PlanningDraftServiceTests(TestCase):
    def test_saving_participant_count_does_not_create_round_or_change_definition(self):
        before_definition = self.version.definition
        before_rounds = ContestRound.objects.filter(activity=self.activity).count()
        saved = save_planning_draft(
            self.version,
            payload={"schema_version": 1, "stages": [{"business_id": "stage-1", "participants": {"source": "all_finalists", "count": {"value": 15, "resolution": "confirmed", "unit": "person"}}}]},
            operator=self.staff,
            expected_revision=0,
        )
        self.assertEqual(saved.revision, 1)
        self.version.refresh_from_db()
        self.assertEqual(self.version.definition, before_definition)
        self.assertEqual(ContestRound.objects.filter(activity=self.activity).count(), before_rounds)

    def test_stale_revision_is_rejected_without_overwriting_payload(self):
        save_planning_draft(self.version, payload={"schema_version": 1, "stages": []}, operator=self.staff, expected_revision=0)
        with self.assertRaises(ValidationError):
            save_planning_draft(self.version, payload={"schema_version": 1, "stages": [{"business_id": "other"}]}, operator=self.staff, expected_revision=0)
        self.assertEqual(RulesetPlanningDraft.objects.get(ruleset_version=self.version).revision, 1)
```

- [ ] **Step 2: Run the tests and confirm failure for the missing service API.**

Run: `uv run python manage.py test ruleset.test_planning.PlanningDraftServiceTests`

Expected: import/API failure before any database assertion.

- [ ] **Step 3: Implement lock-ordered load and save services.**

Implement a private `_lock_planning_draft_version()` that locks Activity, ContestRuleset and RulesetVersion in the existing order, then locks/creates the draft. `load_planning_draft()` initializes only the draft, using `default_planning_payload()` for a blank roster or a lossless `infer_business_stages()` projection with `source="historical_projection"`; it never creates a round or calls `save_business_ruleset()`.

Implement `save_planning_draft()` inside `transaction.atomic()`:

```python
require_current_staff(operator)
locked = _lock_planning_draft_version(version)
if locked.status != RulesetVersion.Status.DRAFT:
    raise PermissionDenied("已冻结赛制版本不可编辑规划草稿。")
draft = _get_or_create_locked_planning_draft(locked, operator)
if draft.revision != expected_revision:
    raise ValidationError("规划草稿已被其他编辑修改，请刷新后重试。")
validate_planning_draft(payload)
draft.payload = deepcopy(payload)
draft.revision += 1
draft.updated_by = operator
with authority_write(PLANNING_DRAFT_WRITE):
    draft.save(update_fields=["payload", "revision", "updated_by", "updated_at"])
AuditLog.objects.create(
    operator=operator,
    action_type=AuditLog.ActionType.UPDATE_RULESET_PLANNING,
    target=f"RulesetPlanningDraft:{draft.pk}",
    new_value=json.dumps({"revision": draft.revision, "payload": draft.payload}, ensure_ascii=False),
)
return draft
```

Incomplete fields are saveable; malformed shape and stale revision are rejected. The service must not call `save_business_ruleset()` or touch `ContestRound`.

- [ ] **Step 4: Run save/CAS/isolation tests and confirm they pass.**

Run: `uv run python manage.py test ruleset.test_planning.PlanningDraftServiceTests`

Expected: PASS, including zero new rounds and unchanged definition.

- [ ] **Step 5: Write failing tests for historical projection behavior.**

```python
class PlanningProjectionTests(SimpleTestCase):
    def test_golden_linear_definition_projects_to_editable_business_stages(self):
        projection = planning_projection_from_definition(golden_schidui())
        self.assertTrue(projection.editable)
        self.assertEqual([stage["advance_count"] for stage in projection.stages], [10, 5, 3])
        self.assertEqual(projection.source, "historical_projection")

    def test_complex_definition_is_read_only_and_keeps_manual_node_information(self):
        definition = {"schema_version": 1, "nodes": [{"key": "roster", "type": "ROSTER"}, {"key": "groups", "type": "PARTITION", "source": "entry", "by": "g"}, {"key": "manual", "type": "MANUAL_SELECT", "source": "groups", "count": 3, "decision_source": "manual_recorded_result"}], "checkpoints": [{"key": "final", "output": "manual"}]}
        projection = planning_projection_from_definition(definition)
        self.assertFalse(projection.editable)
        self.assertTrue(projection.read_only)
        self.assertIn("人工", projection.notice)
```

- [ ] **Step 6: Implement projection without lossy serialization.**

For a supported `infer_business_stages()` result, build business fields and server-owned `execution_refs`. For unsupported definitions, call `human_ruleset_summary()` only for presentation, append raw node `type`/round/vote metadata and checkpoint gaps, set `editable=False`, `read_only=True`, and never return a payload accepted by `apply_planning_to_ruleset()`. Catch invalid definitions and return a read-only “规则定义无法读取，请使用专业工具” projection.

- [ ] **Step 7: Run service and existing ruleset regressions.**

Run: `uv run python manage.py test ruleset.test_planning ruleset.test_services ruleset.test_business_editor`

Expected: PASS; existing business editor tests remain unchanged.

- [ ] **Step 8: Commit Task 2.**

```bash
git add ruleset/planning.py ruleset/services.py ruleset/test_planning.py ruleset/test_services.py
git commit -m "feat: persist ruleset planning drafts safely"
```

### Task 3: Convert complete planning payloads into candidates and safe DRAFT round configuration

**Files:**
- Modify: `ruleset/planning.py`
- Modify: `ruleset/services.py`
- Modify: `singer_contest/services.py`
- Modify: `ruleset/test_planning.py`
- Modify: `ruleset/test_services.py`

**Interfaces:**
- Consumes Task 1 field schema and Task 2 `execution_refs`/draft services.
- Produces `PlanningCompileResult`, `planning_payload_to_business_stages(payload)`, `prepare_planning_compile(payload, current_definition)`, `prepare_planning_compile_for_version(version)`, and `apply_planning_to_ruleset(version, *, operator, expected_revision)`.
- Produces `configure_draft_round_from_planning(contest_round, *, operator, configuration)` in `singer_contest.services`; it can mutate only an unlocked DRAFT round and writes an audit row.

- [ ] **Step 1: Write failing tests for candidate conversion and exact weights.**

```python
class PlanningCompileTests(SimpleTestCase):
    def test_two_rounds_contribute_to_one_stage_result(self):
        result = prepare_planning_compile(golden_planning_payload(weights=["30", "60"], audience_weight="10"), starter_definition())
        self.assertTrue(result.can_apply)
        self.assertEqual([s["weight"] for s in result.business_stages[0]["judge_sources"]], ["0.3", "0.6"])
        self.assertEqual(result.business_stages[0]["audience_weight"], "0.1")

    def test_missing_weight_or_conversion_blocks_candidate_but_does_not_raise(self):
        result = prepare_planning_compile(incomplete_planning_payload(), starter_definition())
        self.assertFalse(result.can_apply)
        self.assertIn("WEIGHTS_INCOMPLETE", {i.code for i in result.issues})

    def test_collaboration_groups_do_not_create_group_selection(self):
        result = prepare_planning_compile(collaboration_only_payload(), starter_definition())
        self.assertTrue(result.can_apply)
        self.assertNotIn("PARTITION", {node["type"] for node in result.candidate_definition["nodes"]})

    def test_non_linear_result_method_is_blocked_without_professional_graph(self):
        result = prepare_planning_compile(manual_result_payload(), starter_definition())
        self.assertFalse(result.can_apply)
        self.assertIn("UNSUPPORTED_RESULT_METHOD", {i.code for i in result.issues})
```

- [ ] **Step 2: Run the compile tests and confirm they fail before the adapter exists.**

Run: `uv run python manage.py test ruleset.test_planning.PlanningCompileTests`

Expected: missing `PlanningCompileResult` or adapter failure.

- [ ] **Step 3: Implement the pure candidate adapter.**

Use `Decimal` throughout. Map multiple judge rounds into one stage `judge_sources` list; map prior-stage score to `previous_weight`; map audience only when a named vote source and current binding conversion rule exist; never map raw votes directly into a score. Return:

```python
@dataclass(frozen=True)
class PlanningCompileResult:
    issues: tuple[PlanningIssue, ...]
    candidate_definition: dict | None
    business_stages: tuple[dict, ...]
    round_configurations: tuple[dict, ...]
    change_summary: tuple[str, ...]

    @property
    def can_apply(self) -> bool:
        return self.candidate_definition is not None and not any(i.blocks_apply for i in self.issues)
```

Call `business_definition_from_stages()` only after all required values are present. Preserve existing definition context. If `infer_business_stages()` rejects the current definition, reject the edit rather than replacing it with a linear graph. The diff summary must describe business facts such as “新增第一轮小组演唱、第二轮个人独唱；第一阶段按 30% / 60% / 10% 合成，晋级 10 人”, not expose node keys as the main message.

- [ ] **Step 4: Run pure compile tests and verify exact Decimal assertions.**

Run: `uv run python manage.py test ruleset.test_planning.PlanningCompileTests`

Expected: PASS; assertions cover server-derived 0.3/0.6/0.1, not client floats.

- [ ] **Step 5: Write failing tests for DRAFT round configuration guards.**

```python
class PlanningRoundConfigurationTests(TestCase):
    def test_planning_can_configure_only_an_unlocked_draft_round(self):
        contest_round = ContestRound.objects.create(activity=self.activity, round_type=ContestRound.RoundType.PRELIMINARY, status=ContestRound.Status.DRAFT, is_locked=False)
        configured = configure_draft_round_from_planning(contest_round, operator=self.staff, configuration={"name": "第一轮小组演唱", "judge_count": 5, "scoring_mode": ContestRound.ScoringMode.AVERAGE, "advance_count": 10, "roster_source": ContestRound.RosterSource.APPROVED, "roster_source_stage": "", "rubric": None})
        self.assertEqual(configured.judge_count, 5)

    def test_planning_rejects_a_prepared_round(self):
        with self.assertRaises(PermissionDenied):
            configure_draft_round_from_planning(prepared_round_for(self.activity), operator=self.staff, configuration={"name": "修改"})
```

- [ ] **Step 6: Implement the round service and apply transaction.**

`configure_draft_round_from_planning()` calls `require_current_staff()`, locks Activity then the round, requires `status == DRAFT` and `is_locked is False`, validates positive judge count and existing choices, saves only configuration fields, and writes an audit row. It never changes scores, entries, judges, status, lock flags or confirmed results. If rubric criteria are provided, accept only the existing `ScoringRubric/RubricCriterion` constraints, including the current 100-point total; otherwise return `RUBRIC_NOT_APPLICABLE` as a blocking execution issue instead of dropping criteria.

Implement `prepare_planning_compile_for_version(version)` by loading the current draft, definition, binding and round configuration signature. Implement `apply_planning_to_ruleset()` in one outer `transaction.atomic()`:

1. `require_current_staff(operator)` and lock Activity → ContestRuleset → Version → Draft.
2. Refuse FROZEN version or stale `expected_revision`.
3. Run `prepare_planning_compile()` against locked state; reject any `blocks_apply` issue.
4. Configure only DRAFT rounds through `configure_draft_round_from_planning()`.
5. Call `save_business_ruleset()` with locked `content_hash`, `_binding_signature(locked_ruleset)`, and `business_round_configuration_signature(all_activity_rounds)`.
6. Update draft applied metadata only after the existing save succeeds; outer rollback undoes new rounds, round config, binding and definition together if any step fails.

- [ ] **Step 7: Run candidate, round guard, and existing authority tests.**

Run: `uv run python manage.py test ruleset.test_planning ruleset.test_services singer_contest.tests`

Expected: PASS, including no mutation of prepared/locked rounds and no regression in freeze/save services.

- [ ] **Step 8: Commit Task 3.**

```bash
git add ruleset/planning.py ruleset/services.py singer_contest/services.py ruleset/test_planning.py ruleset/test_services.py
git commit -m "feat: prepare safe ruleset planning candidates"
```

## Task 4: Add the ordinary planning workbench UI and client model

**Files:** Create `templates/staff_panel/ruleset_planning.html`, `frontend/ruleset_planning.ts`, and `tests/client/ruleset_planning.test.mjs`; generate `static/dist/ruleset_planning.js`; modify `staff_panel/urls.py`, `staff_panel/views.py`, and the existing ruleset creation/clone templates.

- [ ] **Step 1: Add failing Django view tests for the ordinary route.**

Add `RulesetPlanningViewTests` covering these exact behaviors:

```python
def test_ruleset_create_redirects_to_planning(self):
    activity = _create_activity(name="规划工作台测试活动")
    response = self.client.post(
        reverse("staff:contest_ruleset_create"),
        {"activity": activity.pk, "name": "新比赛"},
    )
    version = RulesetVersion.objects.get(ruleset__activity=activity)
    self.assertRedirects(response, reverse("staff:ruleset_planning", args=[version.pk]))

def test_planning_page_contains_business_sections_without_technical_terms(self):
    response = self.client.get(self.planning_url)
    self.assertContains(response, "比赛流程")
    self.assertContains(response, "成绩与晋级")
    self.assertNotContains(response, "RulesetVersion")
    self.assertNotContains(response, "content_hash")
    self.assertNotContains(response, "binding_signature")

def test_invalid_planning_save_renders_raw_input_and_issue(self):
    response = self.client.post(self.planning_url, {
        "payload": '{"schema_version": 1, "stages": [{"name": "初赛", "weight": "bad"}]}',
        "revision": "0",
    })
    self.assertEqual(response.status_code, 400)
    self.assertContains(response, '"weight": "bad"')
    self.assertContains(response, "百分比格式")
```

Run `uv run python manage.py test staff_panel.tests.RulesetPlanningViewTests`; it must fail because the planning route and template do not exist yet.

- [ ] **Step 2: Add the routes and view contracts.**

Add named routes `ruleset_planning`, `ruleset_planning_preview`, and `ruleset_planning_apply` under the existing staff ruleset namespace. The GET view loads the current draft and the historical read-only projection. The draft POST calls `save_planning_draft()` and renders status 400 with the exact raw JSON and validation issues when input is invalid or stale. The preview POST calls `prepare_planning_compile_for_version()` without mutation. The apply POST calls `apply_planning_to_ruleset()` and redirects only after success; it renders blocking issues with status 400 otherwise. Every view uses the existing staff authority decorator/helper and never accepts an Activity/version ID from a hidden field when it is already in the URL.

Change ordinary ruleset creation, template clone, and last-year clone success redirects to `ruleset_planning`. Preserve the professional `ruleset_edit` POST, bind, validate, and freeze routes and their permission behavior. Add a link from the existing ruleset detail/edit entry point to the planning route.

- [ ] **Step 3: Build the server-rendered business template.**

Render sections titled exactly `比赛流程`, `比赛环节`, `成绩与晋级`, `尚待确定`, and `启用前检查`. Show stage/round names, weights, collaboration group meaning, advancement groups, judge count, scoring method, unit labels, and unresolved/conflict evidence. Provide an accessible copy button for the structured pending/conflict messages and a readable candidate difference summary. Use Chinese business labels for `text`, `person`, `group`, `judge`, `minute`, `score`, `percent`, and `vote`. Include the draft revision and serialized payload in form controls needed for CAS, but do not display technical IDs, model names, content hashes, binding signatures, raw definitions, or ruleset code. Separate 保存草稿, 预览, and 应用 to正式规则 forms. Show the existing admin-only freeze note when the version is not editable.

- [ ] **Step 4: Add failing client tests for stable business identifiers and percentages.**

In `tests/client/ruleset_planning.test.mjs`, follow the existing client-test pattern: read `static/dist/ruleset_planning.js`, execute it in a `vm` context with a fake `window` and `document`, and read the pure helpers from `window.ArtFlowRulesetPlanning`. Assert:

```javascript
const source = readFileSync(new URL("../../static/dist/ruleset_planning.js", import.meta.url), "utf8");
const context = { window: {}, document: { querySelector: () => null } };
vm.runInNewContext(source, context);
const { addStage, formatPercentageTotal } = context.window.ArtFlowRulesetPlanning;
const first = addStage({ name: "初赛" });
const second = addStage({ name: "决赛" });
assert.notEqual(first.business_id, second.business_id);
assert.equal(formatPercentageTotal(["30%", "60%", "10%"]).label, "30% + 60% + 10% = 100%");
assert.equal(formatPercentageTotal(["0.5%"]).total, "0.5");
```

Run `npm run build:client`; the test must fail until the new entry point exists.

- [ ] **Step 5: Implement the plain TypeScript client entry point.**

Expose `buildPlanningPayload`, `formatPercentageTotal`, `addStage`, `removeStage`, and `addRound` through `window.ArtFlowRulesetPlanning` so the plain-IIFE entry point matches the repository’s current client-test/runtime pattern. Keep the client state as the business payload shape only. Generate each stage/round `business_id` with `crypto.randomUUID()` and a deterministic fallback counter when unavailable; never clone an existing ID when duplicating a row. Keep percentage text as strings in the browser, format totals for `aria-live`, and let the server’s `Decimal` parser decide validity. Serialize only supported business fields and preserve evidence/resolution values in the draft form. Wire the accessible copy button to the same client entry point with a clipboard API fallback.

- [ ] **Step 6: Run UI and client verification.**

Run, in order:

```bash
uv run python manage.py test staff_panel.tests.RulesetPlanningViewTests
npm run build:client
node --test tests/client/ruleset_planning.test.mjs
npm run check:client
npm run check:css
```

Expected: all focused Django and client tests pass; the checked-in `static/dist/ruleset_planning.js` is current; the CSS bundle has not drifted.

- [ ] **Step 7: Commit Task 4.**

```bash
git add staff_panel/urls.py staff_panel/views.py templates frontend/ruleset_planning.ts tests/client/ruleset_planning.test.mjs static/dist/ruleset_planning.js
git commit -m "feat: add ruleset planning workbench"
```

## Task 5: Cover the end-to-end workflow and compatibility boundaries

**Files:** Modify `staff_panel/tests.py`, `staff_panel/tests_operator_e2e.py`, `ruleset/test_planning.py`, `ruleset/test_services.py`, and the existing ruleset templates/tests only where redirect or navigation expectations change.

- [ ] **Step 1: Add failing workflow tests before broad regression runs.**

Cover this sequence with a Golden 15→10→5→3 fixture: create a draft, save incomplete fields, preview without mutation, resolve all required fields, apply, verify the production definition and draft round configuration, then freeze through the existing admin flow. Add assertions that unresolved/conflict issues block apply, a 30/60/10 total is accepted, a 0.5% value is preserved, and missing school-scoring dependency is reported as a blocking issue. Add a two-round-one-stage fixture and assert the stage remains one business stage while its rounds remain separately configurable.

Add a complex historical definition fixture and assert the ordinary workbench is read-only, shows the existing human summary, does not invent a linear editable payload, and does not mutate the frozen definition. Add regression assertions for prepared and locked rounds, existing binding signatures, audit events, file access, and destructive-data guards.

- [ ] **Step 2: Implement only the compatibility adjustments required by the workflow.**

Update creation/clone redirect assertions and links to the planning route. Keep the professional editor and the existing `save_business_ruleset()`, binding, validation, freeze, scoring, export, archive, and authority guards unchanged except for the documented planning service call. Do not weaken any existing validator to make the planning path pass. Do not copy hidden technical IDs from a source template into a new planning draft.

- [ ] **Step 3: Run focused integration tests.**

Run:

```bash
uv run python manage.py test ruleset.test_planning ruleset.test_services staff_panel.tests staff_panel.tests_operator_e2e
```

Expected: the new Golden workflow passes, complex definitions remain read-only, only DRAFT/unlocked rounds are configurable, and the existing staff/operator regression suite remains green.

- [ ] **Step 4: Commit Task 5.**

```bash
git add ruleset/test_planning.py ruleset/test_services.py staff_panel/tests.py staff_panel/tests_operator_e2e.py templates
git commit -m "test: cover ruleset planning workflow boundaries"
```

## Task 6: Sweep configuration and perform the full verification pass

**Files:** Inspect `pyrightconfig.json`, `pyproject.toml`, `tailwind.config.js`, `tsconfig*.json`, `.gitignore`, `.dockerignore`, `.env.example`, `.env.production.example`, `.env.event.example`, and `.github/dependabot.yml`; modify only files whose configured coverage omits a newly added source or artifact.

- [ ] **Step 1: Perform the configuration sweep.**

Confirm that `ruleset/planning.py`, the new views, the TypeScript entry point, browser/client tests, and generated client output are covered by the existing Python, TypeScript, CSS, and client checks. Confirm no new environment variable, local media, database, backup, archive, or upload path is introduced. If a configuration omission is found, patch it narrowly and add the corresponding gate to the verification record.

- [ ] **Step 2: Run blocking repository checks.**

Run:

```bash
git diff --check
uv run python manage.py check
uv run python manage.py makemigrations --check --dry-run
npm run check:client
npm run check:css
npm run check:pyright
```

Expected: zero diagnostics, no pending migrations, no stale client/CSS output, and no whitespace errors.

- [ ] **Step 3: Run the complete test suites.**

Run:

```bash
uv run python manage.py test
npm run test:client
```

Run `npm run check:e2e` and `npm run test:e2e` only when the required local web service and Chromium installation are available; record the skipped prerequisite if they are not. Do not run database reset, volume deletion, or destructive cleanup commands.

- [ ] **Step 4: Perform the manual acceptance sequence.**

As a staff operator, create a new ruleset, enter Golden 15→10→5→3, set 30/60/10 weights, add two rounds under one stage, leave one field pending, save, reload, and verify the evidence/resolution state persists. Preview must show the blocking issue without changing the definition. Resolve the issue, apply, confirm the existing professional editor shows the compiled result, and verify that a non-admin cannot freeze it. As an admin, freeze it and verify the planning page becomes read-only. Open a complex historical ruleset and verify it is read-only with no lossy editable projection. Inspect the audit log for the planning draft write and apply events.

- [ ] **Step 5: Verify the final change set.**

Run:

```bash
git status --short --branch
git diff --check
git log --oneline -8
```

Confirm each commit is scoped, no generated/local/private artifacts are tracked, migrations are included, and the final report names the focused/full checks that passed plus any explicitly skipped E2E prerequisite.

- [ ] **Step 6: Commit any final verification-only fixes separately.**

If the gates expose a real defect, add a regression test first, make the smallest fix, rerun the affected gate, and use a separate conventional commit such as `fix: ...` or `test: ...`. Do not amend an earlier logical commit or combine unrelated fixes.
