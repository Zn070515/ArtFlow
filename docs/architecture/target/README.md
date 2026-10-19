# ArtFlow-Plus 目标架构

状态：规划基线（2026-10-19）。产品与架构身份的权威是根目录 `GOAL.md`；本文
只把它的结构落成模块、所有权与运行流程。技术选型见 `docs/architecture/adr/`。

## 产品面与内核

```text
Studio  ── design
Ops     ── prepare / operate
Live    ── execute on site
Portal  ── participate / access
              │
        ArtFlow Engine
   Activity · Capability · Definition · Compile · Release
   Command · Authority · Execution Session · Fact · Decision
   Snapshot · Audit · Projection · Recovery
              │
        Platform
   identity · capability credentials · storage · worker
   realtime transport · observability · backup · diagnostics
```

四个产品面共享同一个 Activity 与 Capability 模型；任何面都不得自行解释权威
业务事实。Engine 不是用户界面；Platform 只提供机制，不决定比赛结果。

## 核心概念

| 概念 | 归属 | 说明 |
| --- | --- | --- |
| Activity | Engine（thin） | 身份、标题、owner、粗生命周期、启用的 capabilities、当前 definition release、公共身份 |
| Capability | 领域单元 | 一组内聚业务能力（Registration、Evaluation、Voting…），拥有自己的事实、命令、查询、事件与定义语言 |
| Activity Pack | 组合 | 一组 opinionated 的 capability + 默认值 + 引导；不是 Activity 子类 |
| Definition Package | Engine/各 capability | manifest + 启用的 capabilities + 各 capability 定义 + policies + bindings + 兼容信息 |
| Definition Draft | Studio | 唯一可编辑配置面；允许不完整与 UNKNOWN |
| Compile | 各 capability + Activity 协调 | 每个 capability 有自己的编译器；Activity 编译器协调并验证跨 capability 绑定 |
| Definition Release | Engine | 不可变的执行权威；正式执行只能绑定 release，不能绑定 draft |
| Execution Session | Engine | 绑定 activity + release + scope + mode；一个 activity 可以有多个并行 scope |
| Fact / Decision / Snapshot / Projection | Engine | 发生的事实 / 由规则得出的结论 / 权威边界上的不可变表示 / 可重建的读模型 |

## Activity 生命周期

```text
DRAFT → ACTIVE → CLOSED → ARCHIVED
```

Activity 只拥有粗生命周期。各 capability 拥有更丰富的生命周期，例如：

```text
Registration: DRAFT → OPEN → REVIEW → FINAL
Competition:  PREPARING → READY → RUNNING → CLOSED
Voting:       DRAFT → OPEN → CLOSED
Publishing:   PRIVATE → READY → RELEASED → REVOKED
```

不得把本质并行的运营过程压进一个全局线性阶段。capability 自己声明哪些 scope
冲突、哪些可以同时运行。

## Capability 列表（初始）

Registration、Questionnaire、Materials、Participant Directory、Program
Management、Competition、Evaluation、Scheduling、Tasks、Resources、Rehearsal、
Ticketing、Check-in、Voting、Publishing、Results、Archive、Incident Management。

每个 capability 必须声明：

- identity/version、依赖、冲突；
- definition contract、compile 诊断；
- commands、queries、events；
- permissions；
- 四个产品面上的贡献；
- migration requirements。

Capability 不是页面、菜单、表或服务；它是内聚的业务能力。

## 依赖规则

1. 每个权威事实只有一个 owning capability。
2. capability 之间只能通过公开 contract（命令/查询/不可变事件/稳定 ID/
   显式 binding）交互；**禁止直接读写其他 capability 的表**。
3. `Platform` 不依赖业务 capability；capability 可以依赖 Platform。
4. Engine 不硬编码具体 capability 的 scope 名称；冲突策略由组合提供。
5. 依赖图与 module import 规则在 v2 代码落地后用结构门禁检查。

## 定义与编译

```text
Definition Draft（可编辑、可不完整）
  → 每个 capability 自己的 compiler
  → Activity compiler 协调：schema/reference/dependency/compatibility/business/
    conflict/cross-capability binding
  → 诊断：ERROR / DEFERRED / WARNING / REVIEW / INFORMATION
  → 不可变 Definition Release
```

- UNKNOWN 不得被静默转为 0/false/空；DEFERRED 不是 PASS。
- 正式执行绑定 release；修正产生新版本，不重写历史。
- Draft 协作（多人编辑、最终一致）与权威命令（revision/CAS/事务）是两种模式，
  不能混用。

## 执行

Execution Session 至少包含：activity、definition release、scope、mode、运行时
事实。mode 至少区分 TEST/REHEARSAL 与 FORMAL；测试执行不得污染正式事实。

一个 Activity 可以同时运行多个 scope（排练、评分、签到、投票…）。哪些 scope
冲突由 capability 组合声明，而不是由 Activity 的单一阶段决定。

## 事实、决定、快照、投影

- **Facts**：已发生/已权威提交（报名提交、材料审核、分数提交、选票接受、签到）。
- **Decisions**：由事实与显式规则得出的结论（审核通过、排名、晋级、结果核定）；
  候选与正式决定必须可区分。
- **Snapshots**：权威边界上的不可变表示（冻结定义、名单、panel、核定结果、
  release、归档包）；后续修改不得改写历史快照。
- **Projections**：UI/列表/实时/搜索/报表读模型；可重建，永远不是权威。

## 写路径

```text
HTTP → 认证/限流 → command envelope（actor, activity, capability,
        expected revision, scope, idempotency key, payload）
  → 授权/所有权 → 锁聚合 → 重读并校验状态/OCC
  → 写事实 + outbox + 审计 → commit
  → 返回结果或带 code 的领域错误
```

- 正式事实不能因为客户端陈旧被静默覆盖；冲突可见、可恢复。
- command 必须显式携带上下文；幂等键防止重试产生第二条事实。

## 读路径

- 公开/列表/实时/报表消费 projection；projection 由 outbox 构建。
- 权威转换的历史读只读 snapshot。
- 每个公开事实只有一个 selector；selector 是 capability 的公开查询。
- 读模型可以最终一致；“发布后立即读到自己”用版本/snapshot 解决。

## 产品面职责

| 面 | 职责 | 不做什么 |
| --- | --- | --- |
| Studio | 设计活动、capability 组合、定义、策略、绑定、发布准备 | 现场执行 |
| Ops | 报名/材料/名单/节目/评委/任务/资源/彩排/准备度 | 重新定义规则 |
| Live | 当前表演/评分/投票/签到/节奏/异常/HOLD/恢复 | 成为事实源 |
| Portal | 参与者/评委/观众/志愿者/公众的角色化入口 | 泄漏越权信息 |

## 技术 Baseline

Node 24 LTS、TypeScript 7 strict、pnpm workspaces、Fastify 5 + TypeBox/OpenAPI、
PostgreSQL + Kysely + pg-boss（outbox）、React 19 + Vite 8 + TanStack Router/
Query、Vitest + fast-check、Playwright。决策与理由见 ADR-0002/0003；换库走新
ADR，不重开基础方向。

## 部署与可靠性

- 模块化单体优先；一个应用镜像，web/media/realtime 三个进程角色。
- 单公开来源；媒体经受控网关；静态产物与镜像同版。
- PostgreSQL 事实源；outbox + pg-boss；Redis 仅增强实时。
- 实时失败只降低可见性，不破坏正确性。
- 备份/恢复验证数据库引用的每个文件；版本 tag/digest 部署。

## 测试与门禁

- 领域单元 + 反例 + 属性测试（fast-check）。
- 实现无关 Golden fixtures（v1 与 v2 共用）。
- Contract tests（capability 之间、HTTP 错误码）。
- 真实 PostgreSQL 双线程并发测试。
- 关键现场旅程 E2E。
- 结构门禁：清单覆盖、权限闭包、部署不变量；后续增加 capability import 规则。

## 迁移

- v1 是 reference implementation，不是必须保留的架构。
- 按 vertical slice 切换；同一业务事实在任一时刻只有一个实现是权威。
- v1 的实现 bug 只修 v1；业务不变量提炼进 Golden/不变量，用 v2 重新实现。
