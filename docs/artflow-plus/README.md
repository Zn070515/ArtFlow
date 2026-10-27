# ArtFlow-Plus（v2）开发主线

产品与架构身份的权威是根目录 [`GOAL.md`](../../GOAL.md)；本目录与
`docs/architecture/`、`docs/domains/` 都是它的执行材料。

本分支从 `v1.0.0` 的发布提交 `80bdc95843678be99fe24c877b0b6164f6147d83` 切出。
`v1.0.0` 的应用基线是 `a98dcc80525ab5de0c539b73d93382ebc5b2bfa4`；发布提交只多了
`.github/workflows/publish.yml`。

## 两条时代线

| 分支 | 角色 | 允许的改动 |
| --- | --- | --- |
| `main` | ArtFlow 1.x 生产维护线 | 真实彩排/现场发现的问题、部署问题、P0–P2 正确性、必要的现场 UX 修复，以及对应的回归测试 |
| `artflow-plus` | ArtFlow-Plus（v2）开发主线 | 新领域模型、新前后端架构、技术栈现代化；可以大规模重构 |

- `main` 已发布到 **v1.0.2**（2026-10-19），不再接受“顺便优化”和 opportunistic refactor。
- 已发布的 tag 永不移动。后续生产修复走 `hotfix/*` → `main` → 验证 → 下一个补丁号
  （`v1.0.3`），由 `publish.yml` 自动发布新镜像。
- `release/1.x` 暂不单独创建：在 `main` 仍是 1.x 生产线期间它与 `main` 重复；
  等 Plus 准备接管 `main` 时再从当时的 1.x 末端切出长期维护分支。

## 当前阶段（2026-10-27）

`artflow-plus` 上的 v2 已完成 **M0–M13.2**；`main` 仍是 1.x 生产线，**生产 cutover
尚未执行**。切换拓扑与工具链已就绪，历史导入与运营接管已分开；正式切换仍取决于
首个活动走完 adoption 彩排、capability 完整度与 authority 审计，而不是日期。
逐项出口与证据在 [roadmap.md](roadmap.md)。

| 里程碑 | 状态 | 主要交付 |
|---|---|---|
| M0 Legacy Extraction | 已完成 | 54 条不变量、497 条 fix 经验、golden fixtures、结构门禁 |
| M1 Engine Kernel | 已完成 | 薄 Activity、definition/release、scoped execution sessions |
| M2 Capability Composition | 已完成 | registry、Pack、组合诊断、`GATE-PLUS-BOUNDARY-01` |
| M3 Execution Runtime | 已完成 | durable command、outbox/投影/重放、SSE + HTTP 恢复（SSE 后由 M13 退役） |
| M4 Registration | 已完成 | 报名/问卷/材料 metadata、名单 final/unknown、legacy 报名导入 |
| M5 Competition/Evaluation | 已完成 | 轮次/评委组/评分事实/排名/podium candidate |
| M6 Voting/Ticketing | 已完成 | 场次/选票/票据凭证、mode 与 identity policy |
| M7 Publishing/Archive | 已完成 | 结果核定/发布/撤销、归档包与受控下载 |
| M8 Product Surfaces & Cutover | 已完成 | Studio/Ops/Live/Portal、v1 导入、cutover 拓扑与三类活动验证 |
| M9 Grouping | 已完成 | `grouping` capability、Ops 三步卡片、归档与 legacy 导入 |
| M10 Vote-Result Publishing | 已完成 | publishing 解耦 competition、投票赛果确认与百分比公示 |
| M11 Realtime Core + Voting UI | 已完成 | `@artflow-plus/realtime`、实时投票卡片、核心门禁 |
| M12 Participant Vote Page | 已完成 | `/vote/<sessionId>` 公开投票页与二维码 |
| M13 Live on the Realtime Core | 已完成 | `activity:<id>` 失效主题；SSE 与 `useLiveEvents` 退役 |
| M13.1 Cutover Adoption & Consumption | 已完成 | `--mode adoption` 生成真实 Release；来源级消费；公开 selector fail-closed；runtime contract v2；smoke 双 profile |
| M13.2 Semantic Adoption Closure | 已完成 | Adoption Definition 来自 bundle；canonical round id；registration lifecycle；媒体桥；语义 readiness；来源 refs |

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
- 历史导入与运营接管分开：`--mode adoption` 走正常 Pack → Compiler → Release；
  消费按来源交集计算；公开 selector 自己要求 confirmed/source/stale 检查；
  runtime contract v2 拒绝无 command ownership 的旧 release（ADR-0031）。
- 已关闭的流程缺口：分组、投票结果发布、观众投票页、Live 实时迁移；M13 之后完成
  一轮 authority closure（scope、provenance、consumption、read plane）。

### 仍开放的缺口

- 票据场次的投票入口（当前页面明确阻断）。
- 参与者账号认领/迁移（legacy 导入的报名没有登录账号）。
- 舞台类节目单公开页、bracket/对阵、XLSX 导出、现场大屏。
- 多实例实时广播（Redis）与权限实时撤销。
- 生产 cutover：代码与 runbook 就绪，待执行。

## 文档与规划基线

| 内容 | 位置 |
| --- | --- |
| 产品与架构 GOAL（权威） | [GOAL.md](../../GOAL.md) |
| 目标执行摘要 | [goal.md](goal.md) |
| 里程碑与出口条件 | [roadmap.md](roadmap.md) |
| 目标架构与模块边界 | [architecture/target](../architecture/target/README.md) |
| 架构决策 | [architecture/adr](../architecture/adr/README.md) |
| 领域模型 | [domains](../domains/) |
| 领域不变量（AUTH/LIFE/GRP/CONC/SCOR/RES/TICK/DEPL/RT） | [invariants](../invariants/README.md) |
| 真实事故库 | [incidents](../incidents/) |
| 结构门禁 | [gates](../gates/README.md) |
| Golden fixtures | [tests/golden](../../tests/golden/README.md) |
| 497 条 fix 的经验 | [analysis/fix-lessons.md](analysis/fix-lessons.md) |
| 重构前待决问题 | [open-questions.md](open-questions.md) |
| PR 审查清单 | [review-checklist.md](review-checklist.md) |

## 修复如何向前传播

不要机械 merge `main` → `artflow-plus`。按事故性质分三类：

1. **实现 bug**（Django view/模板/ORM 的局部问题）：只修 `main`。Plus 若已换实现，
   不 cherry-pick 旧代码。
2. **业务不变量**（例如“一位评委对一名选手一轮只能有一个正式 score fact”、
   “结果修改后旧公示必须立即失效”）：v1 修代码并加回归；同时把规则提炼成 Plus 的
   domain spec / Golden fixture / contract test，用新架构重新实现。
3. **部署事故**（例如持久化 `STATIC_ROOT` 让旧 JS 覆盖新镜像）：把事故提炼成部署
   不变量（“部署的新版本必须能证明客户端产物与服务器版本一致”），不要求搬运旧实现。

## M0：Legacy Extraction（已完成）

M0 不写 React，也不删旧代码。目标是把 v1 的真实业务知识变成新架构可以依赖的资产：

```text
docs/
├── domains/       # activity / registration / evaluation / voting / tickets / results / archive
├── invariants/    # authority / concurrency / lifecycle
├── incidents/     # 真实事故与根因，例如 stale-static-assets、duplicate-score-fact
└── architecture/
    ├── adr/       # v1 的关键决策，标注仍适用 / 被 Plus 取代
    └── target/    # Plus 目标架构
tests/golden/      # 从 v1 提炼的可重复业务样例
```

第一条新实现从一个很小的 vertical slice 开始：

```text
Activity（thin）
  → Definition Package Draft（manifest + capability definitions + bindings）
  → 每个 capability 的 compiler + Activity 协调
  → 不可变 Definition Release
  → scoped Execution Sessions（scope + mode，可并行/声明冲突）
```

完整跑通之后再逐步迁移 Registration、Competition/Evaluation、Voting/Ticketing、
Publishing/Results/Archive，并用三个结构不同的活动验证抽象。

## 分支纪律

- 临时分支：`feat/*`、`fix/*`、`research/*`，从 `artflow-plus` 切出，短生命周期。
- 生产修复：`hotfix/*`，从 `main` 切出；只允许最小修复和测试。
- 版本 tag 只从 `main` 打；`v*` tag 是发布权威，普通 push 不构建镜像。
