# 赛制规则准备工作台设计

日期：2026-10-13

## 目标

为普通工作人员提供“比赛规则准备”工作台，使其可以用比赛实际流程描述阶段、演唱轮次、成绩来源、成绩比例和晋级方式，并把未知事项保留为待确认问题。普通草稿的保存不能修改正式执行定义、实际比赛轮次或已冻结版本；管理员仍通过现有冻结服务产生正式权威版本。

## 范围与不变项

- 保留现有 `ruleset_edit`、`ruleset_bind`、高级节点编辑器和冻结入口，以兼容既有后台页面及测试。
- 新增独立的 `RulesetPlanningDraft`，一对一归属可编辑的 `RulesetVersion` DRAFT。
- 草稿保存只更新规划草稿及审计信息，不写 `RulesetVersion.definition`、`ContestRuleset.round_keys`、`ContestRound` 或 FROZEN 版本。
- `RulesetPlanningDraft` 的“只能归属 DRAFT”无法由跨表数据库约束表达，必须同时由模型 `clean()/save()` 和事务服务检查；普通 ORM 更新不作为合法写入路径。
- 为草稿保存增加专用 `AuditLog.ActionType.UPDATE_RULESET_PLANNING` 及迁移；草稿 `source` 记录手工录入、历史投影等来源，字段级 `evidence` 保留材料或负责人确认记录。
- 正式候选应用必须通过 `validate_planning_draft()`、`prepare_planning_compile()`，再调用既有 `save_business_ruleset()`；现有 Compiler、Validator、权限、活动锁和并发保护继续有效。
- 复杂节点图不能被强制投影成线性阶段。普通工作台对不可无损表达的历史规则只读显示，并明确提示需要专业工具。
- 不引入 React、Vue、Redis、外部模型或新的运行服务。

## 组件与数据流

### 1. 业务草稿模型

在 `ruleset/models.py` 增加 `RulesetPlanningDraft`：

- `ruleset_version`：`OneToOneField(RulesetVersion)`，只允许关联 DRAFT；
- `payload`：版本化业务 JSON；
- `revision`：从 0 开始的乐观并发号；
- `updated_by`、`created_at`、`updated_at`；
- `source`：手工录入、历史投影或人工导入，便于审计和解释来源。

模型层不能用 `CheckConstraint` 检查关联版本的状态，因此 `clean()/save()` 只允许关联版本处于 DRAFT；服务层在 Activity → ContestRuleset → RulesetVersion 锁内再次检查。冻结后保留该版本的草稿作为历史材料，但 `load/save/apply` 均拒绝把 FROZEN 版本当作当前编辑对象。

业务 JSON 使用稳定的 `business_id`，不使用数组下标作为身份。每个有业务含义的字段使用统一结构：

```json
{
  "value": 15,
  "resolution": "confirmed",
  "evidence": "2025 院十佳预热说明第 2 页",
  "unit": "person"
}
```

允许的 `resolution` 为 `confirmed`、`pending`、`conflict`。明确的 `false` 是已确认值，不等同于 `null`。阶段结构至少包含参赛来源、阶段名称、演唱轮次、成绩来源、百分比和结果方式；轮次结构包含演唱形式、分组描述、评委数量、单项满分、评分维度和评分计算方式。

草稿的业务字段不携带给普通用户看的技术标识。为支持删除、调整和历史投影，服务端可以在 payload 中维护不可编辑的 `execution_refs`（业务 `business_id` 到已有执行阶段/轮次的内部映射），但每次保存都从已锁定的数据库状态重建并校验它，不能信任浏览器提交的内部映射，也不能按数组下标重新绑定。

业务语义必须明确区分：比赛阶段是产生一次阶段结果或晋级名单的业务步骤；演唱轮次是舞台上实际发生的一场表演/评分活动；一个阶段可以包含多个轮次。合作演唱的分组只描述同组表演、每人单独评分，只有草稿明确选择“按组晋级”时才允许生成组级结果规则；“5 组 × 3 人”本身不能推导 `PARTITION + 每组 SELECT`。

schema 固定单位并由服务端验证：`person`、`group`、`judge`、`minute`、`score`、`percent`、`vote`。页面始终显示单位；百分比保存为百分数语义（例如 `30` 表示 30%），候选适配时才由 Decimal 转成 `Decimal("0.3")`。评分维度的“30 分”和综合成绩的“30%”使用不同字段和不同单位，不能互换。

### 2. 规划纯函数与服务

新增 `ruleset/planning.py`，负责不依赖 HTTP 的业务逻辑。函数签名固定如下：

- `parse_percentage(value) -> ParsedPercentage`：用 `Decimal` 解析 `50`、`50%`、`0.5`，拒绝负数、超过 100%、NaN 和 Infinity；未带百分号且介于 0 和 1 的输入返回需要确认标志，不静默变成 50%。返回值同时包含百分数值、执行系数和 `requires_confirmation`，后续服务端计算只使用 Decimal。
- `validate_planning_draft(payload) -> tuple[PlanningIssue, ...]`：返回结构化 `PlanningIssue`，区分 `missing_information`、`business_conflict` 和 `execution_risk`，并包含 `code`、`severity`、`stage_id`、`round_id`、`field_path`、普通用户提示、确认对象和 `blocks_apply`。
- `planning_payload_to_business_stages(payload) -> list[dict]`：只在业务信息完整且表达能力足够时转换为旧 `business_definition_from_stages()` 所需的适配结构；不会为未知名额、未知比例或未知评分来源生成默认值。
- `prepare_planning_compile(payload, current_definition) -> PlanningCompileResult`：运行规划校验并生成候选节点、检查报告和可读差异；复杂图、未映射的评分维度或缺分依赖返回阻止应用的问题。
- `planning_projection_from_definition(definition) -> PlanningProjection`：对可无损线性定义复用 `infer_business_stages()`；对复杂定义使用现有只读 `ruleset.editor.human_ruleset_summary()` 加原始 checkpoint/node 类型生成阶段、人工决定和未知事项的可读投影，不把复杂图转换成可编辑阶段。

规划支持的自然语言结果方式至少包括“按成绩取前 N 人”“每组晋级 N 人”“负责人/评委人工确定”“复活赛产生”“按既定规则补足名额”“尚未确定”。只有前一种可无损映射到现有线性适配器；其余方式若当前定义已有对应专业节点则只读展示，否则产生阻止应用的问题，绝不要求工作人员伪造 `advance_count`。

在 `ruleset/services.py` 暴露事务服务，供视图和测试调用。纯函数 `validate_planning_draft(payload)` 保持在 `ruleset.planning`；服务不提供模糊的 `version_or_payload` 重载：

- `load_planning_draft(version: RulesetVersion) -> RulesetPlanningDraft`：在需要创建草稿时按 Activity → ContestRuleset → RulesetVersion 顺序锁定，获取或按当前定义初始化草稿；初始化只写草稿，不创建执行轮次。
- `save_planning_draft(version, *, payload, operator, expected_revision) -> RulesetPlanningDraft`：锁定 Activity、ContestRuleset、RulesetVersion 和草稿，Compare-and-Swap 检查 `revision`，保存后递增版本并写草稿审计；DRAFT 之外拒绝写入。
- `prepare_planning_compile(version: RulesetVersion) -> PlanningCompileResult`：重新读取版本、绑定和当前轮次配置，调用纯函数候选生成；不写任何正式数据。
- `apply_planning_to_ruleset(version, *, operator, expected_revision) -> RulesetVersion`：在同一事务内重新锁定并读取草稿，拒绝过期 revision，确认无 `blocks_apply` 问题后先安全应用 DRAFT 轮次/评分配置，再调用既有 `save_business_ruleset()`。只有该动作允许创建 `ContestRound`、更新 DRAFT 定义和更新绑定；任一步失败整体回滚。

规划字段不能被适配器静默丢弃。评委数量、评分模式、晋级人数和名单来源映射到现有 `ContestRound` DRAFT 配置；评分维度映射到现有 `ScoringRubric/RubricCriterion` 约束。若已有轮次已准备、评分标准已被使用，或当前评分服务无法表达给定满分/维度组合，返回 `execution_risk` 并阻止应用，提示使用专业轮次/评分标准工具。规划服务不绕过这些模型的现有保护，也不把仅存在于草稿中的描述当作已绑定的运行事实。

### 3. 普通工作台

新增路由 `ruleset_planning`（`rulesets/<int:pk>/planning/`），页面标题为“比赛规则准备”。页面区域按以下顺序显示：

1. 比赛流程：参赛人数、各阶段来源、阶段结果和晋级关系；
2. 比赛环节：每阶段的实际演唱轮次，可添加、编辑和删除，使用业务形式名称；
3. 成绩与晋级：成绩来源、百分比总计和自然语言结果方式；
4. 尚待确定：由结构化校验问题生成，支持复制文本；
5. 启用前检查：显示可保存、可生成候选、可正式应用的状态。

普通工作台不得显示或要求填写 `stage_key`、`round_key`、`source_stage_key`、节点类型、`ContestRound` 主键、binding JSON、依赖拓扑、创建技术轮次复选框或裸权重小数。阶段来源使用“所有符合条件的决赛选手 / 上一阶段晋级选手 / 指定比赛结果产生 / 尚未确定”，成绩来源使用“当前某轮评委成绩 / 上一阶段综合成绩 / 其他已知轮次 / 观众计分 / 负责人确定的人工来源”。

每次比例修改都在页面即时显示类似“30% + 60% + 10% = 100%”；总计不完整仍可保存草稿，但“生成正式规则候选”和“应用”必须被问题清单阻止。`0.5` 这种未带百分号且在 0 与 1 之间的输入要显示含义确认，而不是静默改成 50%。

普通表单提交 JSON 草稿，并携带 `revision`。后端重新按 schema 校验业务字段，错误时重新渲染原始输入和字段路径，不创建轮次。百分比输入旁显示 `%` 和含义说明，修改后由前端立即显示总计；前端总计只用于即时提示，最终计算、系数转换和候选定义仍以服务端 `Decimal` 为准，不能把 JS float 写入权威字段。

`contest_ruleset_create()`、从生产模板克隆的入口和“克隆去年模板”完成后默认跳转 `ruleset_planning`。旧 `ruleset_edit` 重定向和 POST 行为保持不变；专业编辑器仍展示技术详情、绑定和冻结前检查，并可链接回普通工作台。

### 4. 历史规则与复杂规则

普通工作台首次打开时：

- 若已有可无损线性定义，使用 `infer_business_stages()` 转换为业务草稿，标记来源为历史投影，并生成服务端 `execution_refs`；
- 若定义包含 `PARTITION`、`MANUAL_SELECT`、`FILL_TO_QUOTA` 或其他无法无损表达的节点，使用只读人类摘要展示 checkpoint、轮次来源、人工决定和节点类型，并产生“需要专业工具修改”的问题；不自动删除或重写节点，也不把只读摘要写回可执行定义；
- 若复杂定义没有 checkpoint，现有人类摘要无法给出阶段卡片时，至少列出可识别的实际轮次来源、节点类型、人工决定和绑定缺口，并明确“阶段边界尚未声明”；不能凭节点顺序猜测阶段。
- 不根据“5 组 × 3 人”推导按组晋级；合作分组仅作为演唱描述，除非草稿明确声明分组参与结果计算。

可选的“粘贴策划案文字”不在本轮主链路内；如后续增加，只产生带“文档明确 / 上下文推断待核对 / 未提及 / 资料冲突”标记的候选草稿，不能直接写正式定义，也不能成为手工编辑的必需依赖。

## 并发、权限与事务

保存草稿遵循 Activity → ContestRuleset → RulesetVersion → RulesetPlanningDraft 的锁顺序，使用 `select_for_update()` 和 `revision` CAS；初始化草稿也必须在该锁内避免双 Staff 重复创建。应用候选时重新获取规则版本、草稿和绑定快照，并把当前 `content_hash`、绑定签名和轮次配置签名传给既有保存服务。活动已锁定、版本已冻结、轮次已准备/评分/锁定或已有正式结果保护时，服务端拒绝越权修改；应用规划不改变已存在的执行事实。

草稿保存失败不改变输入；视图将带路径的校验信息放回页面。应用失败不会留下部分定义或轮次，因为应用过程在现有事务中完成。

## 测试策略

- 纯函数测试覆盖百分比单位（`50`、`50%`、`0.5`）、Decimal 精度、resolution 语义、统一单位、问题分级、总计、缺分依赖、自然语言结果方式和“合作分组不等于按组晋级”。
- 模型/服务测试覆盖只填写 15 人即可保存且不创建轮次、revision 冲突、FROZEN 隔离、跨表 DRAFT 守卫、复杂定义只读、应用事务回滚、已准备/评分/锁定轮次拒绝修改，以及 2025 校十佳跳过第二轮时保存待确认并阻止应用。
- 业务 Golden Case 测试覆盖 2025 院十佳 15→10→5→3、第一阶段两轮演唱共同贡献一次晋级、30%/60%/10% 编译为精确 0.3/0.6/0.1、两个 Staff 同时编辑旧 revision 被拒绝、两份材料冲突不静默覆盖、新增/删除/调整阶段不复制隐藏 ID。
- Staff Panel 测试覆盖普通路由、创建和模板克隆后跳转、页面不暴露技术字段、保存失败回显、问题复制、差异预览和管理员冻结兼容；继续运行 `ruleset/test_business_editor.py`、`ruleset/test_services.py`、`singer_contest/tests.py`、`staff_panel/tests.py`。

预计新增迁移为 `ruleset/migrations/0019_rulesetplanningdraft.py` 和 `common/migrations/0022_alter_auditlog_action_type.py`；实际编号以迁移生成器根据当前树为准，不能修改既有迁移。

## 实施顺序

1. 新模型、迁移、规划纯函数及失败测试；
2. 草稿读写服务、CAS 与结构化问题；
3. 普通工作台路由、模板和浏览器交互；
4. 安全候选、差异预览和应用流程；
5. 历史投影、复杂规则只读提示、Golden Case 和全量验证。
