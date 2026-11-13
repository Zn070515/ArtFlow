# Live 异常恢复设计（2026-11-13）

## 1. 背景

2026-11-13 的可达性审计确认：`publishing` 的解锁/撤销、`competition` 的评分编辑与
修正、平局裁决、晋级定稿都有命令和 route，但 Web 没有入口。现场出现错误时，组织者
只能直接调 API，或者接受错误结果。

本设计补齐这条“出错后收场”的产品路径，不新增业务命令，不改变现有事实、事件与投影。

## 2. 目标与非目标

目标：

1. 评分错误：在 Live 页选定评分事实，开修正、改分、关闭、重算。
2. 平局/晋级：看到跨越晋级线的平局组，记录裁决，定稿晋级。
3. 发布错误：解锁赛段结果或撤销已发布 release，再重新确认/发布。
4. 所有动作使用页面上的 revision/version，不要求用户手填内部 UUID。

非目标：

- 不新增评分来源（`paper_dr`、`staff_proxy`、`staff_rapid` 的录入 UI 另开 slice）。
- 不实现 publication 内容编辑（`publishing.publication.edit`）。
- 不改变评分、排名、发布或归档的领域规则。
- 不把 `GET /api/activities/:id/events` 等只读诊断搬进本设计。

## 3. 现状证据

- `POST /competition/rounds/:roundKey/scores/:scoreFactId/corrections`（开）、
  `/close`、`/recalculate`、`PATCH .../scores/:scoreFactId`、`POST .../ties/:tieId/decide`、
  `POST .../advancement/finalize` 均无 Web 调用方。
- `POST /publishing/stage-results/:stageKey/unlock` 与
  `POST /publishing/releases/:releaseId/revoke` 无 Web 调用方。
- `GET /publishing/state` 已经返回 `releases` 与 `publications`，Web 类型只声明了前三个字段。
- `GET /competition/rounds/:roundKey/ranking` 已经返回 `inputFingerprint` 与带 `id` 的
  `tieGroups`，Web 类型省略了这两个字段。
- 评分事实已有 `listCurrentScoreFacts(roundId, mode)`，但没有按轮次暴露给运营端的读入口。

## 4. 读模型

### 4.1 新增：轮次评分事实

`GET /api/activities/:id/competition/rounds/:roundKey/scores?scope=judging`

- access：`operations`，与 ranking 读一致。
- mode：由当前运行中的 execution session 决定，不接受客户端传 mode；没有运行中
  session 时返回 `session: null` 与空列表。
- 只返回 `current = true` 的评分事实；每个事实附带最近一条修正
  （`open`/`revised`/`closed`/`recalculated`），没有则为 `null`。
  `recalculated` 只用于展示终态，不再提供动作。
- 响应：

```ts
interface RoundScoresResponse {
  readonly round: {
    readonly key: string;
    readonly state: "prepared" | "scoring" | "locked" | "resolved";
    readonly revision: number;
    readonly scoreVersion: number;
    readonly advanceCount: number;
  };
  readonly session: { readonly id: string; readonly mode: "test" | "rehearsal" | "formal"; readonly scope: string } | null;
  readonly performances: readonly {
    readonly id: string;
    readonly contestantId: string;
    readonly sequence: number;
    readonly state: "not_opened" | "open" | "locked";
    readonly contextVersion: number;
  }[];
  readonly facts: readonly {
    readonly id: string;
    readonly performanceId: string;
    readonly contestantId: string;
    readonly judgeId: string;
    readonly seatId: string;
    readonly source: string;
    readonly total: string;
    readonly criteria: Readonly<Record<string, number>>;
    readonly notes: string;
    readonly version: number;
    readonly contextVersion: number;
    readonly panelSnapshotId: string;
    readonly correction: {
      readonly id: string;
      readonly state: "open" | "revised" | "closed" | "recalculated";
      readonly baseVersion: number;
      readonly reason: string;
      readonly revision: number;
    } | null;
  }[];
}
```

实现位置：

- 响应 schema 放在 `packages/contracts/src/competition.ts`；
- 读逻辑放在 `packages/runtime/src/competition-read-service.ts`（复用
  `listCurrentScoreFacts` 与修正仓储，不复制评分规则）；
- route 放在 `apps/api/src/routes/competition.ts`。

### 4.2 扩展 Web 类型（后端无改动）

- `PublishingStateView` 增加 `releases`（`id`、`stageKey`、`status`、`note`、
  `releasedAt`、`revokedAt?`）与 `publications`（如需展示当前节目单版本）。
- `LiveRanking` 增加 `inputFingerprint`；`tieGroups` 增加 `id`。
- `LiveRanking.revision` 作为晋级定稿的 `expectedRankingRevision`。

## 5. UI

### 5.1 LiveExceptionPanel

位置：`apps/web/src/components/live/LiveExceptionPanel.tsx`，由 `LiveRoundPanel`
在轮次存在时渲染；只对 `competition.manage` 或 `competition.score.write` 显示可写动作。

三个区域：

1. **评分修正**
   - 按表演分组列出评分事实（选手、席位、来源、当前总分、修正状态）。
   - `开修正`：弹窗填 reason → `openScoreCorrection`。
   - 修正状态为 `open` 时展开 criteria 表单（rubric 的 key/min/max），
     `保存修正` 调 `editScoreFact`（带 `correctionId`、`expectedVersion`、完整 criteria 与 reason）。
   - `关闭修正`（仅 `revised`）→ `closeScoreCorrection`；`重算`（仅 `closed`）→
     `recalculateAfterCorrection`。
2. **平局与晋级**
   - 展示 ranking status；`hold` 时列出 tie groups（id、总分、选手）。
   - 顺序编辑：每个平局组给出可上下移动的列表，必须包含全部组员；reason 必填。
   - `记录裁决` → `recordTieDecision`（用 rankingSnapshotId、inputFingerprint、contestants、order、reason）。
   - `晋级定稿` → `finalizeAdvancement`（用 ranking.revision 与 advanceCount）；ranking 非 ready
     或仍跨线平局时禁用并提示。
3. **会话门槛**
   - 没有运行中 session、round 已 locked/resolved、或 activity 非 active 时，
     面板显示对应阻塞原因，所有动作禁用。

### 5.2 ResultActions

在现有确认/发布旁增加：

- 当前赛段的 release 列表（状态、时间、note）；`active` 行提供 `撤销发布`（note 必填）。
- `stageResult.status === "confirmed"` 时提供 `解锁赛果`（note 必填，发送 candidateRevision）。
- 撤销/解锁成功后刷新 publishing state，并提示下一步（重新确认或重新发布）。

### 5.3 GroupingCard

创建赛段时增加 rosterSource 选择：

- `all_approved`（默认，保持现状）；
- `round_advanced`：交给命令校验晋级定稿是否存在；失败时在创建表单内显示
  服务端原因（不新增晋级状态读接口）。

## 6. 命令流、并发与错误

- 所有 mutation 使用新的 `commandId(prefix)` 生成幂等键，并发送页面读到的
  `expectedVersion` / `expectedRevision` / `candidateRevision`。
- `STALE_REVISION` / `STALE_CONTEXT`：重新拉取评分事实或 publishing state，
  提示“数据已变化，请重试”，不自动重放。
- `CORRECTION_REQUIRED` / `CORRECTION_ALREADY_OPEN` / `CORRECTION_NOT_FOUND`：
  保留弹窗内容，显示状态机原因。
- `RESULT_CONSUMED`：提示先解锁赛段结果；`RESULT_NOT_CONFIRMED`：提示先重新确认。
- 晋级：`FORMAL_MODE_REQUIRED` 时提示只能正式模式定稿；平局跨线时提示先裁决。
- 错误展示复用 `describeLiveError`，不新增错误码映射表；不向前端透出 SQLSTATE。

## 7. 权限与模式

- 读接口沿用 `operations` access；publishing state 沿用 `result` access。
- 写动作沿用命令自身的权限（`competition.manage` / `competition.score.write` /
  `result.manage`），UI 只做提前禁用，不构成授权边界。
- 评分事实的 mode 由服务端 session 决定；修正命令继续校验 fact.mode 与 session.mode 一致。

## Test architecture

- **Contracts and capabilities touched**：本设计触及 `competition` 与 `publishing`
  两个 capability，新增一个只读响应契约（轮次评分事实），并复用现有的修正、
  平局、晋级、发布生命周期。不新增命令、事件、topic 或数据库迁移；不改变
  receipt/audit/fact/outbox 的单一写路径。
- **Consumers and read models**：消费者是 Live 活动页的
  `LiveExceptionPanel` 与 `ResultActions`、Ops 的 `GroupingCard`。新增读入口
  `GET .../rounds/:roundKey/scores` 必须在 Consumer Graph 中产生 `consumes-route`
  边；`publishing/state` 与 `ranking` 只扩展现有消费者的字段，不新增读模型。
- **Lifecycle, terminal guards, and mode isolation**：修正只允许在运行中的、
  目标 performance 已 locked 的 session 内进行；open → revised → closed →
  recalculated 四个状态各有前置条件；晋级要求 ranking ready 且 formal；发布
  撤销/解锁要求当前 candidateRevision 匹配。读入口的 mode 来自服务端 session，
  UI 不能指定 formal/test/rehearsal。
- **Adapters**：不新增 contract adapter。审计、修正与发布的生命周期已经由 runtime
  service 与现有 HTTP 测试覆盖；新读入口作为页面集成 seam，使用真实 PostgreSQL
  与真实 session，不 mock 仓储。
- **Fault and recovery cases**：覆盖 stale revision、重复开修正、未 revised 就关闭、
  未 closed 就重算、跨线平局未裁决就定稿、撤销后重新发布、解锁后重新确认。
  每个用例可在同一种子数据上重复执行，失败信息带 roundKey、scoreFactId 与
  当前 revision；不引入任意 sleep。
- **Why existing tests are insufficient**：现有测试只验证命令本身，没有页面消费者，
  也没有一条从“发现错分”到“重算并定稿”的浏览器路径；`ui-gaps.json` 正是因此
  把它们列为不可达。新测试必须证明页面入口存在并能完成整个恢复流程。
- **Anti-bloat decision**：扩展现有 Live 组件与 runtime 读服务，不新建第二个
  评分业务层；新读入口只做投影，不重新计算排名或总分；不改 Pack 定义。
- **Focused gates**：`pnpm -C plus --filter @artflow-plus/web run test`、
  `pnpm -C plus --filter @artflow-plus/web run check`、
  `pnpm -C plus --filter @artflow-plus/api run test`（含新读入口）、
  `pnpm -C plus run graph:check`、`uv run pytest tests/gates -q`，
  以及新增的 Playwright recovery journey。

## 8. 实施顺序

1. 读入口：契约 schema、runtime 读服务、route、Web 类型与包装函数、读接口测试。
2. ResultActions：release 列表、撤销、解锁，配套 API/Web 测试。
3. LiveExceptionPanel 评分修正：状态机、criteria 表单、四个命令、单元测试。
4. 平局与晋级：tie 顺序编辑、定稿、Grouping rosterSource、单元测试。
5. E2E recovery journey：错分修正、平局裁决、晋级、撤销/重新发布。
6. 文档、Consumer Graph 检查与全量门禁。

## 9. 风险与决策

- **评分事实读入口的 mode**：选择服务端 session 决定，而不是 query 参数；这样
  测试/彩排/正式的分区不会被客户端伪造。
- **平局顺序编辑**：先做上下移动的受控列表，不做拖拽；拖拽不影响命令契约。
- **发布撤销与解锁的关系**：撤销针对 release，解锁针对 stage result；两者都在
  ResultActions 内，避免把发布动作拆到两个组件。
- **Grouping rosterSource**：只加选择器，不在本轮自动计算晋级名单；命令失败时
  由界面展示原因。
