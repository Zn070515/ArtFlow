import { randomUUID } from "node:crypto";

import {
  closeDb,
  createDb,
  insertRelease,
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
  buildPodiumCandidate,
  finalizeAdvancement,
  lockPerformance,
  lockRound,
  openPerformance,
  prepareCompetitionRound,
  recordTieDecision,
  recomputePodiumCandidate,
  resolveRound,
  submitJudgeScore,
} from "../src/index.js";
import type { RuntimeDeps } from "../src/index.js";

const connectionString = process.env.ARTFLOW_PLUS_DATABASE_URL;
if (process.env.REQUIRE_DB === "1" && connectionString === undefined) {
  throw new Error("REQUIRE_DB=1 but ARTFLOW_PLUS_DATABASE_URL is unset.");
}
const schema = `artflow_resolution_runtime_${Date.now()}_${process.pid}`;

let db: Kysely<Database>;
let admin: Client;
let tick = 0;

const staff: ActorContext = {
  actorId: "resolution-staff",
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
    now: () => new Date(Date.UTC(2026, 9, 19, 18, 0, tick++)).toISOString(),
    newEventId: () => `resolution-${randomUUID()}`,
  };
}

async function seedLockedRound(): Promise<{ readonly activityId: string; readonly roundId: string; readonly panelId: string; readonly seatId: string }> {
  const activityId = `activity-${randomUUID()}`;
  await db.insertInto("activity").values({
    id: activityId,
    title: "Resolution runtime",
    status: "active",
    revision: 1,
    enabled_capabilities: JSON.stringify(["competition"]),
    active_definition_version: 1,
  }).execute();
  await insertRelease(db, {
    activityId,
    version: 1,
    contentHash: "resolution-release",
    capabilities: {
      competition: {
        ok: true,
        capabilityKey: "competition",
        contentHash: "resolution-content",
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
    releasedAt: "2026-10-19T17:00:00Z",
    sourceDraftRevision: 1,
  });
  await insertSession(db, {
    id: `session-${activityId}`,
    activityId,
    definitionVersion: 1,
    contentHash: "resolution-release",
    scope: "judging",
    mode: "formal",
    status: "running",
    revision: 0,
  }, "2026-10-19T17:30:00Z");
  await db.insertInto("roster").values({
    activity_id: activityId,
    status: "final",
    approved_count: 3,
    revision: 1,
    finalized_at: "2026-10-19T17:45:00Z",
    updated_at: new Date(),
  }).execute();
  for (const contestantId of ["singer-a", "singer-b", "singer-c"]) {
    await db.insertInto("registration").values({
      id: `registration-${activityId}-${contestantId}`,
      activity_id: activityId,
      participant_id: contestantId,
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
    .where("panel_id", "=", panel.body.id).where("judge_id", "=", judge.actorId)
    .executeTakeFirstOrThrow();
  for (const [index, [contestantId, total]] of ([
    ["singer-a", 90],
    ["singer-b", 90],
    ["singer-c", 80],
  ] as const).entries()) {
    const performance = await openPerformance(db, deps(staff), {
      commandId: `open-${activityId}-${contestantId}`,
      activityId,
      roundId: round.body.id,
      scope: "judging",
      contestantId,
      sequence: index + 1,
    });
    await submitJudgeScore(db, deps(judge), {
      commandId: `score-${activityId}-${contestantId}`,
      activityId,
      roundId: round.body.id,
      performanceId: performance.body.id,
      panelSnapshotId: panel.body.id,
      seatId: seat.id,
      contextVersion: 1,
      criteria: { total },
      notes: "",
      scope: "judging",
    });
    await lockPerformance(db, deps(staff), {
      commandId: `lock-${activityId}-${contestantId}`,
      activityId,
      roundId: round.body.id,
      performanceId: performance.body.id,
      scope: "judging",
    });
  }
  const currentRound = await db.selectFrom("competition_round").selectAll().where("id", "=", round.body.id).executeTakeFirstOrThrow();
  await lockRound(db, deps(staff), {
    commandId: `lock-round-${activityId}`,
    activityId,
    roundId: round.body.id,
    expectedRevision: currentRound.revision,
    scope: "judging",
  });
  return { activityId, roundId: round.body.id, panelId: panel.body.id, seatId: seat.id };
}

describe.skipIf(!connectionString)("resolution commands on PostgreSQL", () => {
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

  it("holds advancement at a cutoff tie until an explicit decision", async () => {
    const context = await seedLockedRound();
    const ranking = await resolveRound(db, deps(staff), {
      commandId: "resolve-final",
      activityId: context.activityId,
      roundId: context.roundId,
      scope: "judging",
    });
    expect(ranking.body.status).toBe("hold");
    expect(ranking.body.tieGroups).toMatchObject([{ total: 90, contestants: ["singer-a", "singer-b"], id: expect.any(String) }]);
    const tieId = (ranking.body.tieGroups[0] as { id: string }).id;
    const held = await finalizeAdvancement(db, deps(staff), {
      commandId: "advance-held",
      activityId: context.activityId,
      roundId: context.roundId,
      expectedRankingRevision: ranking.body.revision,
      scope: "judging",
    });
    expect(held.body.status).toBe("needs_review");
    await expect(recordTieDecision(db, deps(staff), {
      commandId: "tie-decision-wrong-path",
      activityId: context.activityId,
      roundId: context.roundId,
      rankingSnapshotId: ranking.body.id,
      tieId: "tie-wrong",
      inputFingerprint: ranking.body.inputFingerprint,
      contestants: ["singer-a", "singer-b"],
      order: ["singer-b", "singer-a"],
      reason: "错误路径",
      scope: "judging",
    })).rejects.toMatchObject({ code: "TIE_DECISION_INVALID" });
    const decided = await recordTieDecision(db, deps(staff), {
      commandId: "tie-decision-final",
      activityId: context.activityId,
      roundId: context.roundId,
      rankingSnapshotId: ranking.body.id,
      tieId,
      inputFingerprint: ranking.body.inputFingerprint,
      contestants: ["singer-a", "singer-b"],
      order: ["singer-b", "singer-a"],
      reason: "现场裁决",
      scope: "judging",
    });
    expect(decided.body.status).toBe("ready");
    const finalized = await finalizeAdvancement(db, deps(staff), {
      commandId: "advance-final",
      activityId: context.activityId,
      roundId: context.roundId,
      expectedRankingRevision: decided.body.revision,
      scope: "judging",
    });
    expect(finalized.body).toMatchObject({ status: "auto" });
    expect(finalized.body.decisions).toEqual([
      { contestantId: "singer-b", advanced: true },
      { contestantId: "singer-a", advanced: false },
      { contestantId: "singer-c", advanced: false },
    ]);
    const podiumInput = buildPodiumCandidate({
      requiredRoundIds: [context.roundId],
      rounds: [{ roundId: context.roundId, sourceScoreVersion: 3, locked: true, ranking: {
        status: decided.body.status,
        rows: decided.body.rows as { contestantId: string; total: number; judgeCount: number }[],
        tieGroups: decided.body.tieGroups as { total: number; contestants: string[] }[],
        inputFingerprint: decided.body.inputFingerprint,
      } }],
    });
    const candidate = await recomputePodiumCandidate(db, deps(staff), {
      commandId: "podium-final",
      activityId: context.activityId,
      roundIds: [context.roundId],
      expectedInputFingerprint: podiumInput.inputFingerprint,
      scope: "judging",
    });
    expect(candidate.body.status).toBe("candidate");
    expect(candidate.body.sourceScoreVersions).toEqual([{ roundId: context.roundId, sourceScoreVersion: 3 }]);
    await expect(recomputePodiumCandidate(db, deps(staff), {
      commandId: "podium-stale",
      activityId: context.activityId,
      roundIds: [context.roundId],
      expectedInputFingerprint: "stale-fingerprint",
      scope: "judging",
    })).rejects.toMatchObject({ code: "STALE_RESOLUTION_INPUT" });
  });

  it("rejects a score fact whose context no longer matches the locked performance", async () => {
    const context = await seedLockedRound();
    await db.updateTable("score_fact").set({ context_version: 2 })
      .where("round_id", "=", context.roundId).execute();
    await expect(resolveRound(db, deps(staff), {
      commandId: "resolve-stale-fact-context",
      activityId: context.activityId,
      roundId: context.roundId,
      scope: "judging",
    })).rejects.toMatchObject({ code: "STALE_CONTEXT" });
  });

  it("keeps a pure podium candidate on HOLD until locked, complete, and tie-free", () => {
    const held = buildPodiumCandidate({
      requiredRoundIds: ["final"],
      rounds: [{ roundId: "final", sourceScoreVersion: 1, locked: false, ranking: { status: "ready", rows: [], tieGroups: [], inputFingerprint: "x" } }],
    });
    expect(held.status).toBe("hold");
    const candidate = buildPodiumCandidate({
      requiredRoundIds: ["final"],
      rounds: [{
        roundId: "final",
        sourceScoreVersion: 1,
        locked: true,
        ranking: {
          status: "ready",
          rows: [{ contestantId: "singer-a", total: 91, judgeCount: 3 }],
          tieGroups: [],
          inputFingerprint: "x",
        },
      }],
    });
    expect(candidate.status).toBe("candidate");
    expect(candidate.placements).toEqual([{ place: 1, contestantId: "singer-a", total: 91 }]);
  });

  it("holds a podium candidate when a required round is missing", () => {
    const candidate = buildPodiumCandidate({
      requiredRoundIds: ["semi", "final"],
      rounds: [{
        roundId: "final",
        sourceScoreVersion: 2,
        locked: true,
        ranking: {
          status: "ready",
          rows: [{ contestantId: "singer-a", total: 91, judgeCount: 3 }],
          tieGroups: [],
          inputFingerprint: "final-fingerprint",
        },
      }],
    });
    expect(candidate.status).toBe("hold");
    expect(candidate.sourceRoundIds).toEqual(["final"]);
  });
});
