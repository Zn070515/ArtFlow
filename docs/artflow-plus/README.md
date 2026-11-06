# ArtFlow-Plus（v2）开发主线

产品与架构身份的权威是根目录 [`GOAL.md`](../../GOAL.md)；本目录与
`docs/architecture/`、`docs/domains/` 都是它的执行材料。

`main` 是唯一开发主线，本工作区位于 `plus/`。1.x Django 源码作为历史证据暂留，
等外部审核与 [v1→v2 覆盖审计](skeleton-coverage.md) 关闭后删除；仓库不再维护双线，
也不再提供 legacy bundle 导入、运营接管、参与者认领或 v1 媒体桥。

## 当前阶段（2026-11-06）

v2 已完成 **M0–M15.2**（含 M13.1–M13.3、票据投票、运营分析与 Tasks），并完成单线化与 v1 兼容层移除；
1.x 的功能覆盖审计已进入执行清单。逐项出口与证据在 [roadmap.md](roadmap.md)。

| 里程碑 | 状态 | 主要交付 |
|---|---|---|
| M0 Legacy Extraction | 已完成 | 54 条不变量、497 条 fix 经验、golden fixtures、结构门禁 |
| M1 Engine Kernel | 已完成 | 薄 Activity、definition/release、scoped execution sessions |
| M2 Capability Composition | 已完成 | registry、Pack、组合诊断、`GATE-PLUS-BOUNDARY-01` |
| M3 Execution Runtime | 已完成 | durable command、outbox/投影/重放、HTTP 恢复 |
| M4 Registration | 已完成 | 报名/问卷/材料 metadata、名单 final/unknown |
| M5 Competition/Evaluation | 已完成 | 轮次/评委组/评分事实/排名/podium candidate |
| M6 Voting/Ticketing | 已完成 | 场次/选票/票据凭证、mode 与 identity policy |
| M7 Publishing/Archive | 已完成 | 结果核定/发布/撤销、归档包与受控下载 |
| M8 Product Surfaces | 已完成 | Studio/Ops/Live/Portal 与三类活动验证 |
| M9 Grouping | 已完成 | `grouping` capability、Ops 三步卡片、归档 |
| M10 Vote-Result Publishing | 已完成 | publishing 解耦 competition、投票赛果确认与百分比公示 |
| M11 Realtime Core + Voting UI | 已完成 | `@artflow-plus/realtime`、实时投票卡片、核心门禁 |
| M12 Participant Vote Page | 已完成 | `/vote/<sessionId>` 公开投票页与二维码 |
| M13 Live on the Realtime Core | 已完成 | `activity:<id>` 失效主题；SSE 与 `useLiveEvents` 退役 |
| M14 Ticket-backed Voting | 已完成 | 票据 fragment、手工兑换与观众投票入口 |
| M15 Operations Analytics | 已完成 | 运营对比分析与审计视图 |
| M16 Tasks Readiness | 已完成 | 版本化任务项、审计命令与 Ops 控制台 |
| v1 兼容移除 | 已完成 | 删除 legacy import/adoption、参与者认领、v1 媒体桥与 v1 golden adapter |

### v2 架构速览

```text
plus/apps/api      Fastify 5 + TypeBox；command/query 路由、cookie+CSRF、/api/realtime
plus/apps/web      React 19 + Vite；Studio / Ops / Live / Portal / /vote/<sessionId>
plus/apps/worker   outbox relay（250ms 循环 + pg-boss 兜底）
plus/packages/domain    Activity、capability registry、compiler、Pack
plus/packages/runtime   command handler、投影、各 capability 服务
plus/packages/db        Kysely schema、module-owned migrations、repository
plus/packages/contracts 共享 TypeBox schema
plus/packages/realtime  受保护的 WebSocket 核心（见 CORE.md）
```

### 已验证的边界

- 单写路径：receipt + audit + fact + outbox 同事务；replay 先于校验。
- Release 不可变：冻结 capability 版本、scopes 与冲突策略。
- 模式隔离：事实/选票/排名/事件/投影按 mode 分区。
- 实时通道只做失效提示；HTTP 是恢复权威；只有 `packages/realtime` 拥有传输。
- 命令只能使用 release 为其冻结的 execution scope；结果绑定来源身份，来源改变即
  stale 并 supersede 旧 release；内部读面在启动期为每个 GET 声明权限（ADR-0030）。
- 公开 selector 自己要求 confirmed/source/stale 检查；runtime contract v2 拒绝
  无 command ownership 的旧 release（ADR-0031）。
- 已关闭的流程缺口：分组、投票结果发布、观众投票页、Live 实时迁移、票据投票；
  M13 之后完成一轮 authority closure（scope、provenance、consumption、read plane）。

### 仍开放的缺口

- 舞台类节目单公开页、bracket/对阵、XLSX/Word 导出、二维码、现场大屏。
- SSO provider；当前使用本地会话。
- 多实例实时广播（Redis）与权限实时撤销。
- 1.x 源码删除：等待外部审核与覆盖审计关闭。

## 文档与规划基线

| 内容 | 位置 |
| --- | --- |
| 产品与架构 GOAL（权威） | [GOAL.md](../../GOAL.md) |
| 目标执行摘要 | [goal.md](goal.md) |
| 里程碑与出口条件 | [roadmap.md](roadmap.md) |
| v1 → v2 功能覆盖审计 | [skeleton-coverage.md](skeleton-coverage.md) |
| 目标架构与模块边界 | [architecture/target](../architecture/target/README.md) |
| 前端视觉方向（Portal / Console 双壳） | [frontend-design-direction.md](frontend-design-direction.md) |
| M7→M13.3 代码 review（high） | [reviews/2026-10-27-m7-m13-high-review.md](reviews/2026-10-27-m7-m13-high-review.md) |
| 架构决策 | [architecture/adr](../architecture/adr/README.md) |
| 领域模型 | [domains](../domains/) |
| 领域不变量（AUTH/LIFE/GRP/CONC/SCOR/RES/TICK/DEPL/RT） | [invariants](../invariants/README.md) |
| 真实事故库 | [incidents](../incidents/) |
| 结构门禁 | [gates](../gates/README.md) |
| Golden fixtures | [tests/golden](../../tests/golden/README.md) |
| 497 条 fix 的经验 | [analysis/fix-lessons.md](analysis/fix-lessons.md) |
| v2 架构优势与警惕债务 | [analysis/2026-10-28-v2-architecture-advantages-and-watchpoints.md](analysis/2026-10-28-v2-architecture-advantages-and-watchpoints.md) |
| P0 安全基线还账计划 | [plans/2026-10-28-security-baseline-debt.md](plans/2026-10-28-security-baseline-debt.md) |
| 重构前待决问题 | [open-questions.md](open-questions.md) |
| PR 审查清单 | [review-checklist.md](review-checklist.md) |

## 历史证据如何保留

1.x 的实现细节不再向 `main` 回灌。历史 bug、业务不变量与部署事故已经沉淀为：

- `docs/domains/` 的领域模型；
- `docs/invariants/` 的 54 条不变量；
- `tests/golden/` 的实现无关样例；
- `docs/incidents/` 的真实事故与根因。

新的 v2 行为从这些契约出发实现，而不是从旧代码生长。

## 分支纪律

- 临时分支：`feat/*`、`fix/*`、`research/*`、`docs/*`，从 `main` 切出，短生命周期。
- 版本 tag 只从 `main` 打；`v*` tag 是发布权威，普通 push 不构建镜像。
