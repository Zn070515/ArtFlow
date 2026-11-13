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
- 除 §5.3 的“晋级决策必须匹配当前 ranking 指纹”守卫外，不改变评分、排名、
  发布或归档的领域规则。
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

- access：新增 `competition` 读级别（`competition.manage`、`competition.score.write`
  或 `studio.manage`），**不使用 `operations`**。`operations` 也放行只有
  `judge.manage` 的评委，而这个读接口会暴露同场其他评委的 criteria 与 notes。
- mode：由当前运行中的 execution session 决定，不接受客户端传 mode；没有运行中
  session 时返回 `session: null` 与空列表。`scope` 只接受 judging（或来源轮次绑定的
  评分 scope），其他值返回 400。
- 只返回 `current = true` 的评分事实；每个事实附带最近一条修正
  （`open`/`revised`/`closed`/`recalculated`/`cancelled`），没有则为 `null`。
  `recalculated`/`cancelled` 只用于展示终态，不再提供动作。最近一条按
  `created_at desc, revision desc` 选取——`revision` 是单条修正自己的版本号，
  新修正会重置为 0，不能跨修正比较。
- 响应：

```ts
interface RoundScoresResponse {
  readonly round: {
    readonly key: string;
    readonly state: "prepared" | "scoring" | "locked";
    readonly revision: number;
    readonly scoreVersion: number;
    readonly advanceCount: number;
  };
  readonly session: { readonly id: string; readonly mode: "test" | "rehearsal" | "formal"; readonly scope: string } | null;
  readonly ranking: {
    readonly id: string;
    readonly revision: number;
    readonly status: "ready" | "hold";
    readonly inputFingerprint: string;
    readonly rows: readonly {
      readonly contestantId: string;
      readonly total: string;
      readonly judgeCount: number;
    }[];
    readonly tieGroups: readonly {
      readonly id: string;
      readonly total: string;
      readonly contestants: readonly string[];
    }[];
  } | null;
  readonly advancement: {
    readonly id: string;
    readonly revision: number;
    readonly status: "auto" | "needs_review" | "finalized";
    readonly inputFingerprint: string;
    readonly decisions: readonly { readonly contestantId: string; readonly advanced: boolean }[];
  } | null;
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
      readonly state: "open" | "revised" | "closed" | "recalculated" | "cancelled";
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
  `releasedAt`、`revokedAt?`）；publication 内容编辑不在本设计内。
- `LiveRanking` 增加 `inputFingerprint`；`tieGroups` 增加 `id`。
- `LiveRanking.revision` 作为晋级定稿的 `expectedRankingRevision`。

### 4.3 恢复顺序与前置条件

实际命令的状态机有两处容易走反：

1. `recalculateAfterCorrection` 只把修正标成 `recalculated`，**不会重算 ranking**。
   改分后必须再调用 `competition.ranking.resolve`（现有“生成排名”），否则排名、
   领奖候选和晋级仍基于旧分数。
2. `finalizeAdvancement` 的决策带 `inputFingerprint`；任何改分 + 重新排名都会让
   旧决策过期。改分后必须重新定稿，`round_advanced` 分组只能消费与当前 ranking
   fingerprint 一致的 `auto` 决策。

因此恢复顺序固定为：

**A. 发布后改分**

1. 启动/复用发布会话；
2. `解锁赛果`（自动 supersede 当前 active release）；
3. 确保有运行中的 judging 正式会话；
4. 若轮次为 `locked`，先用现有“打开评分更正窗口”重开；
5. 开修正 → 改分 → 关闭 → 重算；
6. `锁轮`（`resolveRound` 只接受 locked 轮次）；
7. `生成排名`（新的 ranking snapshot，revision +1）；
8. 若存在晋级/平局，重新裁决/定稿；
9. `生成领奖候选` → `确认评委赛果` → `发布赛果`。

**B. 只撤回发布**

- `撤销发布` 只把 release 置为 `revoked`，赛段仍是 `confirmed`，可直接重新发布；
- `解锁赛果` 是另一条路径：赛段变回 `ready_to_confirm` 并 supersede active release，
  必须重新确认后才能发布。

**C. 未发布改分**

- 轮次 `locked` 时先重开，`scoring` 时直接修正；
- 修正 → 重算 → 锁轮 → 生成排名；需要发布时再确认/发布。

**D. 平局与晋级**

- `记录裁决` 会插入新的 ranking snapshot（revision +1），裁决后必须刷新 ranking；
- 多个跨线平局组逐个裁决，全部解决前 `晋级定稿` 保持禁用；
- 定稿成功后显示最新决策；若 `advancement.inputFingerprint` 与
  `ranking.inputFingerprint` 不一致，显示“晋级名单已过期，请重新定稿”。

## 5. UI

### 5.1 LiveExceptionPanel

位置：`apps/web/src/components/live/LiveExceptionPanel.tsx`，由 Live 活动页
（`routes/liveActivity.tsx`）在轮次面板 `LiveRoundPanel` 之后按轮次渲染，而不是由
`LiveRoundPanel` 自身渲染；只对 `competition.manage` 或 `competition.score.write`
显示可写动作。平局/晋级实现为同级 `LiveTieAdvancementPanel.tsx`，同样由 Live 活动页
渲染，是评分修正面板的兄弟节点——轮次 `locked` 是平局裁决与晋级定稿的正常起点，
不能被评分修正的锁定阻塞态一并隐藏。

三个区域：

1. **评分修正**
   - 按表演分组列出评分事实（选手、席位、来源、当前总分、修正状态）。
   - 前置条件：round 为 `scoring`、performance 已 locked、存在运行中的 judging
     session。round 为 `locked` 时显示“先打开评分更正窗口”，不提供修正按钮；
     赛段结果已被确认消费时显示“先解锁赛果”。
   - `开修正`：弹窗填 reason → `openScoreCorrection`。
   - 修正状态为 `open` 时展开 criteria 表单（rubric 的 key/min/max），
     `保存修正` 调 `editScoreFact`（带 `correctionId`、`expectedVersion`、完整 criteria 与 reason）。
     一条修正只允许一次编辑；保存后状态为 `revised`，不再显示表单。
   - `关闭修正`（仅 `revised`）→ `closeScoreCorrection`；`重算`（仅 `closed`）→
     `recalculateAfterCorrection`；`recalculated` 为终态，不再提供动作。
   - 每次命令成功后重新拉取 scores、publishing state 与 live state；**重算后必须由
     panel 提示先“锁轮”再“生成排名”**——`resolveRound` 只接受 locked 轮次，否则
     排名不会变化。
2. **平局与晋级**
   - 展示 ranking status；`hold` 时列出 tie groups（id、总分、选手）。
   - 顺序编辑：每个平局组给出可上下移动的列表，必须包含全部组员；reason 必填。
   - `记录裁决` → `recordTieDecision`（用当前 rankingSnapshotId、inputFingerprint、
     contestants、order、tieId、reason）；成功后刷新 ranking，revision 会 +1。
   - 多个跨线平局组逐个裁决；每次裁决后重新计算哪些组仍跨晋级线，全部解决前
     `晋级定稿` 禁用。
   - `晋级定稿` → `finalizeAdvancement`（用刷新后的 ranking.revision 与
     round.advanceCount）。启用条件只看“仍有跨线平局”：非跨线的 `hold` 排名也可以
     定稿，后端会自动晋级。已有与当前 ranking fingerprint 一致的 `auto`/`finalized`
     决策时显示终态并禁用。`needs_review` 不算终态：先裁决平局，再用新的 revision 定稿。
   - `advancement.inputFingerprint` 与 `ranking.inputFingerprint` 不一致时显示
     “晋级名单已过期，请重新定稿”。
3. **会话与阻塞**
   - 没有运行中 session、activity 非 active、或轮次不满足上述前置条件时，面板显示
     对应阻塞原因，相关动作禁用；不隐藏现有“打开评分更正窗口”“生成排名”“锁轮”按钮。

### 5.2 ResultActions

在现有确认/发布旁增加：

- 当前赛段的 release 列表（状态、时间、note）；`active` 行提供 `撤销发布`（note 必填）。
- `stageResult.status === "confirmed"` 时提供 `解锁赛果`（note 必填，发送 candidateRevision）。
- 两个动作都要求发布会话运行中；没有会话时只显示“启动发布会话”（复用现有按钮）。
- 语义区分：
  - `撤销发布` 只把 release 置为 revoked，赛段仍 confirmed，可直接再次发布；
  - `解锁赛果` 把赛段变回 ready_to_confirm，并自动 supersede active release，
    必须重新生成候选/确认后才能发布。
- 成功后刷新 publishing state 与 live state，并提示下一步：`撤销发布` 成功后显示
  “已撤销发布，可重新发布。”；`解锁赛果` 成功后显示“已解锁赛果，请重新确认后再发布。”
  解锁后的赛段回到 `ready_to_confirm`，必须重新确认赛果才能再次发布。
  若先解锁再改分，按 §4.3 的 A 顺序执行。
- 评委赛果（podium）与投票赛果（vote）分别沿用现有 `ResultActions` 与
  `VotingCard` 的确认入口；本设计只补撤销/解锁，不改变两套确认逻辑。

### 5.3 GroupingCard

创建赛段时增加 rosterSource 与来源轮次选择：

- `all_approved`（默认，保持现状），不传 `sourceRoundId`；
- `round_advanced`：Web 包装函数保留 `sourceRoundId`，但 UI 选择器本轮**推迟**。
  原因：当前 live 读模型不暴露晋级来源的参与者集合，卡片的自动平均分组只能基于
  全部通过名单，无法完成 `round_advanced` 赛段。后端命令、指纹守卫和 API 字段
  已就绪；待补 source-participant 读模型后再恢复 UI。
- 命令只接受状态为 `auto` 的最新晋级决策；若最新决策是 `needs_review`、不存在，
  或其 `inputFingerprint` 与来源轮次当前 ranking 不一致，返回
  `GROUPING_SOURCE_UNKNOWN` / `STALE_ADVANCEMENT`，表单原样展示原因。
- 对应地在 `grouping-service` 增加一道只读校验：晋级决策的 `inputFingerprint`
  必须等于来源轮次当前 ranking snapshot 的 `inputFingerprint`；这是生命周期守卫，
  不改变分组规则。

## 6. 命令流、并发与错误

- 所有 mutation 使用新的 `commandId(prefix)` 生成幂等键，并发送页面读到的
  `expectedVersion` / `expectedRevision` / `candidateRevision`。
- `STALE_REVISION` / `STALE_CONTEXT` / `STALE_RESOLUTION_INPUT`：重新拉取评分事实、
  ranking 或 publishing state，提示“数据已变化，请重试”，不自动重放。
- `CORRECTION_REQUIRED` / `CORRECTION_ALREADY_OPEN` / `CORRECTION_NOT_FOUND`：
  保留弹窗内容，显示状态机原因。
- `RESULT_CONSUMED`：提示先解锁赛段结果；`RESULT_NOT_CONFIRMED`：提示先重新确认。
- `SESSION_NOT_RUNNING`：提示先启动对应的 judging / publishing 会话。
- 晋级：`FORMAL_MODE_REQUIRED` 时提示只能正式模式定稿；平局跨线时提示先裁决；
  `STALE_ADVANCEMENT` 时提示重新定稿后再建分组。
- 改分成功后：先 `锁轮`，再 `生成排名`；任何改分都会让已有晋级决策过期，
  面板必须比对 `advancement.inputFingerprint` 与 `ranking.inputFingerprint`。
- 错误展示以 `describeLiveError` 为基础；评分修正面板在组件内保留一张小型中文映射
  （`CORRECTION_ERROR_MESSAGES`），只补充该面板特有的状态机错误码（如
  `PERFORMANCE_SCORE_OPEN`、`CORRECTION_REQUIRED`），不在前端复制服务端错误表；
  不向前端透出 SQLSTATE。

## 7. 权限与模式

- 新增的评分事实读接口使用新的 `competition` 读级别（competition.manage /
  competition.score.write / studio.manage），显式排除 judge-only 读者；
  publishing state 沿用 `result` access。
- `competition` 级别要在 `app.ts` 的 `ReadAccess` 与 `requireReadAccess` 中实现，
  不能复用 `operations`（后者会追加 `judge.manage`）。
- 写动作沿用命令自身的权限（`competition.manage` / `competition.score.write` /
  `result.manage`），UI 只做提前禁用，不构成授权边界。
- 评分事实的 mode 由服务端 session 决定；修正命令继续校验 fact.mode 与 session.mode 一致。
- 修正要求 round 为 `scoring` 且有运行中的 judging session；`locked` 轮次必须先走
  现有 `competition.round.reopen_correction`（仅正式模式）。
- 平局裁决与晋级定稿仅正式模式；发布撤销/解锁要求运行中的 publishing session。
- 这些前置条件由命令继续兜底，UI 的禁用只是提示，不是授权边界。

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
  recalculated 四个状态各有前置条件；晋级要求无跨线平局且 formal；发布
  撤销/解锁要求当前 candidateRevision 匹配。读入口的 mode 来自服务端 session，
  UI 不能指定 formal/test/rehearsal。评分事实读接口用新的 `competition` 读级别，
  只有 judge.manage 的评委必须被拒绝。
- **Adapters**：不新增 contract adapter。审计、修正与发布的生命周期已经由 runtime
  service 与现有 HTTP 测试覆盖；新读入口作为页面集成 seam，使用真实 PostgreSQL
  与真实 session，不 mock 仓储。
- **Fault and recovery cases**：覆盖 stale revision、重复开修正、未 revised 就关闭、
  未 closed 就重算、跨线平局未裁决就定稿、多个跨线平局组逐个裁决、裁决后 ranking
  revision 变化、撤销后重新发布、解锁自动 supersede release 后重新确认、改分后未
  重新排名导致排名不变、改分后未重新定稿导致 `round_advanced` 使用过期决策。
  每个用例可在同一种子数据上重复执行，失败信息带 roundKey、scoreFactId、ranking
  revision 与 inputFingerprint；不引入任意 sleep。
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

1. 读入口：契约 schema、runtime 读服务（含 ranking/advancement 摘要）、route、
   Web 类型与包装函数、读接口测试。
2. ResultActions：release 列表、撤销、解锁、发布会话门槛，配套 API/Web 测试。
3. LiveExceptionPanel 评分修正：前置条件提示、状态机、criteria 表单、四个命令、
   成功后刷新与“重算后生成排名”提示、单元测试。
4. 平局与晋级：tie 顺序编辑、裁决后刷新、定稿与过期检测、Grouping
   rosterSource + sourceRoundId + 指纹守卫、单元测试。
5. E2E recovery journey：解锁 → 重开 → 改分 → 重算 → 锁轮 → 生成排名 →
   裁决/定稿 → 重新确认/发布，另加撤销后重新发布。
6. 文档、Consumer Graph 检查与全量门禁。

## 9. 风险与决策

- **评分事实读入口的 mode**：选择服务端 session 决定，而不是 query 参数；这样
  测试/彩排/正式的分区不会被客户端伪造。
- **平局顺序编辑**：先做上下移动的受控列表，不做拖拽；拖拽不影响命令契约。
- **发布撤销与解锁的关系**：撤销针对 release，解锁针对 stage result；两者都在
  ResultActions 内，避免把发布动作拆到两个组件。
- **Grouping rosterSource**：只加选择器与来源轮次，不在本轮自动计算晋级名单；
  命令失败时由界面展示原因，并用 fingerprint 守卫拒绝过期决策。
- **重算与排名解耦**：不在 `recalculateAfterCorrection` 内自动 resolve；恢复流程
  显式“重算 → 锁轮 → 生成排名”，避免修正命令承担排名副作用。面板负责提示这一步。
- **晋级决策过期**：不把“最新决策”当成永远有效；面板与 grouping 都比对
  `inputFingerprint`，改分后必须重新定稿。
- **重复定稿**：`finalizeAdvancement` 本身不幂等；面板用最新决策的 revision 与
  fingerprint 显示终态并禁用按钮，避免重复点击产生新决策。
- **旧 ranking 快照的 tieGroup 可能没有 id**：UI 在缺少 `id` 时省略 `tieId`，
  命令会按 contestants 匹配当前快照；新生成的快照始终带 id。
- **评委评分保密**：新增读级别排除 judge-only 读者；`judge.manage` 仍可通过现有
  排名接口看到名次与总分，但看不到其他评委的 criteria/notes。
