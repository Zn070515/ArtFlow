import { COMPETITION_COMMAND_SCOPES } from "@artflow-plus/domain";
import { randomUUID } from "node:crypto";

import {
  closeDb,
  createDb,
  insertRelease,
  insertSession,
  listCurrentScoreFacts,
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
  closeScoreCorrection,
  editScoreFact,
  lockPerformance,
  lockRound,
  openPerformance,
  openScoreCorrection,
  prepareCompetitionRound,
  recalculateAfterCorrection,
  resolveRound,
  submitJudgeScore,
  submitProxyScore,
} from "../src/index.js";
import type { RuntimeDeps } from "../src/index.js";

const connectionString = process.env.ARTFLOW_PLUS_DATABASE_URL;
if (process.env.REQUIRE_DB === "1" && connectionString === undefined) {
  throw new Error("REQUIRE_DB=1 but ARTFLOW_PLUS_DATABASE_URL is unset.");
}
const schema = `artflow_score_runtime_${Date.now()}_${process.pid}`;

let db: Kysely<Database>;
let admin: Client;
let tick = 0;

const judge: ActorContext = {
  actorId: "judge-1",
  actorType: "user",
  roles: ["judge"],
  permissions: [],
};
const staff: ActorContext = {
  actorId: "score-staff",
  actorType: "user",
  roles: ["staff"],
  permissions: ["competition.manage", "competition.round.prepare"],
};

function deps(actor: ActorContext): RuntimeDeps {
  return {
    actor,
    now: () => new Date(Date.UTC(2026, 9, 19, 16, 0, tick++)).toISOString(),
    newEventId: () => `score-${randomUUID()}`,
  };
}

const criteria = { technique: 36, stage: 27, emotion: 28 };

async function seedScoreWindow(): Promise<{
  readonly activityId: string;
  readonly roundId: string;
  readonly performanceId: string;
  readonly panelSnapshotId: string;
  readonly seatId: string;
}> {
  const activityId = `activity-${randomUUID()}`;
  await db.insertInto("activity").values({
    id: activityId,
    title: "Score runtime",
    status: "active",
    revision: 1,
    enabled_capabilities: JSON.stringify(["competition"]),
    active_definition_version: 1,
  }).execute();
  await insertRelease(db, {
    activityId,
    version: 1,
    contentHash: "score-release",
    capabilities: {
      competition: {
        ok: true,
        capabilityKey: "competition",
        contentHash: "score-content",
        artifact: {
          order: ["roster", "final", "result"],
          nodes: [
            { key: "roster", type: "roster" },
            { key: "final", type: "round" },
            { key: "result", type: "output" },
          ],
          edges: [{ from: "roster", to: "final" }, { from: "final", to: "result" }],
          rounds: [{ key: "final", judgeCount: 2, minimumJudges: 2, completion: "full_matrix", advanceCount: 1, scoringMethod: "average" }],
          rubric: {
            criteria: [
              { key: "technique", weight: 1, maximum: 100, minimum: 0 },
              { key: "stage", weight: 1, maximum: 100, minimum: 0 },
              { key: "emotion", weight: 1, maximum: 100, minimum: 0 },
            ],
          },
          tiePolicy: "review",
        },
      },
    },
    executionPolicy: { declaredScopes: ["judging"], conflicts: {}, runtimeContractVersion: 1, commandScopes: COMPETITION_COMMAND_SCOPES },
    capabilityVersions: { competition: "1" },
    bindings: [],
    releasedAt: "2026-10-19T15:00:00Z",
    sourceDraftRevision: 1,
  });
  await insertSession(db, {
    id: `session-${activityId}`,
    activityId,
    definitionVersion: 1,
    contentHash: "score-release",
    scope: "judging",
    mode: "formal",
    status: "running",
    revision: 0,
  }, "2026-10-19T15:30:00Z");
  await db.insertInto("roster").values({
    activity_id: activityId,
    status: "final",
    approved_count: 1,
    revision: 1,
    finalized_at: "2026-10-19T15:45:00Z",
    updated_at: new Date(),
  }).execute();
  await db.insertInto("registration").values({
    id: `registration-${activityId}-singer-a`,
    activity_id: activityId,
    participant_id: "singer-a",
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
  const prepared = await prepareCompetitionRound(db, deps(staff), {
    commandId: `prepare-${activityId}`,
    activityId,
    roundKey: "final",
    scope: "judging",
  });
  const panel = await activateCompetitionPanel(db, deps(staff), {
    commandId: `panel-${activityId}`,
    activityId,
    roundId: prepared.body.id,
    scope: "judging",
    judges: [
      { judgeId: "judge-1", seatKey: "seat-1" },
      { judgeId: "judge-2", seatKey: "seat-2" },
    ],
  });
  const performance = await openPerformance(db, deps(staff), {
    commandId: `performance-${activityId}`,
    activityId,
    roundId: prepared.body.id,
    scope: "judging",
    contestantId: "singer-a",
    sequence: 1,
  });
  const seat = await db.selectFrom("judge_seat").selectAll()
    .where("panel_id", "=", panel.body.id).where("judge_id", "=", judge.actorId)
    .executeTakeFirstOrThrow();
  return {
    activityId,
    roundId: prepared.body.id,
    performanceId: performance.body.id,
    panelSnapshotId: panel.body.id,
    seatId: seat.id,
  };
}

describe.skipIf(!connectionString)("score fact commands on PostgreSQL", () => {
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

  it("accepts one direct judge fact with a canonical key and total", async () => {
    const context = await seedScoreWindow();
    const result = await submitJudgeScore(db, deps(judge), {
      commandId: "cmd-score-1",
      activityId: context.activityId,
      roundId: context.roundId,
      performanceId: context.performanceId,
      panelSnapshotId: context.panelSnapshotId,
      seatId: context.seatId,
      contextVersion: 1,
      criteria,
      notes: "",
      scope: "judging",
    });
    expect(result.body).toMatchObject({
      key: `${context.roundId}|singer-a|judge-1`,
      source: "direct_judge",
      total: "91.00",
      version: 1,
    });
  });

  it("keeps rehearsal facts separate from formal facts", async () => {
    const context = await seedScoreWindow();
    await submitJudgeScore(db, deps(judge), {
      commandId: "mode-formal-score",
      ...context,
      contextVersion: 1,
      criteria,
      notes: "",
      scope: "judging",
    });
    await db.updateTable("execution_session")
      .set({ status: "closed" })
      .where("activity_id", "=", context.activityId)
      .execute();
    await insertSession(db, {
      id: `rehearsal-${context.activityId}`,
      activityId: context.activityId,
      definitionVersion: 1,
      contentHash: "score-release",
      scope: "judging",
      mode: "rehearsal",
      status: "running",
      revision: 0,
    }, "2026-10-19T16:30:00Z");
    const rehearsal = await submitJudgeScore(db, deps(judge), {
      commandId: "mode-rehearsal-score",
      ...context,
      contextVersion: 1,
      criteria: { technique: 40, stage: 30, emotion: 30 },
      notes: "彩排",
      scope: "judging",
    });
    expect(rehearsal.body).toMatchObject({ mode: "rehearsal", total: "100.00" });
    expect(await listCurrentScoreFacts(db, context.roundId, "formal")).toHaveLength(1);
    expect(await listCurrentScoreFacts(db, context.roundId, "rehearsal")).toHaveLength(1);

    await db.updateTable("execution_session").set({ status: "closed" })
      .where("activity_id", "=", context.activityId).where("mode", "=", "rehearsal").execute();
    await db.updateTable("execution_session").set({ status: "running" })
      .where("activity_id", "=", context.activityId).where("mode", "=", "formal").execute();
    await expect(editScoreFact(db, deps(staff), {
      commandId: "mode-wrong-edit",
      activityId: context.activityId,
      roundId: context.roundId,
      performanceId: context.performanceId,
      scoreFactId: rehearsal.body.id,
      panelSnapshotId: context.panelSnapshotId,
      seatId: context.seatId,
      contextVersion: 1,
      expectedVersion: 1,
      criteria: { technique: 1, stage: 1, emotion: 1 },
      reason: "wrong mode",
      scope: "judging",
    })).rejects.toMatchObject({ code: "SCORE_FACT_NOT_FOUND" });
  });

  it("rejects proxy duplication without an event or fact mutation", async () => {
    const context = await seedScoreWindow();
    await submitJudgeScore(db, deps(judge), {
      commandId: "cmd-score-duplicate",
      activityId: context.activityId,
      roundId: context.roundId,
      performanceId: context.performanceId,
      panelSnapshotId: context.panelSnapshotId,
      seatId: context.seatId,
      contextVersion: 1,
      criteria,
      notes: "",
      scope: "judging",
    });
    const before = await readEventsSince(db, { activityId: context.activityId, after: 0, limit: 100 });
    await expect(submitProxyScore(db, deps(staff), {
      commandId: "cmd-proxy-duplicate",
      activityId: context.activityId,
      roundId: context.roundId,
      performanceId: context.performanceId,
      panelSnapshotId: context.panelSnapshotId,
      seatId: context.seatId,
      contextVersion: 1,
      criteria: { ...criteria, emotion: 29 },
      notes: "评委终端故障",
      sourceReference: "JC-2026-001",
      reason: "评委终端故障",
      scope: "judging",
    })).rejects.toMatchObject({ code: "DUPLICATE_SCORE_FACT" });
    expect(await readEventsSince(db, { activityId: context.activityId, after: 0, limit: 100 })).toEqual(before);
  });

  it("edits the current fact and rejects a stale context", async () => {
    const context = await seedScoreWindow();
    const created = await submitJudgeScore(db, deps(judge), {
      commandId: "cmd-score-edit",
      activityId: context.activityId,
      roundId: context.roundId,
      performanceId: context.performanceId,
      panelSnapshotId: context.panelSnapshotId,
      seatId: context.seatId,
      contextVersion: 1,
      criteria,
      notes: "",
      scope: "judging",
    });
    const edited = await editScoreFact(db, deps(staff), {
      commandId: "cmd-edit-1",
      activityId: context.activityId,
      roundId: context.roundId,
      performanceId: context.performanceId,
      panelSnapshotId: context.panelSnapshotId,
      seatId: context.seatId,
      contextVersion: 1,
      expectedVersion: 1,
      criteria: { technique: 37, stage: 28, emotion: 28 },
      reason: "评委要求更正分项",
      scope: "judging",
    });
    expect(edited.body).toMatchObject({ version: 2, total: "93.00" });
    expect(created.body.id).toBe(edited.body.id);
    await expect(submitJudgeScore(db, deps({ ...judge, actorId: "judge-2" }), {
      commandId: "cmd-score-stale",
      activityId: context.activityId,
      roundId: context.roundId,
      performanceId: context.performanceId,
      panelSnapshotId: context.panelSnapshotId,
      seatId: context.seatId,
      contextVersion: 0,
      criteria,
      notes: "",
      scope: "judging",
    })).rejects.toMatchObject({ code: "STALE_CONTEXT" });
  });

  it("retires score facts when a performance context advances", async () => {
    const context = await seedScoreWindow();
    await submitJudgeScore(db, deps(judge), {
      commandId: "cmd-score-before-reopen",
      activityId: context.activityId,
      roundId: context.roundId,
      performanceId: context.performanceId,
      panelSnapshotId: context.panelSnapshotId,
      seatId: context.seatId,
      contextVersion: 1,
      criteria,
      notes: "",
      scope: "judging",
    });
    const reopened = await openPerformance(db, deps(staff), {
      commandId: "cmd-reopen-performance",
      activityId: context.activityId,
      roundId: context.roundId,
      scope: "judging",
      contestantId: "singer-a",
      sequence: 1,
    });
    expect(reopened.body.contextVersion).toBe(2);
    const currentFacts = await db.selectFrom("score_fact").selectAll()
      .where("performance_id", "=", context.performanceId).where("current", "=", true).execute();
    expect(currentFacts).toHaveLength(0);
    await expect(lockPerformance(db, deps(staff), {
      commandId: "cmd-lock-reopened-too-early",
      activityId: context.activityId,
      roundId: context.roundId,
      performanceId: context.performanceId,
      scope: "judging",
    })).rejects.toMatchObject({ code: "SCORE_GATE_OPEN" });
    const replacement = await submitJudgeScore(db, deps(judge), {
      commandId: "cmd-score-after-reopen",
      activityId: context.activityId,
      roundId: context.roundId,
      performanceId: context.performanceId,
      panelSnapshotId: context.panelSnapshotId,
      seatId: context.seatId,
      contextVersion: 2,
      criteria,
      notes: "",
      scope: "judging",
    });
    expect(replacement.body.contextVersion).toBe(2);
  });

  it("runs an explicit correction after the performance is locked", async () => {
    const context = await seedScoreWindow();
    const first = await submitJudgeScore(db, deps(judge), {
      commandId: "cmd-score-correction-j1",
      activityId: context.activityId,
      roundId: context.roundId,
      performanceId: context.performanceId,
      panelSnapshotId: context.panelSnapshotId,
      seatId: context.seatId,
      contextVersion: 1,
      criteria,
      notes: "",
      scope: "judging",
    });
    const seat2 = await db.selectFrom("judge_seat").selectAll()
      .where("panel_id", "=", context.panelSnapshotId).where("judge_id", "=", "judge-2")
      .executeTakeFirstOrThrow();
    await submitJudgeScore(db, deps({ ...judge, actorId: "judge-2" }), {
      commandId: "cmd-score-correction-j2",
      activityId: context.activityId,
      roundId: context.roundId,
      performanceId: context.performanceId,
      panelSnapshotId: context.panelSnapshotId,
      seatId: seat2.id,
      contextVersion: 1,
      criteria,
      notes: "",
      scope: "judging",
    });
    const locked = await lockPerformance(db, deps(staff), {
      commandId: "cmd-lock-for-correction",
      activityId: context.activityId,
      roundId: context.roundId,
      performanceId: context.performanceId,
      scope: "judging",
    });
    const correction = await openScoreCorrection(db, deps(staff), {
      commandId: "cmd-open-correction",
      activityId: context.activityId,
      roundId: context.roundId,
      performanceId: context.performanceId,
      scoreFactId: first.body.id,
      panelSnapshotId: context.panelSnapshotId,
      scope: "judging",
      reason: "更正分项",
    });
    expect(correction.body).toMatchObject({ state: "open", baseVersion: 1 });
    expect(correction.body.inputFingerprint).toMatch(/^[0-9a-f]{64}$/);
    const revised = await editScoreFact(db, deps(staff), {
      commandId: "cmd-revise-correction",
      activityId: context.activityId,
      roundId: context.roundId,
      performanceId: context.performanceId,
      panelSnapshotId: context.panelSnapshotId,
      seatId: context.seatId,
      contextVersion: 1,
      expectedVersion: 1,
      criteria: { technique: 37, stage: 28, emotion: 28 },
      reason: "更正分项",
      correctionId: correction.body.id,
      scope: "judging",
    });
    expect(revised.body).toMatchObject({ version: 2, total: "93.00" });
    await expect(closeScoreCorrection(db, deps(staff), {
      commandId: "cmd-close-correction-without-session",
      activityId: context.activityId,
      roundId: context.roundId,
      scoreFactId: first.body.id,
      correctionId: correction.body.id,
      panelSnapshotId: context.panelSnapshotId,
      scope: "missing-session",
    })).rejects.toMatchObject({ code: "SESSION_NOT_RUNNING" });
    const closed = await closeScoreCorrection(db, deps(staff), {
      commandId: "cmd-close-correction",
      activityId: context.activityId,
      roundId: context.roundId,
      scoreFactId: first.body.id,
      correctionId: correction.body.id,
      panelSnapshotId: context.panelSnapshotId,
      scope: "judging",
    });
    expect(closed.body.state).toBe("closed");
    const recalculated = await recalculateAfterCorrection(db, deps(staff), {
      commandId: "cmd-recalculate-correction",
      activityId: context.activityId,
      roundId: context.roundId,
      scoreFactId: first.body.id,
      correctionId: correction.body.id,
      panelSnapshotId: context.panelSnapshotId,
      scope: "judging",
    });
    expect(recalculated.body).toMatchObject({ id: correction.body.id, state: "recalculated" });
    const currentRound = await db.selectFrom("competition_round").selectAll()
      .where("id", "=", context.roundId).executeTakeFirstOrThrow();
    await lockRound(db, deps(staff), {
      commandId: "cmd-lock-after-correction",
      activityId: context.activityId,
      roundId: context.roundId,
      expectedRevision: currentRound.revision,
      scope: "judging",
    });
    const ranking = await resolveRound(db, deps(staff), {
      commandId: "cmd-resolve-after-correction",
      activityId: context.activityId,
      roundId: context.roundId,
      scope: "judging",
    });
    expect(ranking.body.sourceScoreVersion).toBe(3);
    expect(ranking.body.rows).toContainEqual(expect.objectContaining({ contestantId: "singer-a", total: "92.00" }));
  });

  it("refuses score changes after a confirmed result consumed the activity", async () => {
    const context = await seedScoreWindow();
    await db.insertInto("stage_result").values({
      id: `consumed-${context.activityId}`,
      activity_id: context.activityId,
      stage_key: "final",
      status: "confirmed",
      candidate_revision: 1,
      source_candidate_revision: 1,
      input_fingerprint: "fp-consumed",
      decisions: "[]",
      awards: "[]",
      note: "",
      revision: 1,
    }).execute();
    await expect(submitJudgeScore(db, deps(judge), {
      commandId: `consumed-score-${context.activityId}`,
      activityId: context.activityId,
      roundId: context.roundId,
      performanceId: context.performanceId,
      panelSnapshotId: context.panelSnapshotId,
      seatId: context.seatId,
      contextVersion: 1,
      criteria: { technique: 40, stage: 30, emotion: 30 },
      notes: "",
      scope: "judging",
    })).rejects.toMatchObject({ code: "RESULT_CONSUMED" });
  });
});
