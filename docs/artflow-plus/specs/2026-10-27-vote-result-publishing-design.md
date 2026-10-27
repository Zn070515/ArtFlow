# ArtFlow-Plus：纯投票结果发布

状态：已确认（2026-10-27）
范围：解耦 `publishing` 对 `competition` 的依赖、新增投票来源的赛果预览与确认、
`vote-poll` pack、公开赛果的百分比显示、API 与测试。
非目标：投票场次管理 UI、票据 UI、现场大屏、候选显示名、导出。

## 背景

v2 的 `publishing` 静态依赖 `competition`，`publishing.stage_result.confirm` 只认
`podium_candidate`。`voting` 在场次关闭后有权威 tally（票数与百分比），但没有任何
路径把它变成可发布的赛果；`docs/artflow-plus/shape-validation.md` 把
「纯观众投票活动没有发布路径」列为明确缺口。

v1 的观众投票结果可以直接公示；v2 需要在不复制一整套发布链路的前提下补上。

## 决策

- **边界（已定）**：后端 + API。v2 目前没有投票 UI，本轮不新建场次管理界面；
  只提供预览/确认/发布所需的服务端与接口。
- **依赖（已定）**：`publishing` 不再静态依赖 `competition`。改为组合期校验：
  publishing 启用时，`enabledCapabilities` 必须至少包含 `competition` 或 `voting`
  之一，否则编译/发布被拒绝（`RESULT_SOURCE_REQUIRED`）。
- **独立命令（已定）**：新增 `publishing.vote_result.confirm`，不复用
  `stage_result.confirm`。podium 的确认流程与现有测试不变，只补一个显式的
  `CAPABILITY_NOT_ENABLED` 守卫；两类来源各自的过期守卫和审计语义清楚。
- **并列（已定）**：票数相同共享名次，下一名跳号（`1,1,3`）；次序按票数降序、
  再按选项 ordinal 升序稳定排列。
- **分数（已定）**：公开赛果的 `score` 显示得票百分比；原始票数只出现在预览，
  不落库、不公开。
- **单位（已定）**：`ResultDecision` 增加可选 `unit: "score" | "percent"`。投票结果
  写 `percent`；podium 不写（默认按分数）。快照、公开读、归档原样透传，向后兼容。
- **正式性（已定）**：确认走 publishing 的 formal 会话；投票场次的 mode 必须与之一致。
  rehearsal/test 场次不能发布。
- **purpose 不限制（已定）**：`popularity` 与 `score_component` 场次都可以单独发布；
  比赛可以把观众票结果作为独立阶段公示。

## 组合与依赖

```text
publishing
  dependencies: []
  commands: 原有 5 条 + "publishing.vote_result.confirm"
  queries:  原有 2 条 + "publishing.vote_result.preview"
  validateComposition:
    if publishing enabled and neither competition nor voting enabled
      -> RESULT_SOURCE_REQUIRED
       （编译输出的 issue code 带 CAPABILITY_ 前缀）
```

- podium 确认在未启用 `competition` 时返回 `CAPABILITY_NOT_ENABLED`（不再落到
  “找不到候选”）。
- 投票确认要求 `voting` 已启用，否则 `CAPABILITY_NOT_ENABLED`。
- 现有 pack（singer/review-awards）本来同时启用 competition 与 publishing，行为不变。

## 领域

### ResultDecision

```ts
export interface ResultDecision {
  readonly rank: number;
  readonly contestantId: string;
  readonly score: string;
  readonly unit?: "score" | "percent";
}
```

`buildResultSnapshot` 已逐条复制 decision，`unit` 自动进入快照；公开读与归档不需要
改结构。

### 排名纯函数

```ts
export interface VoteResultEntry {
  readonly contestantId: string;
  readonly count: number;
  readonly share: string;   // canonical percent string, e.g. "42.86"
  readonly ordinal: number; // option order at session open
}

export function buildVoteResultDecisions(
  entries: readonly VoteResultEntry[],
): readonly ResultDecision[];
```

规则：

1. 按 `count` 降序，再按 `ordinal` 升序。
2. 与前一名的 `count` 相同 → 共享同一 rank；否则 rank = 位置 + 1。
3. `score = share`，`unit = "percent"`。
4. 空输入非法（`INVALID_INPUT`）；`contestantId` 非空；`count` 必须是非负整数；
   `ordinal` 必须是非负整数；`share` 必须是非空字符串。

## 运行时

### 预览 `getVoteResultCandidate`

```ts
getVoteResultCandidate(db, deps, { activityId, sessionId })
  -> {
       sessionId, sessionRevision, mode,
       totalBallots, status: "ready" | "hold",
       holdReason?: "NO_VALID_BALLOTS",
       inputFingerprint: string,
       decisions: { rank, contestantId, score, count, unit }[]
     }
```

- 权限 `result.manage`；活动必须启用 publishing 与 voting。
- 场次必须属于该活动且 `status === "closed"`。
- tally 用 `getClosedVoteScores`（已排除 revoked/expired 票据）；0 有效票时
  `status: "hold"`、`decisions: []`。
- 指纹：`stableHash({ kind: "vote_result", activityId, sessionId,
  sessionRevision, totalBallots, countsByOption })`，`countsByOption` 按键排序。
- 预览返回 `count`，确认落库时不存。

### 确认 `confirmVoteStageResult`

```ts
confirmVoteStageResult(db, deps, {
  commandId, activityId, stageKey, scope,
  voteSessionId, expectedSessionRevision, expectedInputFingerprint,
  awards, note?
})
```

1. `executeCommand`（capability `publishing`，commandType
   `publishing.vote_result.confirm`）。
2. `lockPublishingActivity`：`result.manage`、活动 ACTIVE、publishing 已启用、
   `publishing` scope 有运行中的 formal 会话。
3. 要求 `voting` 已启用；读场次（同一事务），校验属于该活动
   （否则 `CROSS_ACTIVITY`）、已关闭（否则 `VOTE_SESSION_NOT_OPEN`）、
   `mode === session.mode`（否则 `FORMAL_MODE_REQUIRED`）。
4. 重算 tally；`hold` → `NO_VALID_BALLOTS`。
5. `session.revision !== expectedSessionRevision` 或指纹不符 →
   `STALE_RESOLUTION_INPUT`。
6. `stageKey` 必须在该活动的 publishing release 中声明；已确认的同一 stage result
   必须先 unlock。
7. `buildVoteResultDecisions` + `validateAwards`。
8. 写入 stage result：
   - `candidateRevision = existing ? max(existing.candidateRevision + 1, session.revision) : session.revision`
   - `sourceCandidateRevision = session.revision`
   - `inputFingerprint`、`decisions`、`awards`、`note`、`revision + 1`、`confirmedAt`
9. 事件 `StageResultConfirmed`，payload 额外带
   `source: { kind: "vote_session", sessionId }`。

后续 `releaseResult` / `revokeResultRelease` / `unlockStageResult` /
`editPublication` / 公开读 / 归档全部复用，不新增公开出口。

## API

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/activities/:id/publishing/vote-results/:sessionId` | 预览候选（`result.manage`） |
| POST | `/api/activities/:id/publishing/stage-results/:stageKey/confirm-vote` | 确认投票赛果 |

`confirm-vote` body：

```json
{
  "scope": "publishing",
  "voteSessionId": "vote-session-1",
  "expectedSessionRevision": 3,
  "expectedInputFingerprint": "sha256-of-the-closed-tally",
  "awards": [],
  "note": "人气投票结果"
}
```

两条路由都走 `requireIdempotency` + `requestDeps`。

## Pack

新增 `vote-poll`：

```text
baseline: voting, publishing
questions:
  archive（结束后是否归档？默认 true）
definitions:
  voting:     popularity / single / browser / ballot_share_percent(100, 2)
  publishing: [{ key: "vote_result", label: "投票结果" }]
```

加入 `/api/packs` 目录。纯投票活动不需要 registration / competition / roster。

最小流程：

```text
创建 → 激活 → 编译 → 发布
  → start execution(scope=voting, formal)
  → open vote session(candidateIds)
  → ballots
  → close vote session
  → start execution(scope=publishing, formal)
  → preview vote result
  → confirm-vote
  → release result
  → GET /api/public/results/:publicCode
```

## 公开显示

- `apps/web/src/api/public-results.ts` 的 `PublicDecision` 增加可选 `unit`。
- `ResultsView`：`unit === "percent"` 时显示 `42.86%`，否则维持现状；
  无障碍文案同步（不再给百分比追加“分”）。
- 不新增页面；只加一个渲染单测。

## 测试

- Domain：
  - 并列排名（1,1,3）、ordinal 稳定排序、百分比与 `unit`；
  - 空输入/负票数拒绝；
  - 组合校验：publishing 单独启用 → `RESULT_SOURCE_REQUIRED`；+voting 通过；
    +competition 通过。
- Runtime（真实 PostgreSQL）：
  - `vote-poll` 活动 → 发布释放 → voting 会话 → 3 人投票 → 关闭 → 预览 →
    confirm-vote → release → 公开读返回 `unit: "percent"`；
  - 0 有效票 → HOLD，确认拒绝；
  - 预览后票据撤销导致指纹变化 → `STALE_RESOLUTION_INPUT`；
  - rehearsal 场次确认拒绝；
  - unlock 后重确认；
  - 同一 stageKey 只能有一个 stage result。
- API：预览、确认、公开读、无权限 403。
- Pack：`vote-poll` 在默认注册表下实例化并编译，阶段是 `vote_result`，
  composition 不含 competition。
- Web：`ResultsView` 百分比渲染单测。
- 文档：ADR-0026、roadmap M10、`shape-validation.md` 缺口更新。

## 出口

1. `pnpm -C plus run check` / `run test` 全绿。
2. `uv run pytest tests/gates -q`、`scripts/check_docs.ps1` 通过。
3. `vote-poll` 的投票 → 确认 → 发布 → 公开读关键旅程通过。
4. 现有 podium 发布测试零改动。

## 风险

- 关闭场次后票据撤销会改变 tally；确认时的指纹比较是唯一守卫，预览必须使用
  同一指纹。
- 公开赛果的 `score` 语义随 `unit` 变化；旧快照没有 `unit`，按原样显示。
- 本轮没有投票 UI，运营仍需通过 API 创建/关闭场次；该缺口在 roadmap 明确记录。
