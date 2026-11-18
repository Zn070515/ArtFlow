# ArtFlow-Plus（v2）开发主线

产品与架构身份的权威是根目录 [`GOAL.md`](../../GOAL.md)；本目录与
`docs/architecture/`、`docs/domains/` 都是它的执行材料。

`main` 是唯一开发主线，本工作区位于 `plus/`。1.x Django 源码已从 `main` 删除，
完整源码保存在 tag `v1.0.2`，功能记录见 [`docs/archive/v1/`](../archive/v1/README.md)。
仓库不再维护双线，也不再提供 legacy bundle 导入、运营接管、参与者认领或 v1 媒体桥。

## 当前阶段（2026-11-14）

v2 已完成 **M0–M15.5**（含 M13.1–M13.3、票据投票、运营分析、Tasks、签到、排期与事故恢复），并完成单线化与 v1 兼容层移除；
1.x 的功能覆盖审计已关闭（2026-11-06，M15 后补齐）。逐项出口与证据在 [roadmap.md](roadmap.md)。

工程质量线（契约测试、Consumer Graph、缺口棘轮、变异审计、L3 模型测试与 L4
Journey runner）同样在 `main` 上持续推进；契约工具只用于开发/CI，不进入运行时
镜像依赖闭包。

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
| M12 Participant Vote Page | 已完成 | `/vote/<sessionId>` 公开投票页与投票页二维码 |
| M13 Live on the Realtime Core | 已完成 | `activity:<id>` 失效主题；SSE 与 `useLiveEvents` 退役 |
| M14 Ticket-backed Voting | 已完成 | 票据 fragment、手工兑换与观众投票入口 |
| M15.1 Operations Analytics | 已完成 | 运营对比分析与审计视图 |
| M15.2 Tasks Readiness | 已完成 | 版本化任务项、审计命令与 Ops 控制台 |
| M15.3 Attendance | 已完成 | 统一签到（participant/ticket/staff）、签到点与 staff roster、Ops/Live 到场视图 |
| M15.4 Schedule / Program Release | 已完成 | schedule capability、Ops/Live 排期、公开节目单快照、Studio 排期编辑器 |
| M15.5 Incident / Recovery | 已完成 | incident capability、Ops 事故卡、Live 未解决事故摘要、reopen 审计 |
| v1 兼容移除 | 已完成 | 删除 legacy import/adoption、参与者认领、v1 媒体桥与 v1 golden adapter |

### v2 架构速览

```text
plus/apps/api      Fastify 5 + TypeBox；app.ts 只做组合，路由在 src/routes/<surface>.ts
plus/apps/api/src/routes  system/auth/public/activity/tasks/registration/grouping/competition/voting/archive/publishing/attendance/exports/incident/schedule
plus/apps/web      React 19 + Vite；Studio / Ops / Live / Portal / /vote/<sessionId> / /program/<publicCode>
plus/apps/worker   outbox relay（250ms 循环 + pg-boss 兜底）
plus/packages/domain    Activity、capability registry、compiler、Pack
plus/packages/runtime   command handler、投影、各 capability 服务（含 schedule/incident）
plus/packages/db        Kysely schema、module-owned migrations、repository
plus/packages/contracts 共享 TypeBox schema
plus/packages/realtime  受保护的 WebSocket 核心（见 CORE.md）
```

公开面（活动目录、公开活动站、投票/电子票、嵌入 widget）的读取端点、限流与嵌入方式见
[public-api.md](public-api.md)。

### 已验证的边界

- 单写路径：receipt + audit + fact + outbox 同事务；replay 先于校验。
- 授权以账号当前状态为准：会话只证明认证；降权、停用、删除在下一次请求生效；
  `account.manage` 收口账号管理（ADR-0042）。
- 活动复制只复制能力组合与当前草稿；发布、报名、评分、会话与结果不被复制。
- 员工开户支持邀请：管理员只生成一次性令牌，原始令牌不落库；员工通过
  `/claim#<token>` 自设 12 位以上密码后账号才激活。
- Release 不可变：冻结 capability 版本、scopes 与冲突策略。
- 模式隔离：事实/选票/排名/事件/投影按 mode 分区。
- 实时通道只做失效提示；HTTP 是恢复权威；只有 `packages/realtime` 拥有传输。
- 命令只能使用 release 为其冻结的 execution scope；结果绑定来源身份，来源改变即
  stale 并 supersede 旧 release；内部读面在启动期为每个 GET 声明权限（ADR-0030）。
- 公开 selector 自己要求 confirmed/source/stale 检查；runtime contract v2 拒绝
  无 command ownership 的旧 release（ADR-0031）。
- 已关闭的流程缺口：分组、投票结果发布、观众投票页、Live 实时迁移、票据投票、
  运营分析、Tasks、签到、排期/公开节目单、事故恢复；
  M13 之后完成一轮 authority closure（scope、provenance、consumption、read plane）。

### 仍开放的缺口

- bracket/对阵、活动报名/结果的通用二维码、现场大屏。
- 具体 IdP 的端到端验证；通用 OIDC 适配器已实现，但仍需要真实 issuer 与账号
  映射策略。
- 具体 S3 供应商与 bucket 的生命周期/跨区复制证据；应用侧 S3 驱动已实现。
- Compose 权威拓扑仍是单节点；多副本与 PITR 是 k8s reference。

2026-11-18 已完成两轮交付加固：

- 现场运行：公共限流改为按浏览器 visitor 计数并保留写请求的每 IP 上限；
  资料上限统一为 600 MiB 且上传/下载流式化、支持 Range；ballot 不再锁整个
  activity；归档 ZIP 异步化；投影 retry/rebuild 进入 Ops；生产启用日志与
  `/metrics`；会话滑动续期；备份默认不冻结写入。详见
  [ADR-0043](../architecture/adr/0043-runtime-blocker-hardening.md)。
- 交付与身份：S3 共享存储、2 副本 HA overlay、CloudNativePG/PITR 参考；
  TOTP + 通用 OIDC；SMTP 密码找回；手动 release readiness。详见
  [ADR-0044](../architecture/adr/0044-ha-identity-and-recovery.md)。

## 文档与规划基线

| 内容 | 位置 |
| --- | --- |
| 产品与架构 GOAL（权威） | [GOAL.md](../../GOAL.md) |
| 目标执行摘要 | [goal.md](goal.md) |
| 里程碑与出口条件 | [roadmap.md](roadmap.md) |
| v1 → v2 功能覆盖审计 | [skeleton-coverage.md](skeleton-coverage.md) |
| 目标架构与模块边界 | [architecture/target](../architecture/target/README.md) |
| 前端视觉方向（Portal / Console 双壳） | [frontend-design-direction.md](frontend-design-direction.md) |
| M7→M13.3 代码 review（high，归档） | [reviews/2026-10-27-m7-m13-high-review.md](../archive/v2/reviews/2026-10-27-m7-m13-high-review.md) |
| 架构决策 | [architecture/adr](../architecture/adr/README.md) |
| 契约测试与消费者故障注入任务书 | [specs/2026-11-11-contract-testing-program-design.md](specs/2026-11-11-contract-testing-program-design.md) |
| 契约测试现状审核（P0，归档） | [analysis/2026-11-11-contract-testing-audit.md](../archive/v2/analysis/2026-11-11-contract-testing-audit.md) |
| 契约测试实施计划（归档） | [plans/2026-11-11-contract-testing-plan.md](../archive/v2/plans/2026-11-11-contract-testing-plan.md) |
| 外部审核驱动的测试体系加固（归档） | [analysis/2026-11-11-external-review-test-hardening.md](../archive/v2/analysis/2026-11-11-external-review-test-hardening.md) |
| 自审计测试体系设计 | [specs/2026-11-11-self-auditing-test-system-design.md](specs/2026-11-11-self-auditing-test-system-design.md) |
| 现场降级设计（沿用 v1） | [specs/2026-11-14-onsite-degradation-design.md](specs/2026-11-14-onsite-degradation-design.md) |
| 变异审计结果（归档） | [analysis/2026-11-11-mutation-audit-findings.md](../archive/v2/analysis/2026-11-11-mutation-audit-findings.md) |
| 工程加固（拆分、L3/L4、DB 生成链、文档口径，归档） | [plans/2026-11-12-engineering-hardening.md](../archive/v2/plans/2026-11-12-engineering-hardening.md) |
| 文档口径审计（归档） | [analysis/2026-11-12-documentation-consistency.md](../archive/v2/analysis/2026-11-12-documentation-consistency.md) |
| Journey spec 目录 | [tools/contracts/journeys](../../plus/tools/contracts/journeys/) |
| 领域模型 | [domains](../domains/) |
| 领域不变量（AUTH/LIFE/GRP/CONC/SCOR/RES/TICK/DEPL/RT/ATT） | [invariants](../invariants/README.md) |
| 真实事故库 | [incidents](../incidents/) |
| 结构门禁 | [gates](../gates/README.md) |
| Golden fixtures | [tests/golden](../../tests/golden/README.md) |
| 497 条 fix 的经验 | [analysis/fix-lessons.md](analysis/fix-lessons.md) |
| v2 架构优势与警惕债务（归档） | [analysis/2026-10-28-v2-architecture-advantages-and-watchpoints.md](../archive/v2/analysis/2026-10-28-v2-architecture-advantages-and-watchpoints.md) |
| P0 安全基线还账计划（归档） | [plans/2026-10-28-security-baseline-debt.md](../archive/v2/plans/2026-10-28-security-baseline-debt.md) |
| 已完成里程碑归档（计划、设计、审计、评审） | [archive/v2](../archive/v2/README.md) |
| 重构前待决问题 | [open-questions.md](open-questions.md) |
| PR 审查清单 | [review-checklist.md](review-checklist.md) |

## 历史证据如何保留

1.x 的实现细节不再向 `main` 回灌。历史 bug、业务不变量与部署事故已经沉淀为：

- `docs/domains/` 的领域模型；
- `docs/invariants/` 的 81 条不变量（54 条 v1 提炼 + 后续补充）；
- `tests/golden/` 的实现无关样例；
- `docs/incidents/` 的真实事故与根因。

新的 v2 行为从这些契约出发实现，而不是从旧代码生长。

## 分支纪律

- 临时分支：`feat/*`、`fix/*`、`research/*`、`docs/*`，从 `main` 切出，短生命周期。
- 版本 tag 只从 `main` 打；`v*` tag 是发布权威，普通 push 不构建镜像。
