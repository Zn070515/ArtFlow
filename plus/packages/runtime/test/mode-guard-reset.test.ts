import { randomUUID } from "node:crypto";

import {
  closeDb,
  createDb,
  getCurrentRankingSnapshot,
  insertRelease,
  insertSession,
  listCurrentScoreFacts,
  listRoundPerformances,
  migrate,
} from "@artflow-plus/db";
import type { Database } from "@artflow-plus/db";
import type { ActorContext } from "@artflow-plus/domain";
import type { Kysely } from "kysely";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  activateCompetitionPanel,
  lockPerformance,
  lockRound,
  openPerformance,
  prepareCompetitionRound,
  resetRehearsalRound,
  resolveRound,
  submitJudgeScore,
} from "../src/index.js";
import type { RuntimeDeps } from "../src/index.js";

const connectionString = process.env.ARTFLOW_PLUS_DATABASE_URL;
if (process.env.REQUIRE_DB === "1" && connectionString === undefined) {
  throw new Error("REQUIRE_DB=1 but ARTFLOW_PLUS_DATABASE_URL is unset.");
}
const schema = `artflow_mode_guard_reset_${Date.now()}_${process.pid}`;

let db: Kysely<Database>;
let admin: Client;
let tick = 0;

const staff: ActorContext = {
  actorId: "mode-staff",
  actorType: "user",
  roles: ["staff"],
  permissions: ["competition.manage", "competition.round.prepare"],
};
const judge: ActorContext = {
  actorId: "mode-judge",
  actorType: "user",
  roles: ["judge"],
  permissions: [],
};

function deps(actor: ActorContext): RuntimeDeps {
  return {
    actor,
    now: () => new Date(Date.UTC(2026, 9, 26, 15, 0, tick++)).toISOString(),
    newEventId: () => `mode-${randomUUID()}`,
  };
}

const competitionArtifact = {
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
};

interface Seeded {
  readonly activityId: string;
  readonly roundId: string;
  readonly panelId: string;
  readonly seatId: string;
  readonly performanceId: string;
}

async function seedThroughScore(
  mode: "formal" | "rehearsal",
  lock: boolean,
): Promise<Seeded> {
  const activityId = `activity-${randomUUID()}`;
  await db.insertInto("activity").values({
    id: activityId,
    title: "Mode guard",
    status: "active",
    revision: 1,
    enabled_capabilities: JSON.stringify(["competition"]),
    active_definition_version: 1,
  }).execute();
  await insertRelease(db, {
    activityId,
    version: 1,
    contentHash: "mode-release",
    capabilities: {
      competition: {
        ok: true,
        capabilityKey: "competition",
        contentHash: "mode-content",
        artifact: competitionArtifact,
      },
    },
    executionPolicy: { declaredScopes: ["judging"], conflicts: {}, runtimeContractVersion: 1 },
    capabilityVersions: { competition: "1" },
    bindings: [],
    releasedAt: "2026-10-26T14:00:00Z",
    sourceDraftRevision: 1,
  });
  await insertSession(db, {
    id: `session-${activityId}`,
    activityId,
    definitionVersion: 1,
    contentHash: "mode-release",
    scope: "judging",
    mode,
    status: "running",
    revision: 0,
  }, "2026-10-26T14:30:00Z");
  await db.insertInto("roster").values({
    activity_id: activityId,
    status: "final",
    approved_count: 2,
    revision: 1,
    finalized_at: "2026-10-26T14:45:00Z",
    updated_at: new Date(),
  }).execute();
  for (const participantId of ["singer-a", "singer-b"]) {
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
  const round = await prepareCompetitionRound(db, deps(staff), {
    commandId: `prepare-${activityId}`,
    activityId,
    roundKey: "final",
    scope: "judging",
  });
  const panel = await activateCompetitionPanel(db, deps(staff), {
    commandId: `panel-${activityId}`,
    activityId,
    roundId: round.body.id,
    scope: "judging",
    judges: [{ judgeId: judge.actorId, seatKey: "seat-1" }],
  });
  const seat = await db.selectFrom("judge_seat").selectAll()
    .where("panel_id", "=", panel.body.id)
    .where("judge_id", "=", judge.actorId)
    .executeTakeFirstOrThrow();
  const performance = await openPerformance(db, deps(staff), {
    commandId: `open-${activityId}`,
    activityId,
    roundId: round.body.id,
    scope: "judging",
    contestantId: "singer-a",
    sequence: 1,
  });
  await submitJudgeScore(db, deps(judge), {
    commandId: `score-${activityId}`,
    activityId,
    roundId: round.body.id,
    performanceId: performance.body.id,
    panelSnapshotId: panel.body.id,
    seatId: seat.id,
    contextVersion: 1,
    criteria: { total: 90 },
    notes: "",
    scope: "judging",
  });
  if (lock) {
    await lockPerformance(db, deps(staff), {
      commandId: `lock-performance-${activityId}`,
      activityId,
      roundId: round.body.id,
      performanceId: performance.body.id,
      scope: "judging",
    });
    const current = await db.selectFrom("competition_round").selectAll()
      .where("id", "=", round.body.id).executeTakeFirstOrThrow();
    await lockRound(db, deps(staff), {
      commandId: `lock-round-${activityId}`,
      activityId,
      roundId: round.body.id,
      expectedRevision: current.revision,
      scope: "judging",
    });
  }
  return {
    activityId,
    roundId: round.body.id,
    panelId: panel.body.id,
    seatId: seat.id,
    performanceId: performance.body.id,
  };
}

async function switchSessionMode(activityId: string, mode: "formal" | "rehearsal"): Promise<void> {
  await db.updateTable("execution_session").set({ mode })
    .where("activity_id", "=", activityId).execute();
}

describe.skipIf(!connectionString)("mode guards and rehearsal reset", () => {
  beforeAll(async () => {
    if (!connectionString) return;
    admin = new Client({ connectionString });
    await admin.connect();
    await admin.query(`CREATE SCHEMA "${schema}"`);
    db = createDb({ connectionString, schema });
    await migrate(db);
  });

  afterAll(async () => {
    if (!connectionString) return;
    await closeDb(db);
    await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
    await admin.end();
  });

  it("refuses non-formal lifecycle mutations once formal facts exist", async () => {
    const context = await seedThroughScore("formal", false);
    await switchSessionMode(context.activityId, "rehearsal");

    await expect(openPerformance(db, deps(staff), {
      commandId: "guard-open",
      activityId: context.activityId,
      roundId: context.roundId,
      scope: "judging",
      contestantId: "singer-b",
      sequence: 2,
    })).rejects.toMatchObject({ code: "FORMAL_FACTS_EXIST" });
    await expect(lockPerformance(db, deps(staff), {
      commandId: "guard-lock-performance",
      activityId: context.activityId,
      roundId: context.roundId,
      performanceId: context.performanceId,
      scope: "judging",
    })).rejects.toMatchObject({ code: "FORMAL_FACTS_EXIST" });
    await expect(lockRound(db, deps(staff), {
      commandId: "guard-lock-round",
      activityId: context.activityId,
      roundId: context.roundId,
      expectedRevision: 0,
      scope: "judging",
    })).rejects.toMatchObject({ code: "FORMAL_FACTS_EXIST" });
    await expect(resolveRound(db, deps(staff), {
      commandId: "guard-resolve",
      activityId: context.activityId,
      roundId: context.roundId,
      scope: "judging",
    })).rejects.toMatchObject({ code: "FORMAL_FACTS_EXIST" });
  });

  it("clears rehearsal data and returns the round to prepared", async () => {
    const context = await seedThroughScore("rehearsal", true);
    const ranking = await resolveRound(db, deps(staff), {
      commandId: "reset-resolve",
      activityId: context.activityId,
      roundId: context.roundId,
      scope: "judging",
    });
    expect(ranking.body.mode).toBe("rehearsal");

    const reset = await resetRehearsalRound(db, deps(staff), {
      commandId: "reset-rehearsal",
      activityId: context.activityId,
      roundId: context.roundId,
      scope: "judging",
      mode: "rehearsal",
    });
    expect(reset.body).toMatchObject({ deletedFacts: 1, deletedRankings: 1, deletedPerformances: 1 });
    expect(reset.body.round).toMatchObject({
      state: "prepared",
      currentPanelId: null,
      scoreVersion: 0,
      lockedAt: null,
    });
    expect(await listRoundPerformances(db, context.roundId)).toEqual([]);
    expect(await listCurrentScoreFacts(db, context.roundId, "rehearsal")).toEqual([]);
    expect(await getCurrentRankingSnapshot(db, context.roundId, "rehearsal")).toBeNull();
    const panel = await db.selectFrom("panel_snapshot").selectAll()
      .where("id", "=", context.panelId).executeTakeFirstOrThrow();
    expect(panel.current).toBe(false);
    expect(panel.state).toBe("superseded");

    await activateCompetitionPanel(db, deps(staff), {
      commandId: "reset-panel",
      activityId: context.activityId,
      roundId: context.roundId,
      scope: "judging",
      judges: [{ judgeId: judge.actorId, seatKey: "seat-1" }],
    });
    await expect(openPerformance(db, deps(staff), {
      commandId: "reset-open",
      activityId: context.activityId,
      roundId: context.roundId,
      scope: "judging",
      contestantId: "singer-a",
      sequence: 1,
    })).resolves.toMatchObject({ body: { contestantId: "singer-a" } });
  });

  it("refuses to reset a round that already has formal facts", async () => {
    const context = await seedThroughScore("formal", true);
    const before = await listCurrentScoreFacts(db, context.roundId, "formal");
    await expect(resetRehearsalRound(db, deps(staff), {
      commandId: "reset-formal",
      activityId: context.activityId,
      roundId: context.roundId,
      scope: "judging",
      mode: "rehearsal",
    })).rejects.toMatchObject({ code: "FORMAL_FACTS_EXIST" });
    expect(await listCurrentScoreFacts(db, context.roundId, "formal")).toEqual(before);
    expect(await listRoundPerformances(db, context.roundId)).toHaveLength(1);
    const round = await db.selectFrom("competition_round").selectAll()
      .where("id", "=", context.roundId).executeTakeFirstOrThrow();
    expect(round.state).toBe("locked");
  });
});
