# 赛后反馈设计（Phase 4）

状态：实施中（2026-11-18）
范围：闭幕后公开反馈表单 + Ops 反馈卡
前序：`docs/artflow-plus/specs/2026-11-18-public-discovery-design.md`

## 1. 目标

活动闭幕后，参与者/观众可以在公开活动页提交 1–5 分评分与可选文字反馈；主办方在
Ops 活动页看到条数、平均分与最近反馈。反馈是不可修改的追加事实，不收集联系方式。

## 2. 非目标

- 不做登录门槛、抽奖、回复或邮件通知。
- 不收集姓名、学号、联系方式或 IP 明文。
- 不做反馈导出（后续可复用受控导出）与趋势分析。
- 不开放活动进行中的反馈；只有 `closed` 可提交。

## 3. 决策

### 3.1 反馈是引擎命令

`activity.feedback.submit` 走现有 `executeCommand`：receipt、audit、事实、outbox 在同一
事务。actor 是合成公共 actor（system、无权限），不引入新 capability 或新权限。
命令校验评分 1–5、备注 ≤1000、活动必须 `closed`；成功后追加
`ActivityFeedbackSubmitted` 事件。

### 3.2 数据

新表 `activity_feedback`：`id`、`activity_id`、`rating`、`comment`、`source`、
`submitted_at`；评分与备注有 DB check 约束；按 `(activity_id, submitted_at)` 建索引。
不存 IP、UA 或任何身份字段。

### 3.3 防滥用

- 公开路由按 IP/活动限流（10 次/分钟）。
- 表单含隐藏的 `website` 蜜罐字段；非空时返回成功但不写库。
- 幂等键由前端生成；重放返回同一结果。
- 前端在 `localStorage` 记录已提交的公开码，避免同一浏览器重复提交；服务端仍以
  限流与幂等为权威。

### 3.4 Ops 读取

`GET /api/activities/:id/feedback` 走 `requireOperationsReader`；返回最近 200 条的
`{ items, summary: { count, average } }`。Ops 活动页新增反馈卡；无权限不渲染。

## 4. 生命周期与可见性

- 只有 `closed` 活动接受提交；`active`/`draft`/`archived` 一律拒绝。
- 已归档活动仍可由 Ops 读取历史反馈（读路径不因归档失效）。
- 反馈是追加事实，不修改活动状态，不触发重算。
- 公开页表单只在 `closed` 时出现；提交成功后本地隐藏，刷新后仍隐藏。
- 反馈不包含可识别信息，公开页不展示任何反馈内容。

## Test architecture

契约：新增反馈表与引擎命令 `activity.feedback.submit`；不新增 capability/permission，
事件 `ActivityFeedbackSubmitted` 只用于审计与 outbox。消费者：公开活动页反馈表单、
Ops 反馈卡、`GET /api/activities/:id/feedback`；不新增 realtime topic。生命周期：仅
closed 接受提交；archived 读取仍可用；幂等重放不重复写；rate limit 与蜜罐不写库。
适配器：无新增；命令与读取用真实 PostgreSQL 测试。故障：重复幂等键返回同一结果；
非法评分/超长备注被拒；active 活动被拒；蜜罐返回成功但不写库；Ops 读取空态。现有
测试不够：没有公开写反馈、Ops 读取、蜜罐与限流覆盖。防臃肿：复用 `executeCommand`
与现有 Ops 路由/卡片模式，不新增 capability、页面或导出；反馈表只追加。门禁：
`check`、db/runtime/api/web 测试、`schema:check`、`graph:check`、`audit:check`、
`build:prod`、结构门禁、`check_docs`、Playwright 的 feedback/onsite/mobile/a11y。

## 5. 实施顺序

1. 迁移 0035 + schema snapshot/types。
2. DB feedback repository。
3. runtime 提交命令与读取。
4. API 公开提交路由 + Ops 读取路由。
5. 公开反馈表单、Ops 反馈卡、路由接线。
6. 测试与门禁。
