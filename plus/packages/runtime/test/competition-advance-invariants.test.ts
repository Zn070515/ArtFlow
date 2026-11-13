import { COMPETITION_COMMAND_SCOPES } from "@artflow-plus/domain";
import { randomUUID } from "node:crypto";

import {
  closeDb,
  createDb,
  insertRelease,
  insertScoreFact,
  insertSession,
  migrate,
} from "@artflow-plus/db";
import type { Database } from "@artflow-plus/db";
import type { ActorContext } from "@artflow-plus/domain";
import type { Kysely } from "kysely";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  activateCompetitionPanel,
  advancePerformance,
  openPerformance,
  prepareCompetitionRound,
  resolveRound,
} from "../src/index.js";
import type { RuntimeDeps } from "../src/index.js";
import { recoveryDeps, recoveryStaff, seedLockedRound } from "./helpers/recovery-fixture.js";

const connectionString = process.env.ARTFLOW_PLUS_DATABASE_URL;
if (process.env.REQUIRE_DB === "1" && connectionString === undefined) {
  throw new Error("REQUIRE_DB=1 but ARTFLOW_PLUS_DATABASE_URL is unset.");
}
const schema = `artflow_competition_invariants_${Date.now()}_${process.pid}`;

let db: Kysely<Database>;
let admin: Client;
let tick = 0;

const staff: ActorContext = {
  actorId: "competition-staff",
  actorType: "user",
  roles: ["staff"],
  permissions: ["competition.manage", "competition.round.prepare"],
};

function deps(): RuntimeDeps {
  return {
    actor: staff,
    now: () => new Date(Date.UTC(2026, 10, 13, 14, 0, tick++)).toISOString(),
    newEventId: () => `competition-invariant-${randomUUID()}`,
  };
}

const competitionArtifact = {
  order: ["roster", "final", "result"],
  nodes: [
    { key: "roster", type: "roster" },
    { key: "final", type: "round" },
    { key: "result", type: "output" },
  ],
  edges: [
    { from: "roster", to: "final" },
    { from: "final", to: "result" },
  ],
  rounds: [{ key: "final", judgeCount: 2, minimumJudges: 2, completion: "full_matrix", advanceCount: 1, scoringMethod: "average" }],
  rubric: { criteria: [{ key: "total", weight: 1, maximum: 100, minimum: 0 }] },
  tiePolicy: "review",
};

async function seedActivity(): Promise<string> {
  const activityId = `activity-${randomUUID()}`;
  await db.insertInto("activity").values({
    id: activityId,
    title: "Competition invariants",
    status: "active",
    revision: 1,
    enabled_capabilities: JSON.stringify(["competition"]),
    active_definition_version: 1,
  }).execute();
  await insertRelease(db, {
    activityId,
    version: 1,
    contentHash: "competition-release",
    capabilities: {
      competition: {
        ok: true,
        capabilityKey: "competition",
        contentHash: "competition-content",
        artifact: competitionArtifact,
      },
    },
    executionPolicy: { declaredScopes: ["judging"], conflicts: {}, runtimeContractVersion: 2, commandScopes: COMPETITION_COMMAND_SCOPES },
    capabilityVersions: { competition: "1" },
    bindings: [],
    releasedAt: "2026-11-13T13:00:00Z",
    sourceDraftRevision: 1,
  });
  await insertSession(db, {
    id: `session-${activityId}`,
    activityId,
    definitionVersion: 1,
    contentHash: "competition-release",
    scope: "judging",
    mode: "formal",
    status: "running",
    revision: 0,
  }, "2026-11-13T13:30:00Z");
  await db.insertInto("roster").values({
    activity_id: activityId,
    status: "final",
    approved_count: 2,
    revision: 1,
    finalized_at: "2026-11-13T13:45:00Z",
    updated_at: new Date(),
  }).execute();
  for (const participantId of ["contestant-1", "contestant-2"]) {
    await db.insertInto("registration").values({
      id: `registration-${activityId}-${participantId}`,
      activity_id: activityId,
      participant_id: participantId,
      questionnaire_version: "v1",
      questionnaire_hash: "questionnaire-hash",
      status: "approved",
      answers: JSON.stringify({}),
      revision: 1,
      review_note: "",
      reviewed_by: "staff",
      created_at: new Date(),
      updated_at: new Date(),
    }).execute();
  }
  return activityId;
}

async function seedOpenRound(): Promise<{ activityId: string; roundId: string; performanceId: string }> {
  const activityId = await seedActivity();
  const prepared = await prepareCompetitionRound(db, deps(), {
    commandId: `prepare-${activityId}`,
    activityId,
    roundKey: "final",
    scope: "judging",
  });
  await activateCompetitionPanel(db, deps(), {
    commandId: `panel-${activityId}`,
    activityId,
    roundId: prepared.body.id,
    scope: "judging",
    judges: [
      { judgeId: "judge-1", seatKey: "seat-1" },
      { judgeId: "judge-2", seatKey: "seat-2" },
    ],
  });
  const opened = await openPerformance(db, deps(), {
    commandId: `open-${activityId}`,
    activityId,
    roundId: prepared.body.id,
    scope: "judging",
    contestantId: "contestant-1",
    sequence: 1,
  });
  const panel = await db.selectFrom("panel_snapshot").selectAll()
    .where("round_id", "=", prepared.body.id)
    .where("current", "=", true)
    .executeTakeFirstOrThrow();
  const seats = await db.selectFrom("judge_seat").selectAll()
    .where("panel_id", "=", panel.id)
    .orderBy("judge_id", "asc")
    .execute();
  for (const [index, seat] of seats.entries()) {
    const total = index === 0 ? "80.00" : "90.00";
    await insertScoreFact(db, {
      id: `score-${activityId}-${seat.id}`,
      activityId,
      roundId: prepared.body.id,
      performanceId: opened.body.id,
      contestantId: "contestant-1",
      judgeId: seat.judge_id,
      panelSnapshotId: panel.id,
      seatId: seat.id,
      source: "direct_judge",
      mode: "formal",
      total,
      criteria: { total: Number(total) },
      notes: "",
      version: 1,
      contextVersion: opened.body.contextVersion,
      current: true,
    });
  }
  return { activityId, roundId: prepared.body.id, performanceId: opened.body.id };
}

describe.skipIf(!connectionString)("competition advance invariants", () => {
  beforeAll(async () => {
    if (connectionString === undefined) return;
    admin = new Client({ connectionString });
    await admin.connect();
    await admin.query(`CREATE SCHEMA "${schema}"`);
    db = createDb({ connectionString, schema });
    await migrate(db);
  });

  afterAll(async () => {
    if (connectionString === undefined) return;
    await closeDb(db);
    await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
    await admin.end();
  });

  it("lets exactly one of two concurrent advances move the round forward", async () => {
    const context = await seedOpenRound();

    const results = await Promise.allSettled([
      advancePerformance(db, deps(), {
        commandId: `advance-a-${context.activityId}`,
        activityId: context.activityId,
        roundId: context.roundId,
        currentPerformanceId: context.performanceId,
        nextContestantId: "contestant-2",
        nextSequence: 2,
        scope: "judging",
      }),
      advancePerformance(db, deps(), {
        commandId: `advance-b-${context.activityId}`,
        activityId: context.activityId,
        roundId: context.roundId,
        currentPerformanceId: context.performanceId,
        nextContestantId: "contestant-2",
        nextSequence: 2,
        scope: "judging",
      }),
    ]);

    const fulfilled = results.filter((result) => result.status === "fulfilled");
    const rejected = results.filter((result) => result.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    const error = (rejected[0] as PromiseRejectedResult).reason as { code?: string };
    expect(["PERFORMANCE_NOT_OPEN", "STALE_REVISION", "ROUND_LOCKED"]).toContain(error.code);

    const performances = await db.selectFrom("performance").selectAll()
      .where("round_id", "=", context.roundId)
      .orderBy("sequence", "asc")
      .execute();
    expect(performances.map((row) => [row.contestant_id, row.state])).toEqual([
      ["contestant-1", "locked"],
      ["contestant-2", "open"],
    ]);
  });

  it("rejects performance writes once the round is terminal", async () => {
    const context = await seedOpenRound();
    await db.updateTable("competition_round").set({ state: "locked" }).where("id", "=", context.roundId).execute();

    await expect(openPerformance(db, deps(), {
      commandId: `open-locked-${context.activityId}`,
      activityId: context.activityId,
      roundId: context.roundId,
      scope: "judging",
      contestantId: "contestant-2",
      sequence: 2,
    })).rejects.toMatchObject({ code: "ROUND_NOT_PREPARED" });

    await expect(advancePerformance(db, deps(), {
      commandId: `advance-locked-${context.activityId}`,
      activityId: context.activityId,
      roundId: context.roundId,
      currentPerformanceId: context.performanceId,
      nextContestantId: "contestant-2",
      nextSequence: 2,
      scope: "judging",
    })).rejects.toMatchObject({ code: "ROUND_LOCKED" });
  });

  it("computes the same ranking from the same facts, independent of command ids", async () => {
    const context = await seedLockedRound(db);
    const first = await resolveRound(db, recoveryDeps(recoveryStaff), {
      commandId: `resolve-first-${context.activityId}`,
      activityId: context.activityId,
      roundId: context.roundId,
      scope: "judging",
    });
    const second = await resolveRound(db, recoveryDeps(recoveryStaff), {
      commandId: `resolve-second-${context.activityId}`,
      activityId: context.activityId,
      roundId: context.roundId,
      scope: "judging",
    });

    expect(second.body.rows).toEqual(first.body.rows);
    expect(second.body.tieGroups).toEqual(first.body.tieGroups);
    expect(second.body.status).toBe(first.body.status);
    expect(second.body.inputFingerprint).toBe(first.body.inputFingerprint);
  });
});
