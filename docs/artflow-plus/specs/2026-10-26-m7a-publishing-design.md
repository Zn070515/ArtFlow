# ArtFlow-Plus M7a：Publishing / Results 设计

状态：已确认（2026-10-26）
范围：`artflow-plus` 分支的新 capability `publishing`、持久化、运行时命令、
API 出口与 `result-release-lifecycle` golden 适配。
非目标：归档包（M7b）、apps/web 页面、媒体字节网关、PDF 生成、结果导出。

## 背景

M5 把 podium 计算产出为 `StageResultCandidateProduced`，但明确不核定奖项、
不物化正式结果。M6/M6.5 提供了投票与票据权威。M7a 补齐从内部候选到公众事实
的最后一段：

```text
competition podium candidate
  → confirm（绑定 candidate revision + fingerprint + awards）
  → release（不可变 snapshot；公众可见）
  → revoke / unlock（旧 release 立即失效）
  → re-confirm → re-release
```

## 已确认的决策

| 决策 | 结论 |
| --- | --- |
| M7 切分 | 本轮只做 M7a Publishing/Results；Archive 为 M7b |
| 交付边界 | 领域 + 运行时 + Fastify API 读出口；不做页面 |
| capability 归属 | 新建 `publishing`，同时拥有核定、解锁、发布、撤销与公开 selector |
| candidate 权威来源 | HTTP 只传 stage key 与期望 revision/fingerprint；runtime 读取 competition podium 读模型 |
| 公开入口 | `GET /api/public/results/:publicCode`，按活动公开码聚合 ACTIVE release |
| awards | confirm 时由有权限的 staff 显式提交，校验人选属于候选名次 |

## 领域模型

### StageResult

每个 `(activityId, stageKey)` 一行，由 `publishing` 拥有。

```text
status: confirmed | ready_to_confirm
candidateRevision: number      // publishing 的确认修订号，单调递增
sourceCandidateRevision: number // 核定时 competition podium candidate 的 revision
inputFingerprint: string        // 核定时 podium candidate 的输入指纹
decisions: { rank, contestantId, score }[]
awards: { award, contestantId }[]
revision: number                // OCC
confirmedAt / unlockedAt
```

- confirm 时 `candidateRevision = podiumCandidate.revision`；
- unlock 时 `candidateRevision += 1`、status 变为 `ready_to_confirm`；
- 再次 confirm 时 `candidateRevision += 1`，并重新绑定当前 podium candidate。

### ResultPublication

每个 `(activityId, stageKey)` 一个编辑容器，字段 `title/content/version/revision`。

- 只要该 stage 存在 ACTIVE release，任何编辑都返回 `RESULT_POST_FROZEN`；
- 公开 selector **不读取**这些编辑字段（RESULT-02）；公开标题只来自 release
  snapshot。

### ResultRelease

```text
status: active | revoked | superseded
snapshot: {
  activityTitle, publicTitle, stageKey,
  decisions, awards
}
snapshotCandidateRevision, resultVersion,
postVersion, note, releasedAt, revokedAt, supersededAt, revision
```

- snapshot 在 release 命令内一次性生成，之后不可变；
- snapshot 不包含 `inputFingerprint`、authority hash、actor、token；
- 同一 `(activityId, stageKey)` 最多一条 ACTIVE release（部分唯一索引）；
- revoke 只改状态，不删除历史；unlock 将 ACTIVE release 置为 `superseded`。

`publicTitle` 由 snapshot 生成：`"{release 时的 activityTitle} · 正式赛果"`。
活动之后改名不改变已发布 snapshot（`archive-identity` 的同一原则）。

## Capability 契约

- identity：`publishing`，version `1`；
- depends：`competition`；
- definition artifact：`{ version: 1, schemaVersion: 1, stages: [{ key, label }] }`，
  默认 stage `final_podium`；
- commands：`confirm_stage_result`、`unlock_stage_result`、`release_result`、
  `revoke_result_release`、`edit_result_publication`；
- queries：`publishing_state`（staff）、`public_results`（匿名 selector）；
- events：`StageResultConfirmed`、`StageResultUnlocked`、`ResultReleased`、
  `ResultReleaseRevoked`、`ResultReleaseSuperseded`、`ResultPublicationEdited`；
- permissions：`result.manage`。

capability 模块只允许导入 engine（`../compiler.js`、`../errors.js`、
`../model.js`、`../registry.js`、`../scoring.js`），不得导入 competition
模块或 persistence。

## 命令语义

所有写命令都通过 `executeCommand`，带 `Idempotency-Key`、actor 注入、
audit、outbox，并要求 `publishing` scope 有运行中的 execution session。

### confirm_stage_result

输入：`stageKey`、`expectedCandidateRevision`、`expectedInputFingerprint`、
`awards`、`note`。

1. 锁 activity 与 stage result 行；
2. runtime 读取该活动最新的 podium candidate（status 必须为 `candidate`）；
3. candidate revision / fingerprint 与输入不符 → `STALE_RESOLUTION_INPUT`；
4. awards 校验：contestant 必须出现在 decisions 中、label 非空且不重复；
   同一 contestant 可以出现在多个奖项中（例如冠军 + 最佳人气）；
5. 写入/更新 stage result，事件 `StageResultConfirmed`。

### release_result

输入：`stageKey`、`expectedCandidateRevision`、`note`。

- stage result 必须为 `confirmed` 且 revision 匹配；
- 已有 ACTIVE release → `RESULT_ALREADY_RELEASED`；
- 生成不可变 snapshot，写入 ACTIVE release，事件 `ResultReleased`；
- 保证 publication 存在（不存在则以 snapshot 标题建一个冻结容器）。

### revoke_result_release

输入：`stageKey`、`note`。

- 只允许 ACTIVE → `revoked`；否则 `RESULT_RELEASE_NOT_ACTIVE`；
- 事件 `ResultReleaseRevoked`；公众立即不可见。

### unlock_stage_result

输入：`stageKey`、`expectedCandidateRevision`、`note`。

- stage result 必须为 `confirmed` 且 revision 匹配；
- stage result → `ready_to_confirm`，revision + 1；
- 若存在 ACTIVE release → `superseded`；
- 同一事务写 `StageResultUnlocked` + `ResultReleaseSuperseded`。

### edit_result_publication

输入：`stageKey`、`expectedVersion`、`title`、`content`。

- 存在 ACTIVE release → `RESULT_POST_FROZEN`，无副作用；
- publication 不存在时，`expectedVersion` 必须为 0，创建草稿；
- 已存在时按 `expectedVersion` CAS 更新；
- 两种情况都写事件 `ResultPublicationEdited`。

## 持久化

迁移 `0012_m7_publishing`：

- `stage_result`
  - 主键 `id`；FK `activity_id`；`unique(activity_id, stage_key)`；
  - `status` check；decisions / awards 为 jsonb；
- `result_publication`
  - 主键；FK activity；`unique(activity_id, stage_key)`；`version`/`revision`；
- `result_release`
  - 主键；FK activity / publication / stage_result；
  - `status` check；snapshot jsonb；`released_at` 等时间列；
  - `create unique index result_release_active_unique on result_release(activity_id, stage_key) where status = 'active'`。

repository `plus/packages/db/src/publishing-repository.ts` 负责全部
`FOR UPDATE` 读取、CAS 更新与 selector；`types.ts`/`index.ts` 同步导出。

## 公开 selector

唯一实现：

```ts
selectPublicResults(db, publicCode): Promise<{
  activity: { publicCode },
  activityTitle,           // 最新 ACTIVE release 的 snapshot.activityTitle
  results: {
    releaseId, stageKey, publicTitle, releasedAt,
    decisions: { rank, contestantId, score }[],
    awards: { award, contestantId }[]
  }[]
} | null>
```

- 只查 `status = 'active'`，按 stage key 排序；`activityTitle` 也取自
  snapshot，不读 activity 当前标题；
- 活动不存在或没有 ACTIVE release → `null`（HTTP 404）；
- 不返回 fingerprint、hash、actor、note、审计、编辑字段；
- 同一函数供公开 API 与后续列表/PDF/导出复用，不复制查询。

## API

| 方法 | 路径 | 权限 |
| --- | --- | --- |
| POST | `/api/activities/:id/publishing/stage-results/:stageKey/confirm` | `result.manage` |
| POST | `/api/activities/:id/publishing/stage-results/:stageKey/unlock` | `result.manage` |
| POST | `/api/activities/:id/publishing/releases` | `result.manage` |
| POST | `/api/activities/:id/publishing/releases/:releaseId/revoke` | `result.manage` |
| PATCH | `/api/activities/:id/publishing/publications/:stageKey` | `result.manage` |
| GET | `/api/activities/:id/publishing/state` | `result.manage` |
| GET | `/api/public/results/:publicCode?stage=` | 匿名 |

- 写命令必须带 `Idempotency-Key`；
- 公开读成功与 404 都带 `cache-control: no-store`；
- 公开读不需要身份；沿用现有 `MemoryRateLimiter` 做轻量限流，并在 README
  注明它只是单进程 IP bucket，生产多实例需要共享限流器。

## 错误码

新增：`RESULT_POST_FROZEN`、`RESULT_ALREADY_RELEASED`、
`RESULT_RELEASE_NOT_ACTIVE`、`RESULT_NOT_CONFIRMED`、`RESULT_CANDIDATE_HOLD`、
`AWARD_INVALID`。stale 复用 `STALE_RESOLUTION_INPUT`，权限复用
`FORBIDDEN`，未找到复用 `NOT_FOUND`。

## 测试计划

1. domain：compiler 接受/拒绝定义；award 校验；snapshot 生成后冻结。
2. db：`forUpdate` 行锁、ACTIVE 部分唯一索引、跨活动隔离、selector 排除
   revoked/superseded、不泄漏 fingerprint。
3. runtime：
   - golden 生命周期：confirm → release → edit 拒绝 → revoke → re-release →
     unlock；
   - 权限拒绝、stale candidate、重复 release、重复 revoke；
   - 双连接并发 release 同一 stage，只有一个成功；
   - audit/outbox/receipt 与事件一致。
4. API：匿名 selector 形状与 404；staff 路由 401/403；stale 409；
   公开响应无内部字段。
5. Golden adapter：`packages/runtime/test/golden-result-release-lifecycle.test.ts`
   消费 `tests/golden/result-release-lifecycle.json` 五步。
6. 门禁：`pnpm -C plus run check/test`（`REQUIRE_DB=1`）、
   `uv run pytest tests/gates -q`、golden validate、Django golden、ruff。

## 文档与验收

- `docs/artflow-plus/roadmap.md` 标记 M7a 完成与 M7b 待办；
- `plus/README.md` 增加 publishing 命令与公开出口；
- `docs/domains/results.md` 标注 Plus 实现状态；
- 新增 ADR：`docs/architecture/adr/0014-publishing-ownership.md`，记录
  “publishing 同时拥有核定与发布、runtime 提供 podium 候选输入”；
- `docs/invariants/` 引用 RESULT-01..04；不新增与现有 54 条冲突的规则。
