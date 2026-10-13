# 赛制规则准备工作台设计

日期：2026-10-13

## 目标

为普通工作人员提供“比赛规则准备”工作台，使其可以用比赛实际流程描述阶段、演唱轮次、成绩来源、成绩比例和晋级方式，并把未知事项保留为待确认问题。普通草稿的保存不能修改正式执行定义、实际比赛轮次或已冻结版本；管理员仍通过现有冻结服务产生正式权威版本。

## 范围与不变项

- 保留现有 `ruleset_edit`、`ruleset_bind`、高级节点编辑器和冻结入口，以兼容既有后台页面及测试。
- 新增独立的 `RulesetPlanningDraft`，一对一归属可编辑的 `RulesetVersion` DRAFT。
- 草稿保存只更新规划草稿及审计信息，不写 `RulesetVersion.definition`、`ContestRuleset.round_keys`、`ContestRound` 或 FROZEN 版本。
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
- `source`：手工录入或历史投影，便于审计和解释来源。

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

### 2. 规划纯函数与服务

新增 `ruleset/planning.py`，负责不依赖 HTTP 的业务逻辑：

- `parse_percentage(value)`：用 `Decimal` 解析 `50`、`50%`、`0.5`，拒绝负数、超过 100%、NaN 和 Infinity；未带百分号且介于 0 和 1 的输入返回需要确认标志，不静默变成 50%。
- `validate_planning_draft(payload)`：返回结构化 `PlanningIssue`，区分信息缺失、业务矛盾和执行风险，并包含 `code`、`severity`、`stage_id`、`round_id`、`field_path`、普通用户提示和阻止正式应用标志。
- `planning_payload_to_business_stages(payload)`：只在业务信息完整且表达能力足够时转换为旧 `business_definition_from_stages()` 所需的适配结构；不会为未知名额、未知比例或未知评分来源生成默认值。
- `prepare_planning_compile(payload, current_definition)`：运行规划校验并生成候选节点、检查报告和可读差异；复杂图或缺分依赖返回阻止应用的问题。
- `planning_projection_from_definition(definition)`：复用 `infer_business_stages()` 展示可无损的历史阶段；对复杂图返回只读解释，不丢弃节点。

在 `ruleset/services.py` 暴露事务服务，供视图和测试调用：

- `load_planning_draft(version)`：获取或按当前可编辑版本初始化草稿；初始化只写草稿，不创建执行轮次。
- `save_planning_draft(version, payload, operator, expected_revision)`：锁定活动和规则版本，Compare-and-Swap 检查 `revision`，保存后递增版本；DRAFT 之外拒绝写入。
- `validate_planning_draft(version_or_payload)`：返回规划问题和摘要。
- `prepare_planning_compile(version)`：重新读取版本权威数据，返回候选和差异报告。
- `apply_planning_to_ruleset(version, operator, expected_revision)`：重新锁定并读取草稿，拒绝过期 revision，确认无阻止问题后调用既有 `save_business_ruleset()`；应用动作才允许创建 `ContestRound`、更新定义和绑定。

### 3. 普通工作台

新增路由 `ruleset_planning`，页面标题为“比赛规则准备”。页面区域按以下顺序显示：

1. 比赛流程：参赛人数、各阶段来源、阶段结果和晋级关系；
2. 比赛环节：每阶段的实际演唱轮次，可添加、编辑和删除，使用业务形式名称；
3. 成绩与晋级：成绩来源、百分比总计和自然语言结果方式；
4. 尚待确定：由结构化校验问题生成，支持复制文本；
5. 启用前检查：显示可保存、可生成候选、可正式应用的状态。

普通表单提交 JSON 草稿，并携带 `revision`。后端重新按 schema 校验业务字段，错误时重新渲染原始输入和字段路径，不创建轮次。百分比输入旁显示 `%` 和含义说明，修改后由前端立即显示总计；最终计算和校验仍以服务端 `Decimal` 为准。

`contest_ruleset_create()` 创建或复用版本后默认跳转 `ruleset_planning`。旧 `ruleset_edit` 重定向和 POST 行为保持不变；专业编辑器仍展示技术详情、绑定和冻结前检查。

### 4. 历史规则与复杂规则

普通工作台首次打开时：

- 若已有可无损线性定义，使用 `infer_business_stages()` 转换为业务草稿，标记来源为历史投影；
- 若定义包含 `PARTITION`、`MANUAL_SELECT`、`FILL_TO_QUOTA` 或其他无法无损表达的节点，展示实际可读的阶段/轮次和“需要专业工具修改”的问题，不自动删除或重写节点；
- 不根据“5 组 × 3 人”推导按组晋级；合作分组仅作为演唱描述，除非草稿明确声明分组参与结果计算。

## 并发、权限与事务

保存草稿遵循 Activity → ContestRuleset → RulesetVersion 的锁顺序，使用 `select_for_update()` 和 `revision` CAS。应用候选时重新获取规则版本、草稿和绑定快照，并把当前 `content_hash`、绑定签名和轮次配置签名传给既有保存服务。活动已锁定、版本已冻结、轮次已开始或已有正式保护时，服务端拒绝越权修改。

草稿保存失败不改变输入；视图将带路径的校验信息放回页面。应用失败不会留下部分定义或轮次，因为应用过程在现有事务中完成。

## 测试策略

- 纯函数测试覆盖百分比单位、Decimal 精度、resolution 语义、问题分级、总计和缺分依赖。
- 模型/服务测试覆盖草稿保存不创建轮次、revision 冲突、FROZEN 隔离、复杂定义只读和应用事务。
- Staff Panel 测试覆盖普通路由、创建后跳转、页面不暴露技术字段、保存失败回显、差异预览和管理员冻结兼容。
- 保留并运行 `ruleset/test_business_editor.py`、`ruleset/test_services.py`、`singer_contest/tests.py`、`staff_panel/tests.py`。

## 实施顺序

1. 新模型、迁移、规划纯函数及失败测试；
2. 草稿读写服务、CAS 与结构化问题；
3. 普通工作台路由、模板和浏览器交互；
4. 安全候选、差异预览和应用流程；
5. 历史投影、复杂规则只读提示、Golden Case 和全量验证。
