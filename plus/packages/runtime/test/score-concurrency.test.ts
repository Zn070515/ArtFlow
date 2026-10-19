import { randomUUID } from "node:crypto";

import {
  closeDb,
  createDb,
  insertRelease,
  insertSession,
  migrate,
  readEventsSince,
} from "@artflow-plus/db";
import type { Database } from "@artflow-plus/db";
import type { ActorContext } from "@artflow-plus/domain";
import type { Kysely } from "kysely";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  activateCompetitionPanel,
  openPerformance,
  prepareCompetitionRound,
  submitJudgeScore,
} from "../src/index.js";
import type { RuntimeDeps } from "../src/index.js";

const connectionString = process.env.ARTFLOW_PLUS_DATABASE_URL;
if (process.env.REQUIRE_DB === "1" && connectionString === undefined) {
  throw new Error("REQUIRE_DB=1 but ARTFLOW_PLUS_DATABASE_URL is unset.");
}
const schema = `artflow_score_concurrency_${Date.now()}_${process.pid}`;

let db1: Kysely<Database>;
let db2: Kysely<Database>;
let admin: Client;
let tick = 0;

const staff: ActorContext = {
  actorId: "score-concurrency-staff",
  actorType: "user",
  roles: ["staff"],
  permissions: ["competition.manage", "competition.round.prepare"],
};
const judge: ActorContext = {
  actorId: "judge-1",
  actorType: "user",
  roles: ["judge"],
  permissions: [],
};

function deps(actor: ActorContext): RuntimeDeps {
  return {
    actor,
    now: () => new Date(Date.UTC(2026, 9, 19, 17, 0, tick++)).toISOString(),
    newEventId: () => `score-concurrency-${randomUUID()}`,
  };
}

async function seed(): Promise<{
  readonly activityId: string;
  readonly roundId: string;
  readonly performanceId: string;
  readonly panelSnapshotId: string;
  readonly seatId: string;
}> {
  const activityId = `activity-${randomUUID()}`;
  await db1.insertInto("activity").values({
    id: activityId,
    title: "Score concurrency",
    status: "active",
    revision: 1,
    enabled_capabilities: JSON.stringify(["competition"]),
    active_definition_version: 1,
  }).execute();
  await insertRelease(db1, {
    activityId,
    version: 1,
    contentHash: "score-concurrency-release",
    capabilities: {
      competition: {
        ok: true,
        capabilityKey: "competition",
        contentHash: "score-concurrency-content",
        artifact: {
          order: ["roster", "final", "result"],
          nodes: [
            { key: "roster", type: "roster" },
            { key: "final", type: "round" },
            { key: "result", type: "output" },
          ],
          edges: [{ from: "roster", to: "final" }, { from: "final", to: "result" }],
          rounds: [{ key: "final", judgeCount: 1, minimumJudges: 1, completion: "minimum_valid", advanceCount: 1, scoringMethod: "average" }],
          rubric: { criteria: [{ key: "total", weight: 1, maximum: 100, minimum: 0 }] },
          tiePolicy: "review",
        },
      },
    },
    executionPolicy: { declaredScopes: ["judging"], conflicts: {}, runtimeContractVersion: 1 },
    capabilityVersions: { competition: "1" },
    bindings: [],
    releasedAt: "2026-10-19T16:00:00Z",
    sourceDraftRevision: 1,
  });
  await insertSession(db1, {
    id: `session-${activityId}`,
    activityId,
    definitionVersion: 1,
    contentHash: "score-concurrency-release",
    scope: "judging",
    mode: "formal",
    status: "running",
    revision: 0,
  }, "2026-10-19T16:30:00Z");
  await db1.insertInto("roster").values({
    activity_id: activityId,
    status: "final",
    approved_count: 1,
    revision: 1,
    finalized_at: "2026-10-19T16:45:00Z",
    updated_at: new Date(),
  }).execute();
  const round = await prepareCompetitionRound(db1, deps(staff), {
    commandId: `prepare-${activityId}`,
    activityId,
    roundKey: "final",
    scope: "judging",
  });
  const panel = await activateCompetitionPanel(db1, deps(staff), {
    commandId: `panel-${activityId}`,
    activityId,
    roundId: round.body.id,
    scope: "judging",
    judges: [{ judgeId: judge.actorId, seatKey: "seat-1" }],
  });
  const performance = await openPerformance(db1, deps(staff), {
    commandId: `performance-${activityId}`,
    activityId,
    roundId: round.body.id,
    scope: "judging",
    contestantId: "singer-a",
    sequence: 1,
  });
  const seat = await db1.selectFrom("judge_seat").selectAll()
    .where("panel_id", "=", panel.body.id).where("judge_id", "=", judge.actorId)
    .executeTakeFirstOrThrow();
  return {
    activityId,
    roundId: round.body.id,
    performanceId: performance.body.id,
    panelSnapshotId: panel.body.id,
    seatId: seat.id,
  };
}

describe.skipIf(!connectionString)("score fact concurrency on PostgreSQL", () => {
  beforeAll(async () => {
    if (!connectionString) return;
    admin = new Client({ connectionString });
    await admin.connect();
    await admin.query(`CREATE SCHEMA "${schema}"`);
    db1 = createDb({ connectionString, schema });
    db2 = createDb({ connectionString, schema });
    await migrate(db1);
  });

  afterAll(async () => {
    if (!connectionString) return;
    await closeDb(db1);
    await closeDb(db2);
    await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
    await admin.end();
  });

  it("keeps one fact and one event across concurrent writes, then replays the winner", async () => {
    const context = await seed();
    const base = {
      activityId: context.activityId,
      roundId: context.roundId,
      performanceId: context.performanceId,
      panelSnapshotId: context.panelSnapshotId,
      seatId: context.seatId,
      contextVersion: 1,
      criteria: { total: 91 },
      notes: "",
      scope: "judging",
    } as const;
    const inputs = [
      { ...base, commandId: "score-concurrent-a" },
      { ...base, commandId: "score-concurrent-b" },
    ] as const;
    const results = await Promise.allSettled([
      submitJudgeScore(db1, deps(judge), inputs[0]),
      submitJudgeScore(db2, deps(judge), inputs[1]),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((result) => result.status === "rejected");
    expect(rejected).toMatchObject({ status: "rejected", reason: { code: "DUPLICATE_SCORE_FACT" } });
    const winningIndex = results.findIndex((result) => result.status === "fulfilled");
    const winningInput = inputs[winningIndex];
    if (winningInput === undefined) throw new Error("No winning score command.");
    const replay = await submitJudgeScore(db1, deps(judge), winningInput);
    expect(replay.replayed).toBe(true);
    await expect(submitJudgeScore(db1, deps(judge), { ...winningInput, criteria: { total: 92 } }))
      .rejects.toMatchObject({ code: "COMMAND_ID_CONFLICT" });
    await expect(db1.selectFrom("score_fact").selectAll().where("round_id", "=", context.roundId).execute()).resolves.toHaveLength(1);
    const events = await readEventsSince(db1, { activityId: context.activityId, after: 0, limit: 100 });
    expect(events.filter((event) => event.type === "ScoreFactRecorded")).toHaveLength(1);
  });
});
