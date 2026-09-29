# Human Acceptance Batch 2 Design

**日期：** 2026-09-29
**状态：** 待审阅
**基线：** `main@24231758a36e19be1e1f0731c0b1fb4abb5de9c8`

## 目标

让一个刚完成首次管理员注册、不了解 Django/JSON/数据库内部实现的活动负责人，能够仅通过后台可见导航完成一次活动的基本配置与现场准备；所有当前页面提供的主要操作都必须在当前上下文中可完成，或在操作前明确解释不可用原因。

本批次覆盖审核报告中的确定性错误、死路导航、跨活动候选混杂、核心工作人员配置 JSON/ID 输入、表单丢失输入、模板初始化和首次管理员可见导航。结果计算、评分 authority、锁定/解锁 authority、文件私有访问和数据库安全边界必须保持成立。

## 已确认的业务契约

### 1. Award authority

正式 `Award` 只能由已确认的 `StageResult` 及其 `StageAwardDecision` 物化。

- 移除/停用直接创建 `source_node="MANUAL"` Award 的后台主流程和服务路径。
- 不提供“任意选手 + 任意奖项名称”的直接人工发奖能力。管理员人工纠偏只能通过冻结 Ruleset 中已声明的 `MANUAL_SELECT`/人工决策节点影响晋级；只有该冻结规则中已经声明的 `AWARD` 节点，经过重新解析产生 `StageAwardDecision`，再经核定后才能物化 Award。`MANUAL_SELECT` 本身不直接产生奖项候选。
- 旧的直接手工 Award 路由不再作为兼容入口；若保留 URL，必须返回明确的业务迁移提示且不得写入 Award。
- `official_stage_award_queryset()`、导出、公示和归档仍只认可当前有效、已核定、来源完整的 StageResult Award。
- 不删除历史已有的 legacy Award 行；历史数据的读取按现有兼容策略处理，并新增测试证明新写入不能绕过来源链。

### 2. Activity lifecycle and identity

- 新建活动固定从 `DRAFT` 开始。
- 编辑活动阶段选择只展示当前阶段在 `PHASE_EDGES` 中允许的下一阶段；当前阶段保持为已选项，不能直接跳跃。
- `ARCHIVED` 不进入普通阶段选择；归档活动只能显示“解归档”操作。
- 归档或锁定活动不显示会必然失败的普通编辑/解锁操作；后端仍保留最终 permission/authority 校验。
- `activity_unarchive` 成为归档活动的唯一可见恢复入口。
- `activity_type` 在创建后不可变。UI 不再渲染可编辑控件，服务/model 层也拒绝直接改变已持久化类型，防止 Singer/Graduation 领域数据语义裂开。

### 3. Ruleset and questionnaire editors

- Ruleset 当前继续保留 forward-only 执行契约；本批次不把显示顺序/执行拓扑完全重构为 DAG，以避免在私测前改变 resolver 语义。
- Ruleset 所有引用字段按节点类型显示合法的来源选项；`PARTITION.by` 是文本，`SELECT.by` 是 `GROUP_MAP` 引用。
- 常用 Ruleset binding 用结构化表单编辑；高级 JSON 作为明确折叠的诊断/高级入口保留。
- Questionnaire 的单选、多选、下拉、文件题都能从普通 UI 新增和编辑；选择题支持增删改选项，文件题支持用途、扩展名和大小上限等受 schema 约束的字段。
- Questionnaire 条件编辑使用已有 forward-only 条件 authority；移动问题时寻找合法位置或在操作前禁用并说明原因，不能提交后才显示 schema exception。
- 高级 JSON 仍必须经过完整 schema 校验；结构化表单不能静默破坏条件、选项或文件策略。

### 4. Activity context and navigation

- 后台页面逐步采用“当前活动工作区”语义。选择活动后，选手、Rubric、投票候选、轮次和奖项候选只来自该活动。
- 后端的 `ensure_same_activity`、生命周期检查和 authority service 保留，UI 收窄候选集不能替代后端校验。
- 以下已有功能必须从可见导航可达：现场评委控制、人工观众分、评分标准、新建轮次、用户管理、解归档。
- 首页、活动详情、轮次列表和导出中心的入口文案必须与实际目标 URL 一致，不能只写“现场控制”却没有入口。

### 5. Operator-friendly forms

- 轮次分组使用选手选择/分组控件，不要求工作人员手写 SingerRegistration ID 或 JSON。
- 人工出场顺序使用按选手姓名展示的排序控件或上移/下移操作，不要求填写数据库 ID。
- Rubric 使用评分项名称/满分的重复字段编辑器，服务层继续校验总分、名称、锁定状态和活动归属。
- Round、Vote session、Farewell 等表单验证失败时保留已提交字段和候选选择。
- 常见内部枚举显示业务中文，隐藏数据库 ID、`VOTE_SCORE_COMPONENT_RAW`、`VoteScoringRule id` 等仅供开发者理解的术语；必要的高级诊断信息放在可折叠区域。
- Staff 表单的 label 与 input/select/textarea 建立稳定 `for`/`id` 关联；删除、停用、重置、角色变化等高风险操作必须二次确认。
- 成功/失败消息只由统一 base layout 渲染一次。

### 6. Fresh installation

- 容器启动顺序保持：等待数据库 → migrate → 幂等 ensure 内置 Ruleset templates → collectstatic → Gunicorn。
- 初始化必须可重复执行，不覆盖用户自定义模板，不产生重复 builtin rows，不改变现有冻结版本。
- 首次管理员从 Web 进入后，模板库应立即可用；不要求用户进入容器执行 management command。
- 管理命令继续保留作为受控恢复/离线 bootstrap 路径。
- 启动失败时 `start-event.ps1` 保留 Compose 原始 stderr，并附带 `compose ps` 和 web/db 最近日志的有限尾部；不得输出环境变量或密钥。

## 实现分批

### Batch 2-A：确定性死路与初始化

修复单/多选/文件题新增、阶段合法选项、归档入口与锁定/归档 affordance、Activity 类型不可变、重复消息、内置模板启动初始化、event 启动错误诊断。每个问题必须有最小失败测试和页面/服务回归测试。

### Batch 2-B：可见导航与活动上下文

补齐现场控制、观众分、Rubric、用户管理、解归档入口；将 Round/Vote/Award/Rubric 表单的候选对象绑定到当前活动，并保留跨活动伪造 POST 的拒绝测试。

### Batch 2-C：结构化配置与合法移动

完成 Questionnaire 选项/文件题/条件编辑和合法移动；完成分组、出场顺序、Rubric 编辑器；完成 Ruleset binding 常用字段结构化编辑；移除直接 Manual Award 创建，并把人工纠偏入口明确导向冻结 Ruleset 的人工决策→重新解析→核定链。页面不得承诺不存在的“手工发任意奖项”能力。

### Batch 2-D：表单保留、可访问性与验收

统一 bound form 重渲染、label 关联、中文业务状态、确认和移动布局；增加 fresh Admin 可见导航 Playwright journey，至少覆盖桌面和 375px 手机视口。

## 安全与数据约束

- 不新增绕过 `authority_write`、活动锁、轮次锁、投票锁、StageResult confirm 或私有文件访问的快捷写入。
- 不使用 `QuerySet.update()`/裸 ORM 写入替代既有 service。
- 所有跨活动候选过滤必须同时由后端 service 再验证。
- 不把 Access Key、session token、上传内容或完整环境变量写入日志/测试 artifact。
- 不删除历史 migration，不直接删除生产/测试数据库数据；只新增必要 migration。
- 禁止以任意手填奖项名称直接创建正式 Award；正式 Award authority 必须始终保持“冻结 Ruleset resolver → StageAwardDecision → CONFIRMED StageResult → Award materialization”。

## 验收标准

### 自动化

- 新增回归测试覆盖本 spec 中每个确定性 bug，且测试先红后绿。
- `uv run python manage.py check`
- `uv run python manage.py makemigrations --check --dry-run`
- `uv run ruff check .`
- `npm run check:pyright`
- `npm run check:pyright:entry-access`
- `npm run check:css`
- 相关 Django app tests、client tests、Playwright human acceptance journey 全部通过。

### 人工任务

在 fresh 数据库中，仅通过页面可见入口完成：

1. 首次管理员登录并看到内置赛制模板；
2. 创建活动并确认从草稿开始；
3. 配置问卷（含单选、多选、文件题）并预览；
4. 配置赛制、轮次、分组、人工顺序和评分标准；
5. 从轮次进入评委现场控制；
6. 创建活动范围内的观众投票并录入观众分；
7. 进入结果/归档页面，并对归档活动完成解归档；
8. 尝试跨活动伪造候选 ID，页面/服务拒绝且不写入错误数据；
9. 使用包含 `MANUAL_SELECT` 与已声明 `AWARD` 节点的冻结 Ruleset 做人工决策，重新解析并核定结果；确认 Award 只能从该已确认结果及其候选物化。若规则未声明可产出该奖项的 `AWARD` 节点，页面必须明确提示不能直接手工发奖，且不得写入 Award。

## 明确不在本批次的事项

- 不引入多租户、SSO、MFA、复杂邀请系统或新的商业授权模型。
- 不在本批次改变 resolver 的评分数学、投票量纲、StageResult fingerprint 或锁定模型。
- 不进行完整的 `display_order` 与 execution DAG 分离；当前 forward-only 方案继续作为安全兼容实现，待私测数据和问卷/赛制模型稳定后另立架构项目。
- 不把高级 JSON 完全删除；它保留为受控、可折叠的诊断入口。
