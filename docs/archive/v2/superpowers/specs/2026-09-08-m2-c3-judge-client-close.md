# M2-C3 Judge Client Close

状态：设计已确认，待实现

## 目标

闭合评委端从“能打开并提交总分”到“现场可持续使用且不会错人、丢分或绕过 authority”的最小完整闭环：

1. 评委始终看到当前轮次、表演、选手和曲目；
2. 输入后立即形成本地可恢复草稿，断网或刷新不丢失已输入内容；
3. 客户端通过短轮询感知 Staff 切换、HOLD 和上下文版本变化；
4. stale context 恢复时保留旧草稿但不自动套用到新表演；
5. 有 rubric 的轮次使用完整分项评分，服务端计算并写入权威总分；
6. 所有 direct judge、Staff proxy 和 paper DR 写入仍由同一套 authority、幂等和 provenance 约束保护。

本阶段不引入 WebSocket、学校 SSO/MFA、客户端选择评分目标或新的评分算法。

## 权威边界

- `PerformanceRunState` 的当前表演、状态和 `context_version` 仍只能由现有现场 authority service 修改；Judge client 只读取并提交 expected values。
- `JudgeContext` 由 bearer session 推导 activity、round、seat、panel、当前 performance 和 rubric；请求体不能指定 singer、judge、seat、round、activity、source 或 panel。
- `submit_judge_score()` 仍是 direct judge 唯一写入口；服务端锁定 run state、session、panel snapshot 和 seat 后再校验上下文与重复事实。
- `submit_staff_proxy_score()` 和 `submit_paper_score()` 复用同一评分 payload 规范和分项 materialization 逻辑；不得因为降级来源绕过 rubric 或 criterion 绑定。
- `ScoreRecord` 是总分原始事实，`CriterionScore` 是同一评分命令产生的分项原始事实；两者及 `JudgeScoreReceipt` 必须在一个事务中成功或全部回滚。
- 有 rubric 的轮次不接受仅有 `score` 的总分 payload；无 rubric 的历史轮次继续接受总分 payload。
- rubric 的所有 `max_score` 总和必须为 100，作为当前 `ScoreRecord.score` 0–100 语义的明确前置条件。配置不满足时 fail closed，不猜测权重或自动归一化。
- 评分服务只接受当前轮次绑定 rubric 的完整、唯一 criterion 集合，每项值必须在 `0..max_score` 且精度不超过两位小数；总分由服务端计算，不信任客户端传入的 total。
- 已有评分事实、分项事实和成功 receipt 不因客户端重试而更新；相同 command 和完全相同 payload 幂等返回原 receipt，command 绑定不同 payload 时返回 `IDEMPOTENCY_CONFLICT`。

## JudgeContext API 契约

成功响应仍为 `{"context": ...}`，并保持 `Cache-Control: no-store`。新增字段只包含评委现场必要展示信息：

```json
{
  "activity_id": 1,
  "round_id": 2,
  "round_name": "决赛",
  "seat_id": 3,
  "panel_snapshot_id": 4,
  "panel_version": 1,
  "context_version": 5,
  "performance_id": 6,
  "performance_label": "第 6 个节目",
  "singer_name": "参赛者姓名",
  "song_title": "演出曲目",
  "performance_state": "performing",
  "rubric_payload": {
    "name": "决赛评分表",
    "criteria": [
      {
        "criterion_id": 12,
        "name": "音准",
        "description": "",
        "max_score": "40.00",
        "sequence": 1
      }
    ]
  }
}
```

`performance_id` 可以为 `null`；对应展示字段也必须安全地为空。不得返回学号、班级、手机号、临时 token 或不参与评分的个人资料。客户端只能把这些字段作为展示和当前上下文指纹使用。

## 评分 payload 契约

无 rubric 的兼容模式：

```json
{
  "score": "91.50",
  "notes": ""
}
```

有 rubric 的正式模式：

```json
{
  "criteria": [
    {"criterion_id": 12, "value": "36.00"},
    {"criterion_id": 13, "value": "42.50"}
  ],
  "notes": ""
}
```

服务端规范化后将 criterion 按绑定 rubric 的顺序处理，计算 `sum(value)` 作为 `ScoreRecord.score`。客户端不得通过额外字段覆盖该值；未知字段、缺项、重复 criterion、跨 rubric criterion、负数、超过上限、非有限值和非法小数精度全部拒绝。

payload hash 必须覆盖规范化后的完整分项内容、备注、来源、panel、seat、performance 和 context version，避免同一 command 的分项内容被替换。

## 客户端草稿与上下文

- 输入监听在 200ms debounce 后落盘；首次有效上下文中的输入立即创建稳定 `command_id`。
- 草稿只含 schema version、command ID、上下文指纹、评分文本、criterion 文本值和备注；不保存 bearer、URL fragment、完整上下文、token 或额外个人信息。
- localStorage 使用有上限的按指纹草稿集合。指纹至少包含 activity、round、seat、panel snapshot/version、context version 和 performance ID。
- 草稿可以保存空字符串或用户输入中的临时文本；只有提交时才执行严格的数值与完整性校验。
- 当前上下文变化时，旧草稿继续保存在旧指纹下，当前输入区清空或切换为新上下文，绝不自动把旧分数提交给新选手。界面明确提示“旧草稿已保留，未套用到当前表演”。
- 上下文成功加载后每 2 秒轮询一次；请求不得重叠，连续失败采用有限退避。401 结束当前会话并显示通用会话失效提示，其他失败保留当前输入和草稿。
- 收到 `STALE_CONTEXT` 时立即刷新上下文；刷新前后都不改变服务端 authority，也不自动重定向评分目标。
- performance 为空、状态为 HOLD 或状态不可评分时，评分输入和提交按钮不可用；客户端状态只是体验层，服务端仍必须重复校验。

## 页面展示

Judge terminal 使用安全 DOM 更新显示：

- 当前轮次和表演编号；
- 选手姓名和曲目；
- 当前 `performance_state`、HOLD 提示和 `context_version`；
- rubric 名称、每项描述、最高分、输入值和只读合计；
- 备注、草稿保存状态和 stale recovery 提示。

不使用不可信字符串拼接 HTML。页面刷新、重复点击、断网和恢复均不能泄露 session token 或产生第二个评分命令。

## 测试要求

### Authority / Django

- context 返回展示字段、criterion ID 和最小数据范围；无 token、错误 token、跨 origin 和过期 session 仍使用通用错误。
- rubric 总分上限不为 100 时拒绝评分且无部分写入；有 rubric 时总分-only 被拒绝。
- criterion 缺失、重复、越界、非法精度、跨 rubric、未知字段和伪造 total 均拒绝。
- 成功分项提交同时产生正确 `ScoreRecord`、完整 `CriterionScore`、source/panel/seat provenance、receipt 和审计；任何一个写入失败均回滚。
- direct judge、STAFF_PROXY、PAPER_DR 共享分项规范；重复 command 幂等，变更 payload 返回冲突，已有事实拒绝重复提交。
- stale context、HOLD、panel 变化、无当前表演、跨轮次 performance 和错误 seat 均 fail closed。

### TypeScript client

- 输入后未点击提交也能保存有界草稿；草稿不含 session token、URL fragment、选手隐私扩展字段或 rubric 秘密。
- 评分项渲染和总分显示只来自当前 context；上下文变化后旧草稿隔离且不误填新表演。
- polling 能更新当前表演、HOLD 和状态；请求不会重叠，stale 后会恢复。
- 断网重试复用原 command ID；成功 receipt 清除对应草稿；重复点击不能制造新 command。
- 旧的无 rubric 总分模式和新的 rubric 分项模式均产生正确请求体。

### 端到端与门禁

- Playwright 保持 read-only smoke，并增加可用的 Judge terminal context/状态展示检查；不在浏览器测试中记录 bearer。
- 运行 Django、迁移、Pyright 双门禁、Ruff、client build/test、CSS、文档检查和 PostgreSQL focused authority 测试。
- 完成两轮自审：第一轮检查契约、authority 和目标绑定；第二轮检查错误处理、并发幂等、隐私泄露、类型和生成产物一致性。

## 不在本阶段

- WebSocket 或服务端推送；
- 学校 SSO、MFA、教师身份目录和正式个人信息映射；
- 评分权重、去极值、异常分检测等新赛制算法；
- Judge client 自行选择表演或切换评委席位；
- 评分事实的修改、覆盖或撤销 UI。

