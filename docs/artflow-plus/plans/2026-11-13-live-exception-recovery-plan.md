# Live 异常恢复 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让组织者在 Live 页完成评分修正、平局裁决、晋级定稿、发布撤销/解锁，无需直接调 API。

**Architecture:** 新增一个按轮次读取评分事实的作用域读入口；扩展 `publishing/state` 与 `ranking` 的 Web 类型；在 Live 页增加 `LiveExceptionPanel`，把现有命令接上真实 revision/version。所有命令仍走原 runtime service 与单一写路径。

**Tech Stack:** TypeScript 7、Fastify 5、React 19、TanStack Query、PostgreSQL 18、Playwright、Vitest。

---

## File map

**Contracts / DB**

- Modify `plus/packages/contracts/src/competition.ts`：轮次评分事实的查询与响应 schema。
- Modify `plus/packages/contracts/src/index.ts`：导出新 schema。
- Modify `plus/packages/db/src/score-repository.ts`：`listLatestCorrectionsForScoreFacts`。
- Test `plus/packages/contracts/test/contracts.test.ts`、`plus/packages/db/test/score-repository.test.ts`。

**Runtime**

- Create `plus/packages/runtime/src/competition-read-service.ts`：轮次评分事实投影。
- Modify `plus/packages/runtime/src/index.ts`：导出。
- Modify `plus/packages/runtime/src/grouping-service.ts`：晋级决策指纹守卫。
- Create `plus/packages/runtime/test/helpers/recovery-fixture.ts`：从 `resolution-service.test.ts` 抽出的 `seedLockedRound`。
- Test `plus/packages/runtime/test/competition-read-service.test.ts`、`plus/packages/runtime/test/grouping-advancement-guard.test.ts`。

**API**

- Modify `plus/apps/api/src/app.ts`：新增 `"competition"` 读级别与权限分支。
- Modify `plus/apps/api/src/routes/competition.ts`：`GET .../rounds/:roundKey/scores`。
- Test `plus/apps/api/test/competition-read.test.ts`。

**Web**

- Modify `plus/apps/web/src/api/live.ts`：评分事实类型、查询与修正/平局/晋级包装函数。
- Modify `plus/apps/web/src/api/voting.ts`：`PublishingStateView.releases`、撤销/解锁包装函数。
- Modify `plus/apps/web/src/auth/SessionProvider.tsx`：`canManageCompetition`。
- Create `plus/apps/web/src/components/live/LiveExceptionPanel.tsx` 与 `.test.tsx`。
- Modify `plus/apps/web/src/components/live/ResultActions.tsx` 与新增 `.test.tsx`。
- Modify `plus/apps/web/src/components/ops/GroupingCard.tsx`、`plus/apps/web/src/api/grouping.ts`。
- Modify `plus/apps/web/src/routes/liveActivity.tsx`：渲染异常面板。
- Modify `plus/apps/web/src/styles/console-components.css`：异常面板布局。

**E2E**

- Create `plus/apps/api/scripts/seed-recovery.ts`，加入 `seed:e2e`。
- Create `plus/apps/web/e2e/recovery.spec.ts`。

---

## Test architecture

- **Contracts and capabilities touched**：只扩展 `competition` 的只读响应契约与 `publishing` 的既有读模型，
  不新增命令、事件、topic 或数据库迁移；修正、平局、晋级、发布仍走原 capability。
- **Consumers and read models**：消费者是 `LiveExceptionPanel`、`ResultActions`、`GroupingCard`。
  新读入口必须在 Consumer Graph 中产生 `consumes-route` 边；`publishing/state` 与 `ranking`
  只扩展现有消费者字段。
- **Lifecycle, terminal guards, and mode isolation**：修正要求 `scoring` 轮次、locked performance、
  运行中 session；`locked` 轮次先走 `reopen_correction`；`open → revised → closed → recalculated`
  各有前置；裁决会插入新 ranking snapshot；改分后必须重新 `resolve` 与重新定稿；发布撤销/解锁
  要求运行中的 publishing session；mode 由服务端 session 决定。
- **Adapters**：不新增 contract adapter；新读入口是页面集成 seam，使用真实 PostgreSQL 与真实 session，
  不 mock 仓储。
- **Fault and recovery cases**：覆盖 stale revision、重复开修正、未 revised 就关闭、未 closed 就重算、
  跨线平局未裁决就定稿、裁决后 revision 变化、撤销后重新发布、解锁自动 supersede release、
  改分后未重新排名、改分后未重新定稿、judge-only 读 403。
- **Why existing tests are insufficient**：现有测试只验证命令，没有页面消费者；`ui-gaps.json` 正因如此
  把这些入口列为不可达。新测试必须证明页面入口存在并能完成整个恢复流程。
- **Anti-bloat decision**：扩展现有 Live 组件与 runtime 读服务，不新建第二套评分业务层；读入口只做投影，
  不重新计算总分或排名。
- **Focused gates**：`pnpm -C plus --filter @artflow-plus/contracts test`、
  `pnpm -C plus --filter @artflow-plus/db test`、`pnpm -C plus --filter @artflow-plus/runtime test`、
  `pnpm -C plus --filter @artflow-plus/api test`、`pnpm -C plus --filter @artflow-plus/web test`、
  `pnpm -C plus run check`、`pnpm -C plus --filter @artflow-plus/contract-tools run graph:check`、
  `pnpm -C plus --filter @artflow-plus/contract-tools run audit:check`、`uv run pytest tests/gates -q`，
  以及 `pnpm -C plus --filter @artflow-plus/web exec playwright test e2e/recovery.spec.ts`。

---

## Task 1: 轮次评分事实契约与修正仓储

**Files:**
- Modify: `plus/packages/contracts/src/competition.ts`
- Modify: `plus/packages/contracts/src/index.ts`
- Modify: `plus/packages/db/src/score-repository.ts`
- Test: `plus/packages/contracts/test/contracts.test.ts`
- Test: `plus/packages/db/test/score-repository.test.ts`

- [ ] **Step 1: 写失败的契约测试**

在 `plus/packages/contracts/test/contracts.test.ts` 顶部已有的 `../src/index.js` import 清单里加入
`CompetitionRoundScoresQuerySchema`、`CompetitionRoundScoresResponseSchema`，然后在文件末尾追加：

```ts
it("validates the round scores read contract", () => {
  expect(Value.Check(CompetitionRoundScoresQuerySchema, { scope: "judging" })).toBe(true);
  expect(Value.Check(CompetitionRoundScoresQuerySchema, { scope: "judging", mode: "formal" })).toBe(false);
  expect(Value.Check(CompetitionRoundScoresResponseSchema, {
    round: { key: "final", state: "locked", revision: 2, scoreVersion: 3, advanceCount: 1 },
    session: { id: "session-1", mode: "formal", scope: "judging" },
    ranking: {
      id: "ranking-1",
      revision: 1,
      status: "hold",
      inputFingerprint: "fingerprint",
      rows: [{ contestantId: "singer-a", total: "90.00", judgeCount: 1 }],
      tieGroups: [{ id: "tie-1", total: "90.00", contestants: ["singer-a", "singer-b"] }],
    },
    advancement: null,
    performances: [{ id: "performance-1", contestantId: "singer-a", sequence: 1, state: "locked", contextVersion: 1 }],
    facts: [{
      id: "score-1",
      performanceId: "performance-1",
      contestantId: "singer-a",
      judgeId: "judge-1",
      seatId: "seat-1",
      source: "direct_judge",
      total: "90.00",
      criteria: { total: 90 },
      notes: "",
      version: 1,
      contextVersion: 1,
      panelSnapshotId: "panel-1",
      correction: null,
    }],
  })).toBe(true);
});
```

- [ ] **Step 2: 运行并确认失败**

Run: `pnpm -C plus --filter @artflow-plus/contracts test`
Expected: FAIL，`CompetitionRoundScoresQuerySchema` 未导出。

- [ ] **Step 3: 实现 schema**

在 `plus/packages/contracts/src/competition.ts` 追加：

```ts
export const RoundScoreCorrectionSchema = Type.Object({
  id: Type.String({ minLength: 1 }),
  state: Type.Union([
    Type.Literal("open"),
    Type.Literal("revised"),
    Type.Literal("closed"),
    Type.Literal("recalculated"),
  ]),
  baseVersion: Type.Integer({ minimum: 0 }),
  reason: Type.String(),
  revision: Type.Integer({ minimum: 0 }),
}, { additionalProperties: false });

export const RoundScoreFactSchema = Type.Object({
  id: Type.String({ minLength: 1 }),
  performanceId: Type.String({ minLength: 1 }),
  contestantId: Type.String({ minLength: 1 }),
  judgeId: Type.String({ minLength: 1 }),
  seatId: Type.String({ minLength: 1 }),
  source: Type.String({ minLength: 1 }),
  total: Type.String(),
  criteria: Type.Record(Type.String(), Type.Number()),
  notes: Type.String(),
  version: Type.Integer({ minimum: 0 }),
  contextVersion: Type.Integer({ minimum: 0 }),
  panelSnapshotId: Type.String({ minLength: 1 }),
  correction: Type.Union([RoundScoreCorrectionSchema, Type.Null()]),
}, { additionalProperties: false });

export const CompetitionRoundScoresQuerySchema = Type.Object({
  scope: ScopeSchema,
}, { additionalProperties: false });

export const CompetitionRoundScoresResponseSchema = Type.Object({
  round: Type.Object({
    key: Type.String(),
    state: Type.Union([
      Type.Literal("prepared"),
      Type.Literal("scoring"),
      Type.Literal("locked"),
      Type.Literal("resolved"),
    ]),
    revision: Type.Integer({ minimum: 0 }),
    scoreVersion: Type.Integer({ minimum: 0 }),
    advanceCount: Type.Integer({ minimum: 0 }),
  }, { additionalProperties: false }),
  session: Type.Union([
    Type.Object({
      id: Type.String(),
      mode: Type.Union([Type.Literal("test"), Type.Literal("rehearsal"), Type.Literal("formal")]),
      scope: Type.String(),
    }, { additionalProperties: false }),
    Type.Null(),
  ]),
  ranking: Type.Union([
    Type.Object({
      id: Type.String(),
      revision: Type.Integer({ minimum: 0 }),
      status: Type.Union([Type.Literal("ready"), Type.Literal("hold")]),
      inputFingerprint: Type.String(),
      rows: Type.Array(Type.Object({
        contestantId: Type.String(),
        total: Type.String(),
        judgeCount: Type.Integer({ minimum: 0 }),
      }, { additionalProperties: false })),
      tieGroups: Type.Array(Type.Object({
        id: Type.String(),
        total: Type.String(),
        contestants: Type.Array(Type.String()),
      }, { additionalProperties: false })),
    }, { additionalProperties: false }),
    Type.Null(),
  ]),
  advancement: Type.Union([
    Type.Object({
      id: Type.String(),
      revision: Type.Integer({ minimum: 0 }),
      status: Type.Union([Type.Literal("auto"), Type.Literal("needs_review")]),
      inputFingerprint: Type.String(),
      decisions: Type.Array(Type.Object({
        contestantId: Type.String(),
        advanced: Type.Boolean(),
      }, { additionalProperties: false })),
    }, { additionalProperties: false }),
    Type.Null(),
  ]),
  performances: Type.Array(Type.Object({
    id: Type.String(),
    contestantId: Type.String(),
    sequence: Type.Integer({ minimum: 1 }),
    state: Type.Union([Type.Literal("not_opened"), Type.Literal("open"), Type.Literal("locked")]),
    contextVersion: Type.Integer({ minimum: 0 }),
  }, { additionalProperties: false })),
  facts: Type.Array(RoundScoreFactSchema),
}, { additionalProperties: false });

export type CompetitionRoundScoresResponse = Static<typeof CompetitionRoundScoresResponseSchema>;
```

在 `plus/packages/contracts/src/index.ts` 的 competition 导出块加入上述四个名字。

- [ ] **Step 4: 运行契约测试**

Run: `pnpm -C plus --filter @artflow-plus/contracts test`
Expected: PASS。

- [ ] **Step 5: 写失败的仓储测试**

创建 `plus/packages/db/test/score-repository.test.ts`，复用 `runtime-repositories.test.ts` 的 schema/beforeAll 结构，追加：

```ts
import { listLatestCorrectionsForScoreFacts, insertCorrection } from "../src/index.js";

it("returns the latest correction per score fact", async () => {
  await insertCorrection(db, {
    id: "correction-1",
    scoreFactId: "score-1",
    inputFingerprint: "fp-1",
    state: "open",
    baseVersion: 1,
    reason: "第一次",
    revision: 0,
  });
  await insertCorrection(db, {
    id: "correction-2",
    scoreFactId: "score-1",
    inputFingerprint: "fp-2",
    state: "closed",
    baseVersion: 1,
    reason: "第二次",
    revision: 1,
  });
  const latest = await listLatestCorrectionsForScoreFacts(db, ["score-1", "score-2"]);
  expect(latest.get("score-1")?.id).toBe("correction-2");
  expect(latest.get("score-2")).toBeUndefined();
});
```

（`insertCorrection` 已从 `../src/index.js` 导出。）

- [ ] **Step 6: 运行并确认失败**

Run: `pnpm -C plus --filter @artflow-plus/db test -- score-repository`
Expected: FAIL，函数不存在。

- [ ] **Step 7: 实现仓储函数**

在 `plus/packages/db/src/score-repository.ts` 追加：

```ts
export async function listLatestCorrectionsForScoreFacts(
  db: Kysely<Database>,
  scoreFactIds: readonly string[],
): Promise<ReadonlyMap<string, StoredScoreCorrection>> {
  if (scoreFactIds.length === 0) return new Map();
  const rows = await db.selectFrom("score_correction").selectAll()
    .where("score_fact_id", "in", [...scoreFactIds])
    .orderBy("revision", "desc")
    .execute();
  const latest = new Map<string, StoredScoreCorrection>();
  for (const row of rows) {
    const value = correction(row);
    if (!latest.has(value.scoreFactId)) latest.set(value.scoreFactId, value);
  }
  return latest;
}
```

- [ ] **Step 8: 运行测试并提交**

Run:
```powershell
pnpm -C plus --filter @artflow-plus/contracts test
pnpm -C plus --filter @artflow-plus/db test -- score-repository
```
Expected: PASS。

```bash
git add plus/packages/contracts/src/competition.ts plus/packages/contracts/src/index.ts plus/packages/contracts/test/contracts.test.ts plus/packages/db/src/score-repository.ts plus/packages/db/test/score-repository.test.ts
git commit -m "feat(contracts): add the round scores read contract"
```

---

## Task 2: 运行时读服务与测试夹具

**Files:**
- Create: `plus/packages/runtime/src/competition-read-service.ts`
- Modify: `plus/packages/runtime/src/index.ts`
- Create: `plus/packages/runtime/test/helpers/recovery-fixture.ts`
- Modify: `plus/packages/runtime/test/resolution-service.test.ts`
- Test: `plus/packages/runtime/test/competition-read-service.test.ts`

- [ ] **Step 1: 抽出夹具**

把 `resolution-service.test.ts` 中的 `seedLockedRound`、`deps`、`staff`、`judge`、`tick` 移到
`plus/packages/runtime/test/helpers/recovery-fixture.ts`，导出：

```ts
export interface RecoveryFixture {
  readonly activityId: string;
  readonly roundId: string;
  readonly panelId: string;
  readonly seatId: string;
}

export function recoveryDeps(actor: ActorContext): RuntimeDeps;
export const recoveryStaff: ActorContext;
export const recoveryJudge: ActorContext;
export async function seedLockedRound(
  db: Kysely<Database>,
  mode?: "formal" | "rehearsal",
): Promise<RecoveryFixture>;
```

`resolution-service.test.ts` 改为导入这些导出，不改变任何断言。

Run: `pnpm -C plus --filter @artflow-plus/runtime test -- resolution-service`
Expected: 现有测试仍 PASS。

- [ ] **Step 2: 写失败的读服务测试**

创建 `plus/packages/runtime/test/competition-read-service.test.ts`：

```ts
import { closeDb, createDb, migrate } from "@artflow-plus/db";
import type { Database } from "@artflow-plus/db";
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import type { Kysely } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { getRoundScores } from "../src/index.js";
import { recoveryDeps, recoveryJudge, recoveryStaff, seedLockedRound } from "./helpers/recovery-fixture.js";

const connectionString = process.env.ARTFLOW_PLUS_DATABASE_URL;
const schema = `artflow_round_scores_${Date.now()}_${process.pid}`;
let db: Kysely<Database>;
let admin: Client;

describe.skipIf(!connectionString)("round scores read service", () => {
  beforeAll(async () => {
    admin = new Client({ connectionString }); await admin.connect();
    await admin.query(`CREATE SCHEMA "${schema}"`);
    db = createDb({ connectionString, schema }); await migrate(db);
  });
  afterAll(async () => {
    await closeDb(db); await admin.query(`DROP SCHEMA "${schema}" CASCADE`); await admin.end();
  });

  it("projects current score facts and the running session mode", async () => {
    const fixture = await seedLockedRound(db);
    const result = await getRoundScores(db, {
      activityId: fixture.activityId,
      roundId: fixture.roundId,
      scope: "judging",
    });
    expect(result.session).toMatchObject({ mode: "formal", scope: "judging" });
    expect(result.facts).toHaveLength(3);
    expect(result.facts[0]).toMatchObject({ seatId: fixture.seatId, version: 1, correction: null });
    expect(result.ranking).toMatchObject({ status: "hold" });
    expect(result.performances).toHaveLength(3);
  });

  it("returns an empty projection when no session is running", async () => {
    const fixture = await seedLockedRound(db);
    await db.updateTable("execution_session").set({ status: "closed" })
      .where("activity_id", "=", fixture.activityId).execute();
    const result = await getRoundScores(db, {
      activityId: fixture.activityId, roundId: fixture.roundId, scope: "judging",
    });
    expect(result.session).toBeNull();
    expect(result.facts).toEqual([]);
    expect(result.ranking).toBeNull();
  });
});
```

- [ ] **Step 3: 运行并确认失败**

Run: `pnpm -C plus --filter @artflow-plus/runtime test -- competition-read-service`
Expected: FAIL，`getRoundScores` 未导出。

- [ ] **Step 4: 实现读服务**

创建 `plus/packages/runtime/src/competition-read-service.ts`：

```ts
import {
  getActivity,
  getCurrentRankingSnapshot,
  getLatestAdvancementDecision,
  getRound,
  listCurrentScoreFacts,
  listLatestCorrectionsForScoreFacts,
  listRoundPerformances,
  listSessionRecords,
} from "@artflow-plus/db";
import type { Database } from "@artflow-plus/db";
import type { CompetitionRoundScoresResponse } from "@artflow-plus/contracts";
import { DomainError } from "@artflow-plus/domain";
import type { Kysely } from "kysely";

export interface RoundScoresInput {
  readonly activityId: string;
  readonly roundId: string;
  readonly scope: string;
}

export async function getRoundScores(
  db: Kysely<Database>,
  input: RoundScoresInput,
): Promise<CompetitionRoundScoresResponse> {
  if (input.scope !== "judging") {
    throw new DomainError("INVALID_INPUT", "Only the judging scope is supported.");
  }
  const activity = await getActivity(db, input.activityId);
  if (activity === null) throw new DomainError("NOT_FOUND", "The activity was not found.");
  const round = await getRound(db, input.roundId);
  if (round === null || round.activityId !== activity.id) {
    throw new DomainError("NOT_FOUND", "The competition round was not found.");
  }
  const session = (await listSessionRecords(db, activity.id))
    .find((item) => item.status === "running" && item.scope === input.scope) ?? null;
  const mode = session?.mode ?? null;
  const facts = mode === null ? [] : await listCurrentScoreFacts(db, round.id, mode);
  const corrections = await listLatestCorrectionsForScoreFacts(db, facts.map((fact) => fact.id));
  const ranking = mode === null ? null : await getCurrentRankingSnapshot(db, round.id, mode);
  const advancement = await getLatestAdvancementDecision(db, round.id);
  const performances = await listRoundPerformances(db, round.id);

  return {
    round: {
      key: round.key,
      state: round.state,
      revision: round.revision,
      scoreVersion: round.scoreVersion,
      advanceCount: round.advanceCount,
    },
    session: session === null ? null : { id: session.id, mode: session.mode, scope: session.scope },
    ranking: ranking === null ? null : {
      id: ranking.id,
      revision: ranking.revision,
      status: ranking.status,
      inputFingerprint: ranking.inputFingerprint,
      rows: (ranking.rows as { contestantId: string; total: string; judgeCount: number }[]),
      tieGroups: (ranking.tieGroups as { id: string; total: string; contestants: string[] }[]),
    },
    advancement: advancement === null ? null : {
      id: advancement.id,
      revision: advancement.revision,
      status: advancement.status,
      inputFingerprint: advancement.inputFingerprint,
      decisions: (advancement.decisions as { contestantId: string; advanced: boolean }[]),
    },
    performances: performances.map((item) => ({
      id: item.id,
      contestantId: item.contestantId,
      sequence: item.sequence,
      state: item.state,
      contextVersion: item.contextVersion,
    })),
    facts: facts.map((fact) => {
      const correction = corrections.get(fact.id);
      return {
        id: fact.id,
        performanceId: fact.performanceId,
        contestantId: fact.contestantId,
        judgeId: fact.judgeId,
        seatId: fact.seatId,
        source: fact.source,
        total: fact.total,
        criteria: fact.criteria,
        notes: fact.notes,
        version: fact.version,
        contextVersion: fact.contextVersion,
        panelSnapshotId: fact.panelSnapshotId,
        correction: correction === undefined ? null : {
          id: correction.id,
          state: correction.state,
          baseVersion: correction.baseVersion,
          reason: correction.reason,
          revision: correction.revision,
        },
      };
    }),
  };
}
```

在 `plus/packages/runtime/src/index.ts` 导出 `competition-read-service.js`。

- [ ] **Step 5: 运行读服务测试**

Run: `pnpm -C plus --filter @artflow-plus/runtime test -- competition-read-service`
Expected: PASS。

- [ ] **Step 6: 提交**

```bash
git add plus/packages/runtime/src/competition-read-service.ts plus/packages/runtime/src/index.ts plus/packages/runtime/test/helpers/recovery-fixture.ts plus/packages/runtime/test/competition-read-service.test.ts plus/packages/runtime/test/resolution-service.test.ts
git commit -m "feat(runtime): project round scores for the recovery panel"
```

---

## Task 3: API 访问级别与读路由

**Files:**
- Modify: `plus/apps/api/src/app.ts`
- Modify: `plus/apps/api/src/routes/competition.ts`
- Test: `plus/apps/api/test/competition-read.test.ts`

- [ ] **Step 1: 写失败的 API 测试**

创建 `plus/apps/api/test/competition-read.test.ts`，复用 `competition.test.ts` 的 buildApp/账号结构，
增加两个账号：`competition-reader`（`competition.manage`）与 `judge-only`（`judge.manage`）。
用 `seedLockedRound` 的前半段（活动、release、session、round、performance、score fact）准备数据，
然后断言：

```ts
dbIt("returns the round score projection to competition readers", async () => {
  const token = await bearer("competition-reader");
  const response = await app.inject({
    method: "GET",
    url: `/api/activities/${activityId}/competition/rounds/final/scores?scope=judging`,
    headers: { authorization: `Bearer ${token}` },
  });
  expect(response.statusCode).toBe(200);
  expect(response.json().facts).toHaveLength(3);
  expect(response.json().session.mode).toBe("formal");
});

dbIt("rejects judge-only readers", async () => {
  const token = await bearer("judge-only");
  const response = await app.inject({
    method: "GET",
    url: `/api/activities/${activityId}/competition/rounds/final/scores?scope=judging`,
    headers: { authorization: `Bearer ${token}` },
  });
  expect(response.statusCode).toBe(403);
});
```

- [ ] **Step 2: 运行并确认失败**

Run: `pnpm -C plus --filter @artflow-plus/api test -- competition-read`
Expected: FAIL，路由不存在或 404。

- [ ] **Step 3: 增加 `competition` 读级别**

在 `plus/apps/api/src/app.ts`：

```ts
type ReadAccess =
  | "public" | "session" | "operations" | "competition" | "analytics"
  | "studio" | "tasks" | "attendance" | "voting" | "result" | "archive";
```

在 `requireReadAccess` 的 `if (access === "studio")` 分支后加入：

```ts
if (access === "competition") {
  const actor = await requestActor(request);
  const allowed = ["competition.manage", "competition.score.write", "studio.manage"];
  if (!allowed.some((permission) => hasPermission(actor, permission))) {
    throw new DomainError("FORBIDDEN", "A competition read permission is required.");
  }
  return;
}
```

- [ ] **Step 4: 增加读路由**

在 `plus/apps/api/src/routes/competition.ts` 的 ranking route 后加入：

```ts
app.get(
  "/api/activities/:id/competition/rounds/:roundKey/scores",
  {
    schema: {
      params: RoundParams,
      querystring: CompetitionRoundScoresQuerySchema,
      response: { 200: CompetitionRoundScoresResponseSchema },
    },
    config: { access: "competition" },
  },
  async (request) => {
    const { id, roundKey } = request.params as { id: string; roundKey: string };
    const { scope } = request.query as { scope: string };
    const round = await routeRound(id, roundKey);
    return getRoundScores(db, { activityId: id, roundId: round.id, scope });
  },
);
```

补充 import：`CompetitionRoundScoresQuerySchema`、`CompetitionRoundScoresResponseSchema`、
`getRoundScores`。

- [ ] **Step 5: 运行 API 测试**

Run: `pnpm -C plus --filter @artflow-plus/api test -- competition-read`
Expected: PASS。

- [ ] **Step 6: 提交**

```bash
git add plus/apps/api/src/app.ts plus/apps/api/src/routes/competition.ts plus/apps/api/test/competition-read.test.ts
git commit -m "feat(api): expose the round score projection to competition readers"
```

---

## Task 4: Web 类型与包装函数

**Files:**
- Modify: `plus/apps/web/src/api/live.ts`
- Modify: `plus/apps/web/src/api/voting.ts`
- Test: `plus/apps/web/src/api/live.test.ts`
- Test: `plus/apps/web/src/api/voting.test.ts`

- [ ] **Step 1: 写失败的路径测试**

在 `plus/apps/web/src/api/live.test.ts` 追加：

```ts
it("builds the recovery command paths", async () => {
  const fetchMock = vi.fn(async () => new Response(JSON.stringify({}), { status: 200 }));
  vi.stubGlobal("fetch", fetchMock);
  await openScoreCorrection("act-1", "final", {
    performanceId: "performance-1",
    scoreFactId: "score-1",
    panelSnapshotId: "panel-1",
    reason: "record error",
  });
  expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/activities/act-1/competition/rounds/final/scores/score-1/corrections");
  await decideTie("act-1", "final", {
    tieId: "tie-1",
    rankingSnapshotId: "ranking-1",
    inputFingerprint: "fp",
    contestants: ["a", "b"],
    order: ["b", "a"],
    reason: "现场裁决",
  });
  expect(fetchMock.mock.calls[1]?.[0]).toBe("/api/activities/act-1/competition/rounds/final/ties/tie-1/decide");
});
```

在 `plus/apps/web/src/api/voting.test.ts` 追加撤销/解锁路径断言：

```ts
expect(path).toBe("/api/activities/act-1/publishing/releases/release-1/revoke");
expect(path).toBe("/api/activities/act-1/publishing/stage-results/final/unlock");
```

- [ ] **Step 2: 运行并确认失败**

Run: `pnpm -C plus --filter @artflow-plus/web test -- api/live api/voting`
Expected: FAIL，函数未导出。

- [ ] **Step 3: 实现类型与包装函数**

`plus/apps/web/src/api/live.ts` 追加：

```ts
export interface RoundScoresResponse {
  readonly round: { key: string; state: string; revision: number; scoreVersion: number; advanceCount: number };
  readonly session: { id: string; mode: "test" | "rehearsal" | "formal"; scope: string } | null;
  readonly ranking: {
    id: string; revision: number; status: "ready" | "hold"; inputFingerprint: string;
    rows: readonly { contestantId: string; total: string; judgeCount: number }[];
    tieGroups: readonly { id: string; total: string; contestants: readonly string[] }[];
  } | null;
  readonly advancement: {
    id: string; revision: number; status: "auto" | "needs_review"; inputFingerprint: string;
    decisions: readonly { contestantId: string; advanced: boolean }[];
  } | null;
  readonly performances: readonly { id: string; contestantId: string; sequence: number; state: string; contextVersion: number }[];
  readonly facts: readonly {
    id: string; performanceId: string; contestantId: string; judgeId: string; seatId: string;
    source: string; total: string; criteria: Readonly<Record<string, number>>; notes: string;
    version: number; contextVersion: number; panelSnapshotId: string;
    correction: { id: string; state: "open" | "revised" | "closed" | "recalculated"; baseVersion: number; reason: string; revision: number } | null;
  }[];
}

export function fetchRoundScores(activityId: string, roundKey: string): Promise<RoundScoresResponse> {
  return apiFetch(`/api/activities/${activityId}/competition/rounds/${roundKey}/scores?scope=${JUDGING_SCOPE}`);
}

export function openScoreCorrection(
  activityId: string,
  roundKey: string,
  input: { performanceId: string; scoreFactId: string; panelSnapshotId: string; reason: string },
): Promise<unknown> {
  return apiFetch(`/api/activities/${activityId}/competition/rounds/${roundKey}/scores/${input.scoreFactId}/corrections`, {
    method: "POST",
    headers: commandHeaders(crypto.randomUUID()),
    body: JSON.stringify({ scope: JUDGING_SCOPE, performanceId: input.performanceId, panelSnapshotId: input.panelSnapshotId, reason: input.reason }),
  });
}

export function editScoreFact(
  activityId: string,
  roundKey: string,
  input: {
    scoreFactId: string; performanceId: string; panelSnapshotId: string; seatId: string;
    contextVersion: number; expectedVersion: number; criteria: Record<string, number>;
    reason: string; correctionId: string;
  },
): Promise<unknown> {
  return apiFetch(`/api/activities/${activityId}/competition/rounds/${roundKey}/scores/${input.scoreFactId}`, {
    method: "PATCH",
    headers: commandHeaders(crypto.randomUUID()),
    body: JSON.stringify({
      scope: JUDGING_SCOPE, performanceId: input.performanceId, panelSnapshotId: input.panelSnapshotId,
      seatId: input.seatId, contextVersion: input.contextVersion, expectedVersion: input.expectedVersion,
      criteria: input.criteria, reason: input.reason, correctionId: input.correctionId,
    }),
  });
}

export function closeScoreCorrection(
  activityId: string,
  roundKey: string,
  input: { scoreFactId: string; correctionId: string; panelSnapshotId: string; performanceId: string },
): Promise<unknown> {
  return apiFetch(`/api/activities/${activityId}/competition/rounds/${roundKey}/scores/${input.scoreFactId}/corrections/${input.correctionId}/close`, {
    method: "POST",
    headers: commandHeaders(crypto.randomUUID()),
    body: JSON.stringify({ scope: JUDGING_SCOPE, panelSnapshotId: input.panelSnapshotId, performanceId: input.performanceId }),
  });
}

export function recalculateAfterCorrection(
  activityId: string,
  roundKey: string,
  input: { scoreFactId: string; correctionId: string; panelSnapshotId: string; performanceId: string },
): Promise<unknown> {
  return apiFetch(`/api/activities/${activityId}/competition/rounds/${roundKey}/scores/${input.scoreFactId}/corrections/${input.correctionId}/recalculate`, {
    method: "POST",
    headers: commandHeaders(crypto.randomUUID()),
    body: JSON.stringify({ scope: JUDGING_SCOPE, panelSnapshotId: input.panelSnapshotId, performanceId: input.performanceId }),
  });
}

export function decideTie(
  activityId: string,
  roundKey: string,
  input: { tieId: string; rankingSnapshotId: string; inputFingerprint: string; contestants: readonly string[]; order: readonly string[]; reason: string },
): Promise<unknown> {
  return apiFetch(`/api/activities/${activityId}/competition/rounds/${roundKey}/ties/${input.tieId}/decide`, {
    method: "POST",
    headers: commandHeaders(crypto.randomUUID()),
    body: JSON.stringify({
      scope: JUDGING_SCOPE, rankingSnapshotId: input.rankingSnapshotId, inputFingerprint: input.inputFingerprint,
      contestants: input.contestants, order: input.order, reason: input.reason,
    }),
  });
}

export function finalizeAdvancement(
  activityId: string,
  roundKey: string,
  expectedRankingRevision: number,
): Promise<unknown> {
  return apiFetch(`/api/activities/${activityId}/competition/rounds/${roundKey}/advancement/finalize`, {
    method: "POST",
    headers: commandHeaders(crypto.randomUUID()),
    body: JSON.stringify({ scope: JUDGING_SCOPE, expectedRankingRevision }),
  });
}
```

`plus/apps/web/src/api/voting.ts` 扩展 `PublishingStateView`：

```ts
readonly releases: readonly {
  readonly id: string;
  readonly stageKey: string;
  readonly status: "active" | "revoked" | "superseded";
  readonly note: string;
  readonly releasedAt: string;
  readonly revokedAt?: string;
}[];
```

并追加：

```ts
export async function revokeResultRelease(activityId: string, releaseId: string, note: string): Promise<unknown> {
  return apiFetch(`/api/activities/${activityId}/publishing/releases/${releaseId}/revoke`, {
    method: "POST",
    headers: { "idempotency-key": commandId("publish-revoke") },
    body: JSON.stringify({ scope: "publishing", note }),
  });
}

export async function unlockStageResult(
  activityId: string, stageKey: string, expectedCandidateRevision: number, note: string,
): Promise<unknown> {
  return apiFetch(`/api/activities/${activityId}/publishing/stage-results/${stageKey}/unlock`, {
    method: "POST",
    headers: { "idempotency-key": commandId("publish-unlock") },
    body: JSON.stringify({ scope: "publishing", expectedCandidateRevision, note }),
  });
}
```

- [ ] **Step 4: 运行测试并提交**

Run: `pnpm -C plus --filter @artflow-plus/web test -- api/live api/voting`
Expected: PASS。

```bash
git add plus/apps/web/src/api/live.ts plus/apps/web/src/api/voting.ts plus/apps/web/src/api/live.test.ts plus/apps/web/src/api/voting.test.ts
git commit -m "feat(web): wire the recovery command clients"
```

---

## Task 5: ResultActions 撤销与解锁

**Files:**
- Modify: `plus/apps/web/src/components/live/ResultActions.tsx`
- Test: `plus/apps/web/src/components/live/ResultActions.test.tsx`

- [ ] **Step 1: 写失败测试**

```tsx
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

vi.mock("../../api/voting.js", async () => {
  const actual = await vi.importActual<typeof import("../../api/voting.js")>("../../api/voting.js");
  return {
    ...actual,
    fetchPublishingState: vi.fn(async () => ({
      stages: [{ key: "final", label: "决赛" }],
      podiumCandidate: null,
      stageResults: [{ stageKey: "final", status: "confirmed", candidateRevision: 3, inputFingerprint: "fp" }],
      releases: [{ id: "release-1", stageKey: "final", status: "active", note: "初始发布", releasedAt: "2026-11-13T10:00:00Z" }],
    })),
    fetchExecutions: vi.fn(async () => [{
      id: "publishing-session-1", activityId: "act-1", definitionVersion: 1, contentHash: "hash",
      scope: "publishing", mode: "formal", status: "running", revision: 0, openedAt: "2026-11-13T10:00:00Z",
    }]),
    revokeResultRelease: vi.fn(async () => ({})),
    unlockStageResult: vi.fn(async () => ({})),
  };
});

it("shows revoke for an active release and unlocks a confirmed stage", async () => {
  render(<ResultActions activityId="act-1" state={state} onChanged={() => {}} />);
  await userEvent.type(screen.getByLabelText("发布 / 归档说明"), "现场撤回");
  await userEvent.click(await screen.findByRole("button", { name: "撤销发布" }));
  await userEvent.click(screen.getByRole("button", { name: "解锁赛果" }));
  expect(revokeResultRelease).toHaveBeenCalledWith("act-1", "release-1", "现场撤回");
  expect(unlockStageResult).toHaveBeenCalledWith("act-1", "final", 3, "现场撤回");
});
```

`state` 复用 `LiveRoundPanel.test.tsx` 的 `LiveState` 夹具，把 `session` 设为
`{ id: "session-1", activityId: "act-1", definitionVersion: 1, contentHash: "hash",
scope: "publishing", mode: "formal", status: "running", revision: 0,
openedAt: "2026-11-13T10:00:00Z" }`，
并把 `activity.enabledCapabilities` 设为 `["competition", "publishing"]`。

- [ ] **Step 2: 运行并确认失败**

Run: `pnpm -C plus --filter @artflow-plus/web test -- ResultActions`
Expected: FAIL，按钮不存在。

- [ ] **Step 3: 实现**

在 `ResultActions.tsx` 的 mutation 区加入：

```tsx
const stageResult = publishing.data?.stageResults.find((item) => item.stageKey === stageKey);
const effectiveConfirmedRevision =
  confirmedRevision ?? (stageResult?.status === "confirmed" ? stageResult.candidateRevision : undefined);

const revoke = useMutation({
  mutationFn: (releaseId: string) => revokeResultRelease(activityId, releaseId, note.trim()),
  onSuccess: () => { void queryClient.invalidateQueries({ queryKey: ["live-publishing", activityId] }); onChanged(); },
});
const unlock = useMutation({
  mutationFn: (revision: number) => unlockStageResult(activityId, stageKey!, revision, note.trim()),
  onSuccess: () => {
    setConfirmedRevision(undefined);
    void queryClient.invalidateQueries({ queryKey: ["live-publishing", activityId] });
    onChanged();
  },
});
```

同时把 `release` mutation 与发布按钮里的 `confirmedRevision` 全部替换为
`effectiveConfirmedRevision`，这样刷新页面后仍能对已确认的赛段重新发布（撤销后不需要再点一次确认）。

在按钮区加入：

```tsx
{publishing.data?.releases.map((release) => (
  <span key={release.id} data-testid="release-status" data-stage={release.stageKey}>
    {release.status}
  </span>
))}
{publishing.data?.releases.filter((release) => release.status === "active").map((release) => (
  <Button key={release.id} variant="secondary"
    disabled={busy || note.trim() === ""}
    onClick={() => revoke.mutate(release.id)}>
    撤销发布
  </Button>
))}
{stageResult?.status === "confirmed" ? (
  <Button variant="secondary" disabled={busy || note.trim() === ""  || publishingSession === undefined}
    onClick={() => unlock.mutate(stageResult.candidateRevision)}>
    解锁赛果
  </Button>
) : null}
```

`stageResult` 从 `publishing.data?.stageResults.find((item) => item.stageKey === stageKey)` 取；
错误合并进现有 `error` 展示。

- [ ] **Step 4: 运行测试并提交**

Run: `pnpm -C plus --filter @artflow-plus/web test -- ResultActions`
Expected: PASS。

```bash
git add plus/apps/web/src/components/live/ResultActions.tsx plus/apps/web/src/components/live/ResultActions.test.tsx
git commit -m "feat(web): add publishing revoke and unlock actions"
```

---

## Task 6: LiveExceptionPanel 评分修正

**Files:**
- Create: `plus/apps/web/src/components/live/LiveExceptionPanel.tsx`
- Test: `plus/apps/web/src/components/live/LiveExceptionPanel.test.tsx`
- Modify: `plus/apps/web/src/routes/liveActivity.tsx`
- Modify: `plus/apps/web/src/auth/SessionProvider.tsx`
- Modify: `plus/apps/web/src/styles/console-components.css`

- [ ] **Step 1: 写失败测试**

```tsx
vi.mock("../../api/live.js", () => ({
  fetchRoundScores: vi.fn(),
  openScoreCorrection: vi.fn(async () => ({})),
  editScoreFact: vi.fn(async () => ({})),
  closeScoreCorrection: vi.fn(async () => ({})),
  recalculateAfterCorrection: vi.fn(async () => ({})),
  decideTie: vi.fn(),
  finalizeAdvancement: vi.fn(),
  describeLiveError: vi.fn((_error: unknown, fallback: string) => fallback),
}));

it("walks open -> revised -> closed -> recalculated", async () => {
  render(<LiveExceptionPanel activityId="act-1" live={live} state={state} onChanged={() => {}} />);
  await userEvent.click(screen.getByRole("button", { name: "开修正" }));
  await userEvent.type(screen.getByLabelText("修正原因"), "看错分");
  await userEvent.click(screen.getByRole("button", { name: "确认开修正" }));
  expect(openScoreCorrection).toHaveBeenCalled();
  await userEvent.clear(screen.getByLabelText("total"));
  await userEvent.type(screen.getByLabelText("total"), "95");
  await userEvent.click(screen.getByRole("button", { name: "保存修正" }));
  expect(editScoreFact).toHaveBeenCalledWith("act-1", "final", expect.objectContaining({ criteria: { total: 95 }, correctionId: "correction-1" }));
});
```

`state`/`live` 复用 `LiveRoundPanel.test.tsx` 的夹具；`fetchRoundScores` mock 返回一条 `correction: null` 的 fact。

- [ ] **Step 2: 运行并确认失败**

Run: `pnpm -C plus --filter @artflow-plus/web test -- LiveExceptionPanel`
Expected: FAIL，组件不存在。

- [ ] **Step 3: 实现组件**

创建 `plus/apps/web/src/components/live/LiveExceptionPanel.tsx`，结构：

```tsx
export function LiveExceptionPanel({ activityId, live, state, onChanged }: Props) {
  const query = useQuery({
    queryKey: ["round-scores", activityId, live.config.key, live.round?.revision],
    queryFn: () => fetchRoundScores(activityId, live.config.key),
    enabled: live.round !== null,
  });
  const [feedback, setFeedback] = useState<string | null>(null);
  const [openFact, setOpenFact] = useState<string | null>(null);
  const [reason, setReason] = useState("");
  const [criteria, setCriteria] = useState<Record<string, number>>({});
  const facts = query.data?.facts ?? [];
  // mutations: open / edit / close / recalculate, each onSuccess -> refetch + onChanged + feedback
  // render:
  // - blocking reason when round.state === "locked" or query.data?.session === null
  // - grouped facts; each row shows contestant, seat, source, total, correction state
  //   and carries data-testid={`score-fact-${fact.contestantId}`}
  // - buttons by correction state
  // - after recalculate: <p role="status">重算完成，请点击“生成排名”更新排名。</p>
}
```

具体控件：

- `开修正` 打开内联 reason 输入；`确认开修正` 调 `openScoreCorrection`。
- `correction.state === "open"` 时渲染 rubric 输入（label 为 criterion.key），`保存修正` 调
  `editScoreFact`，发送完整 criteria。
- `correction.state === "revised"` 时 `关闭修正` 调 `closeScoreCorrection`。
- `correction.state === "closed"` 时 `重算` 调 `recalculateAfterCorrection`。
- `correction.state === "recalculated"` 显示 `已重算`，无按钮。
- 所有 mutation 的错误用 `describeLiveError(error, fallback)` 显示；`RESULT_CONSUMED`
  提示“先解锁赛果”，`SESSION_NOT_RUNNING` 提示“先启动会话”，`STALE_REVISION`
  提示“数据已变化，请刷新后重试”。

在 `SessionProvider.tsx` 增加：

```ts
export function canManageCompetition(session: SessionResponse | null): boolean {
  if (session === null) return false;
  const { permissions } = session.actor;
  return permissions.includes("*") ||
    permissions.includes("competition.manage") ||
    permissions.includes("competition.score.write");
}
```

在 `liveActivity.tsx` 的 `LiveRoundPanel` 后渲染：

```tsx
{canManageCompetition(session) ? (
  <LiveExceptionPanel activityId={activityId} live={live} state={state} onChanged={refresh} />
) : null}
```

在 `console-components.css` 末尾加入最小布局：

```css
.live-exception-panel { display: grid; gap: 12px; }
.live-exception-fact { display: grid; gap: 8px; padding: 12px; border-bottom: 1px solid var(--color-line); }
.live-exception-actions { display: flex; flex-wrap: wrap; gap: 8px; }
.live-exception-criteria { display: grid; grid-template-columns: repeat(auto-fit, minmax(120px, 1fr)); gap: 8px; }
```

- [ ] **Step 4: 运行测试并提交**

Run: `pnpm -C plus --filter @artflow-plus/web test -- LiveExceptionPanel`
Expected: PASS。

```bash
git add plus/apps/web/src/components/live/LiveExceptionPanel.tsx plus/apps/web/src/components/live/LiveExceptionPanel.test.tsx plus/apps/web/src/routes/liveActivity.tsx plus/apps/web/src/auth/SessionProvider.tsx plus/apps/web/src/styles/console-components.css
git commit -m "feat(web): add the score correction panel"
```

---

## Task 7: 平局、晋级与分组来源

**Files:**
- Modify: `plus/apps/web/src/components/live/LiveExceptionPanel.tsx`
- Modify: `plus/apps/web/src/components/ops/GroupingCard.tsx`
- Modify: `plus/apps/web/src/api/grouping.ts`
- Modify: `plus/packages/runtime/src/grouping-service.ts`
- Test: `plus/apps/web/src/components/live/LiveExceptionPanel.test.tsx`
- Test: `plus/packages/runtime/test/grouping-advancement-guard.test.ts`

- [ ] **Step 1: 写失败的运行时守卫测试**

在 `grouping-advancement-guard.test.ts` 使用 `seedLockedRound`、`resolveRound`、`recordTieDecision`、
`finalizeAdvancement`、`getRoundScores`、修正命令与 `createGroupingStage`：

```ts
it("rejects a stale advancement decision", async () => {
  const fixture = await seedLockedRound(db);
  const ranking = await resolveRound(db, recoveryDeps(recoveryStaff), {
    commandId: `resolve-${fixture.activityId}`, activityId: fixture.activityId,
    roundId: fixture.roundId, scope: "judging",
  });
  const tie = (ranking.body.tieGroups as { id: string; contestants: string[] }[])[0]!;
  const decided = await recordTieDecision(db, recoveryDeps(recoveryStaff), {
    commandId: `tie-${fixture.activityId}`, activityId: fixture.activityId, roundId: fixture.roundId,
    rankingSnapshotId: ranking.body.id, tieId: tie.id, inputFingerprint: ranking.body.inputFingerprint,
    contestants: tie.contestants, order: [...tie.contestants].reverse(), reason: "现场裁决", scope: "judging",
  });
  const finalized = await finalizeAdvancement(db, recoveryDeps(recoveryStaff), {
    commandId: `advance-${fixture.activityId}`, activityId: fixture.activityId,
    roundId: fixture.roundId, expectedRankingRevision: decided.body.revision, scope: "judging",
  });
  expect(finalized.body.status).toBe("auto");

  const before = await getRoundScores(db, {
    activityId: fixture.activityId, roundId: fixture.roundId, scope: "judging",
  });
  const fact = before.facts[0]!;
  const roundRow = await db.selectFrom("competition_round").selectAll()
    .where("id", "=", fixture.roundId).executeTakeFirstOrThrow();
  await reopenRoundForCorrection(db, recoveryDeps(recoveryStaff), {
    commandId: `reopen-${fixture.activityId}`, activityId: fixture.activityId,
    roundId: fixture.roundId, expectedRevision: roundRow.revision, reason: "改分", scope: "judging",
  });
  const opened = await openScoreCorrection(db, recoveryDeps(recoveryStaff), {
    commandId: `open-${fixture.activityId}`, activityId: fixture.activityId, roundId: fixture.roundId,
    performanceId: fact.performanceId, scoreFactId: fact.id, panelSnapshotId: fact.panelSnapshotId,
    reason: "看错分", scope: "judging",
  });
  await editScoreFact(db, recoveryDeps(recoveryStaff), {
    commandId: `edit-${fixture.activityId}`, activityId: fixture.activityId, roundId: fixture.roundId,
    performanceId: fact.performanceId, scoreFactId: fact.id, panelSnapshotId: fact.panelSnapshotId,
    seatId: fact.seatId, contextVersion: fact.contextVersion, expectedVersion: fact.version,
    criteria: { total: 95 }, reason: "看错分", correctionId: opened.body.id, scope: "judging",
  });
  await closeScoreCorrection(db, recoveryDeps(recoveryStaff), {
    commandId: `close-${fixture.activityId}`, activityId: fixture.activityId, roundId: fixture.roundId,
    performanceId: fact.performanceId, scoreFactId: fact.id, correctionId: opened.body.id,
    panelSnapshotId: fact.panelSnapshotId, scope: "judging",
  });
  await recalculateAfterCorrection(db, recoveryDeps(recoveryStaff), {
    commandId: `recalc-${fixture.activityId}`, activityId: fixture.activityId, roundId: fixture.roundId,
    performanceId: fact.performanceId, scoreFactId: fact.id, correctionId: opened.body.id,
    panelSnapshotId: fact.panelSnapshotId, scope: "judging",
  });
  await resolveRound(db, recoveryDeps(recoveryStaff), {
    commandId: `resolve-again-${fixture.activityId}`, activityId: fixture.activityId,
    roundId: fixture.roundId, scope: "judging",
  });

  await expect(createGroupingStage(db, recoveryDeps(recoveryStaff), {
    commandId: `grouping-stale-${fixture.activityId}`, activityId: fixture.activityId,
    stageKey: "next", name: "下一阶段", rosterSource: "round_advanced",
    sourceRoundId: fixture.roundId, scope: "grouping",
  })).rejects.toMatchObject({ code: "STALE_ADVANCEMENT" });
});
```

`recoveryStaff` 的 permissions 需包含 `grouping.manage`（在夹具里加上）。

- [ ] **Step 2: 运行并确认失败**

Run: `pnpm -C plus --filter @artflow-plus/runtime test -- grouping-advancement-guard`
Expected: FAIL，第二个 `createGroupingStage` 成功或抛其他错误。

- [ ] **Step 3: 实现分组守卫**

先在 `plus/packages/db/src/score-repository.ts` 增加按指纹找快照：

```ts
export async function getRankingSnapshotByFingerprint(
  db: Kysely<Database>,
  roundId: string,
  inputFingerprint: string,
): Promise<StoredRankingSnapshot | null> {
  const row = await db.selectFrom("ranking_snapshot").selectAll()
    .where("round_id", "=", roundId)
    .where("input_fingerprint", "=", inputFingerprint)
    .orderBy("revision", "desc")
    .executeTakeFirst();
  return row === undefined ? null : ranking(row);
}
```

在 `grouping-service.ts` 的 `resolveRosterSource`（`decision === null || decision.status !== "auto"` 之后）加入：

```ts
const sourceRanking = await getRankingSnapshotByFingerprint(trx, round.id, decision.inputFingerprint);
if (sourceRanking === null) {
  throw new DomainError("STALE_ADVANCEMENT", "The advancement decision no longer matches a ranking.");
}
const currentRanking = await getCurrentRankingSnapshot(trx, round.id, sourceRanking.mode);
if (currentRanking === null || currentRanking.inputFingerprint !== decision.inputFingerprint) {
  throw new DomainError("STALE_ADVANCEMENT", "The advancement decision no longer matches the current ranking.");
}
```

补充 import `getCurrentRankingSnapshot`、`getRankingSnapshotByFingerprint`。

- [ ] **Step 4: 写失败的面板 tie/advancement 测试**

在 `LiveExceptionPanel.test.tsx` 追加：

```tsx
it("records a tie decision and then finalizes advancement with the new revision", async () => {
  render(<LiveExceptionPanel activityId="act-1" live={liveWithTie} state={stateWithTie} onChanged={() => {}} />);
  await userEvent.click(screen.getByRole("button", { name: "记录裁决" }));
  expect(decideTie).toHaveBeenCalledWith("act-1", "final", expect.objectContaining({
    rankingSnapshotId: "ranking-1", contestants: ["singer-a", "singer-b"], order: ["singer-b", "singer-a"],
  }));
  await userEvent.click(screen.getByRole("button", { name: "晋级定稿" }));
  expect(finalizeAdvancement).toHaveBeenCalledWith("act-1", "final", 2);
});
```

- [ ] **Step 5: 实现面板 tie/advancement 区域**

- 从 `query.data.ranking` 取 `rows`、`status`、`tieGroups`（二者都已在
  `RoundScoresResponse.ranking` 中）。
- 计算跨线组：

```ts
const crossing = (ranking?.tieGroups ?? []).filter((group) => {
  const start = ranking!.rows.findIndex((row) => group.contestants.includes(row.contestantId));
  return start >= 0 && start < advanceCount && start + group.contestants.length > advanceCount;
});
```

- 每个组维护 `order` 状态；上下移动按钮 `上移`/`下移`；`记录裁决` 调 `decideTie`，
  成功后 `query.refetch()` 与 `onChanged()`。
- `晋级定稿` 仅在 `crossing.length === 0 && ranking?.status === "ready"` 且
  `advancement?.status !== "auto" || advancement.inputFingerprint !== ranking.inputFingerprint` 时启用；
  调 `finalizeAdvancement(activityId, live.config.key, ranking.revision)`。
- 过期提示：`advancement && ranking && advancement.inputFingerprint !== ranking.inputFingerprint`
  → `<p role="alert">晋级名单已过期，请重新定稿。</p>`。

- [ ] **Step 6: 扩展 GroupingCard**

`plus/apps/web/src/api/grouping.ts` 的 `createGroupingStage` input 增加 `sourceRoundId?: string`，
请求体透传。`GroupingCard.tsx`：

```tsx
const [rosterSource, setRosterSource] = useState<"all_approved" | "round_advanced">("all_approved");
const [sourceRoundId, setSourceRoundId] = useState("");
const live = useQuery({ queryKey: ["live-state", props.activityId], queryFn: () => fetchLiveState(props.activityId), retry: false });
```

创建表单加入两个 `Select`：`名单来源`（全部通过 / 晋级名单）、`来源轮次`
（`live.data?.config.rounds.map(round => round.key)`）。`create.mutate` 携带
`rosterSource` 与 `sourceRoundId`（仅 round_advanced 时）。

- [ ] **Step 7: 运行测试并提交**

Run:
```powershell
pnpm -C plus --filter @artflow-plus/runtime test -- grouping-advancement-guard
pnpm -C plus --filter @artflow-plus/web test -- LiveExceptionPanel
```
Expected: PASS。

```bash
git add plus/packages/runtime/src/grouping-service.ts plus/packages/runtime/test/grouping-advancement-guard.test.ts plus/apps/web/src/components/live/LiveExceptionPanel.tsx plus/apps/web/src/components/live/LiveExceptionPanel.test.tsx plus/apps/web/src/components/ops/GroupingCard.tsx plus/apps/web/src/api/grouping.ts
git commit -m "feat: add tie, advancement, and grouping source recovery"
```

---

## Task 8: E2E 种子、恢复旅程与全量门禁

**Files:**
- Create: `plus/apps/api/scripts/seed-recovery.ts`
- Modify: `plus/apps/api/package.json`
- Create: `plus/apps/web/e2e/recovery.spec.ts`

- [ ] **Step 1: 写种子**

`seed-recovery.ts` 结构：

1. 复用 `seed-registration.ts` 的 schema/account 创建方式（`e2e-ops` 已存在）。
2. 插入 activity `act_e2e_recovery`，公开码 `E2E-RECOVERY`，capabilities
   `["competition", "publishing"]`，status `active`。
3. `insertRelease` 的 capabilities：
   - `competition` artifact 复制 `seed-live.ts` 的 `competition`（roundKey `final`，`advanceCount: 1`，
     rubric 一个 `total` criterion）。
   - `publishing` artifact：`{ version: 1, schemaVersion: 1, stages: [{ key: "final", label: "决赛" }] }`。
   - executionPolicy 的 `commandScopes` 使用 `COMPETITION_COMMAND_SCOPES` + publishing scope。
4. 插入 3 个 approved registration（`singer-a`、`singer-b`、`singer-c`）与 final roster。
5. 调用 runtime 命令跑完到 locked + resolve（复制 `seedLockedRound` 的流程），使用：

```ts
import type { ActorContext } from "@artflow-plus/domain";
import type { RuntimeDeps } from "@artflow-plus/runtime";

const actor: ActorContext = {
  actorId: "e2e-ops", actorType: "user", roles: ["admin"], permissions: ["*"],
};
const deps: RuntimeDeps = {
  actor, now: () => new Date().toISOString(), newEventId: () => crypto.randomUUID(),
};
```

具体命令：
   - `prepareCompetitionRound`、`activateCompetitionPanel`、`openPerformance`、`submitJudgeScore`
     （a/b 都是 90，c 是 80）、`lockPerformance`、`lockRound`、`resolveRound`。
   - 结果应为 `hold`，带一个跨线平局组。
6. 直接插入已确认赛果与 active release（模拟“已发布后发现问题”）：
   - `insertStageResult`（`stageKey: "final"`，`status: "confirmed"`，`candidateRevision: 3`，
     decisions 为 a/b/c，awards 空）。
   - `insertResultPublication`、`insertResultRelease`（`status: "active"`）。
7. 保留 running 的 judging 与 publishing session（`insertSession`），供 UI 直接操作：

```ts
await insertSession(db, {
  id: "session-recovery-publishing", activityId, definitionVersion: 1, contentHash: "recovery-release",
  scope: "publishing", mode: "formal", status: "running", revision: 0,
}, "2026-11-13T10:00:00Z");
```

（judging session 已由第 5 步的 runtime 流程创建。）

把脚本加入 `plus/apps/api/package.json` 的 `seed:e2e` 链尾部。

Run: `pnpm -C plus --filter @artflow-plus/api seed:e2e`
Expected: 输出 seeded recovery activity，无异常。

- [ ] **Step 2: 写 E2E**

`recovery.spec.ts`：

```ts
test("an organizer recovers a published result end to end", async ({ page }) => {
  await page.goto("/login");
  await page.getByLabel("用户名").fill("e2e-ops");
  await page.getByLabel("密码").fill("e2e-ops-password");
  await page.getByRole("button", { name: "登录" }).click();
  await expect(page).toHaveURL(/\/workspace$/);

  await page.goto("/live/act_e2e_recovery");
  await expect(page.getByRole("heading", { name: "E2E Recovery" })).toBeVisible();

  // B: revoke then re-release
  await page.getByLabel("发布 / 归档说明").fill("现场撤回");
  await page.getByRole("button", { name: "撤销发布" }).click();
  await expect(page.getByTestId("release-status").filter({ hasText: "revoked" })).toHaveCount(1);
  await page.getByRole("button", { name: "发布赛果" }).click();
  await expect(page.getByTestId("release-status").filter({ hasText: "active" })).toHaveCount(1);

  // A: unlock -> reopen -> correct -> recalc -> resolve -> tie -> finalize
  await page.getByRole("button", { name: "解锁赛果" }).click();
  await page.getByRole("button", { name: "打开评分更正窗口" }).click();
  const third = page.getByTestId("score-fact-singer-c");
  await third.getByRole("button", { name: "开修正" }).click();
  await page.getByLabel("修正原因").fill("看错分");
  await page.getByRole("button", { name: "确认开修正" }).click();
  await third.getByLabel("total").fill("85");
  await third.getByRole("button", { name: "保存修正" }).click();
  await third.getByRole("button", { name: "关闭修正" }).click();
  await third.getByRole("button", { name: "重算" }).click();
  await page.getByRole("button", { name: "生成排名" }).click();
  await page.getByRole("button", { name: "锁轮" }).click();
  await page.getByRole("button", { name: "记录裁决" }).click();
  await page.getByRole("button", { name: "晋级定稿" }).click();
  await page.getByRole("button", { name: "生成领奖候选" }).click();
  await page.getByRole("button", { name: "确认评委赛果" }).click();
  await page.getByRole("button", { name: "发布赛果" }).click();
  await expect(page.getByTestId("release-status").filter({ hasText: "active" })).toHaveCount(1);
});
```

- [ ] **Step 3: 运行 E2E**

Run:
```powershell
$env:ARTFLOW_PLUS_DATABASE_URL = "postgresql://artflow:artflow_dev@127.0.0.1:5433/artflow_plus"
pnpm -C plus --filter @artflow-plus/web exec playwright test e2e/recovery.spec.ts --project=chromium
```
Expected: PASS。若选择器不稳定，使用 `data-testid`（例如 `data-testid="release-status"`）而不是文案。

- [ ] **Step 4: 全量门禁**

Run:
```powershell
pnpm -C plus run check
pnpm -C plus --filter @artflow-plus/contract-tools run audit:check
pnpm -C plus --filter @artflow-plus/web test
pnpm -C plus --filter @artflow-plus/contract-tools run graph:check
uv run pytest tests/gates -q
pnpm -C plus --filter @artflow-plus/web exec playwright test
```
Expected: 全部通过；`graph:check` 无未解析边；新读入口出现在 Consumer Graph。

- [ ] **Step 5: 提交**

```bash
git add plus/apps/api/scripts/seed-recovery.ts plus/apps/api/package.json plus/apps/web/e2e/recovery.spec.ts
git commit -m "test(web): cover the live exception recovery journey"
```

---

## Self-review

- Spec §4.1 读模型 → Task 1/2/3。
- Spec §4.2 类型扩展 → Task 4。
- Spec §4.3 恢复顺序 → Task 6/7/8 的 UI 提示与 E2E 步骤。
- Spec §5.1 评分修正 → Task 6。
- Spec §5.2 撤销/解锁 → Task 5。
- Spec §5.3 分组来源与指纹守卫 → Task 7。
- Spec §6 错误映射 → Task 5/6/7 的 `describeLiveError` 与反馈。
- Spec §7 权限 → Task 3 的 `competition` 读级别。
- Spec Test architecture → 本计划各任务的测试与 Task 8 门禁。
- 没有占位符；所有新增类型、函数名在前后任务中一致。

## Implementation notes (delivered)

执行过程中根据真实类型与生命周期纠正了计划里的几处假设：

- **回合状态**：`RoundState` 只有 `prepared | scoring | locked`，没有 `resolved`；
  读契约已删除该分支。
- **修正状态**：`ScoreCorrectionState` 还包含 `cancelled`；晋级状态还包含 `finalized`，
  契约、Web 类型与测试均已覆盖。
- **最近一条修正**：`revision` 是单条修正自己的版本号，不能跨修正比较；仓储按
  `created_at desc, revision desc` 选取。
- **恢复顺序**：`resolveRound` 只接受 `locked` 轮次，所以实际顺序是
  **重算 → 锁轮 → 生成排名**，不是计划草稿里的“生成排名 → 锁轮”。
- **晋级定稿**：只看“是否仍有跨线平局”；非跨线的 `hold` 排名可以定稿，
  后端会自动晋级。计划草稿里的“ranking 必须 ready”过严。
- **平局/晋级 UI**：实现为独立的 `LiveTieAdvancementPanel`，与评分修正面板并列，
  避免 locked 轮次被修正面板的阻塞态隐藏。
- **分组 `round_advanced` UI**：推迟。live 读模型没有晋级来源参与者集合，
  自动平均分组只能基于全部通过名单；后端命令、指纹守卫与 `sourceRoundId`
  字段已就绪。
- **再次修正**：`recalculated`/`cancelled` 只结束当前这一条修正；同一评分事实可以再开新修正，面板显示「再次修正」。
- **E2E 选择器**：评分事实行用 `data-testid="score-fact-${fact.id}"` 与
  `data-contestant="${contestantId}"`，不再使用 contestant-based testid。
- **E2E 种子**：额外插入 `podium_candidate` 行，否则真实 `releaseResult` 会因
  候选指纹/来源不匹配拒绝预置的已确认赛果；种子可重复执行，并在注释中标明
  这是 preset world。
- **门禁命令**：`graph:check` 位于 contract-tools 包：
  `pnpm -C plus --filter @artflow-plus/contract-tools run graph:check`。
