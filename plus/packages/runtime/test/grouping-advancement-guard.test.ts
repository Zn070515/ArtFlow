import { closeDb, createDb, migrate } from "@artflow-plus/db";
import type { Database } from "@artflow-plus/db";
import type { Kysely } from "kysely";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  closeScoreCorrection,
  createGroupingStage,
  editScoreFact,
  finalizeAdvancement,
  getRoundScores,
  lockRound,
  openScoreCorrection,
  recalculateAfterCorrection,
  recordGroupingGroups,
  recordTieDecision,
  reopenRoundForCorrection,
  resolveRound,
} from "../src/index.js";
import {
  recoveryDeps,
  recoveryStaff,
  seedLockedRound,
} from "./helpers/recovery-fixture.js";

const connectionString = process.env.ARTFLOW_PLUS_DATABASE_URL;
if (process.env.REQUIRE_DB === "1" && connectionString === undefined) {
  throw new Error("REQUIRE_DB=1 but ARTFLOW_PLUS_DATABASE_URL is unset.");
}
const schema = `artflow_grouping_advancement_guard_${Date.now()}_${process.pid}`;

let db: Kysely<Database>;
let admin: Client;

describe.skipIf(!connectionString)("grouping advancement source guard", () => {
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

  it("accepts a fresh advancement decision and resolves the advanced subset", async () => {
    const fixture = await seedLockedRound(db);
    const ranking = await resolveRound(db, recoveryDeps(recoveryStaff), {
      commandId: `resolve-fresh-${fixture.activityId}`,
      activityId: fixture.activityId,
      roundId: fixture.roundId,
      scope: "judging",
    });
    const tie = (ranking.body.tieGroups as { id: string; contestants: string[] }[])[0]!;
    const decided = await recordTieDecision(db, recoveryDeps(recoveryStaff), {
      commandId: `tie-fresh-${fixture.activityId}`,
      activityId: fixture.activityId,
      roundId: fixture.roundId,
      rankingSnapshotId: ranking.body.id,
      tieId: tie.id,
      inputFingerprint: ranking.body.inputFingerprint,
      contestants: tie.contestants,
      order: [...tie.contestants].reverse(),
      reason: "现场裁决",
      scope: "judging",
    });
    const finalized = await finalizeAdvancement(db, recoveryDeps(recoveryStaff), {
      commandId: `advance-fresh-${fixture.activityId}`,
      activityId: fixture.activityId,
      roundId: fixture.roundId,
      expectedRankingRevision: decided.body.revision,
      scope: "judging",
    });
    expect(finalized.body.status).toBe("auto");

    const stage = await createGroupingStage(db, recoveryDeps(recoveryStaff), {
      commandId: `grouping-fresh-${fixture.activityId}`,
      activityId: fixture.activityId,
      stageKey: "next",
      name: "下一阶段",
      rosterSource: "round_advanced",
      sourceRoundId: fixture.roundId,
    });
    expect(stage.body).toMatchObject({
      rosterSource: "round_advanced",
      sourceRoundId: fixture.roundId,
      status: "draft",
    });

    const recorded = await recordGroupingGroups(db, recoveryDeps(recoveryStaff), {
      commandId: `record-fresh-${fixture.activityId}`,
      activityId: fixture.activityId,
      stageId: stage.body.id,
      expectedRevision: stage.body.revision,
      groups: [{ name: "A", participantIds: ["singer-b"] }],
    });
    expect(recorded.body.revision).toBe(stage.body.revision + 1);

    // singer-a lost the tie decision and is not in the resolved source set.
    await expect(recordGroupingGroups(db, recoveryDeps(recoveryStaff), {
      commandId: `record-loser-${fixture.activityId}`,
      activityId: fixture.activityId,
      stageId: stage.body.id,
      expectedRevision: recorded.body.revision,
      groups: [{ name: "A", participantIds: ["singer-a"] }],
    })).rejects.toMatchObject({ code: "GROUPING_SOURCE_UNKNOWN" });
  });

  it("rejects a stale advancement decision", async () => {
    const fixture = await seedLockedRound(db);
    const ranking = await resolveRound(db, recoveryDeps(recoveryStaff), {
      commandId: `resolve-${fixture.activityId}`,
      activityId: fixture.activityId,
      roundId: fixture.roundId,
      scope: "judging",
    });
    const tie = (ranking.body.tieGroups as { id: string; contestants: string[] }[])[0]!;
    const decided = await recordTieDecision(db, recoveryDeps(recoveryStaff), {
      commandId: `tie-${fixture.activityId}`,
      activityId: fixture.activityId,
      roundId: fixture.roundId,
      rankingSnapshotId: ranking.body.id,
      tieId: tie.id,
      inputFingerprint: ranking.body.inputFingerprint,
      contestants: tie.contestants,
      order: [...tie.contestants].reverse(),
      reason: "现场裁决",
      scope: "judging",
    });
    const finalized = await finalizeAdvancement(db, recoveryDeps(recoveryStaff), {
      commandId: `advance-${fixture.activityId}`,
      activityId: fixture.activityId,
      roundId: fixture.roundId,
      expectedRankingRevision: decided.body.revision,
      scope: "judging",
    });
    expect(finalized.body.status).toBe("auto");

    const before = await getRoundScores(db, {
      activityId: fixture.activityId,
      roundId: fixture.roundId,
      scope: "judging",
    });
    const fact = before.facts[0]!;
    const roundRow = await db.selectFrom("competition_round").selectAll()
      .where("id", "=", fixture.roundId).executeTakeFirstOrThrow();
    await reopenRoundForCorrection(db, recoveryDeps(recoveryStaff), {
      commandId: `reopen-${fixture.activityId}`,
      activityId: fixture.activityId,
      roundId: fixture.roundId,
      expectedRevision: roundRow.revision,
      reason: "改分",
      scope: "judging",
    });
    const opened = await openScoreCorrection(db, recoveryDeps(recoveryStaff), {
      commandId: `open-${fixture.activityId}`,
      activityId: fixture.activityId,
      roundId: fixture.roundId,
      performanceId: fact.performanceId,
      scoreFactId: fact.id,
      panelSnapshotId: fact.panelSnapshotId,
      reason: "看错分",
      scope: "judging",
    });
    await editScoreFact(db, recoveryDeps(recoveryStaff), {
      commandId: `edit-${fixture.activityId}`,
      activityId: fixture.activityId,
      roundId: fixture.roundId,
      performanceId: fact.performanceId,
      scoreFactId: fact.id,
      panelSnapshotId: fact.panelSnapshotId,
      seatId: fact.seatId,
      contextVersion: fact.contextVersion,
      expectedVersion: fact.version,
      criteria: { total: 95 },
      reason: "看错分",
      correctionId: opened.body.id,
      scope: "judging",
    });
    await closeScoreCorrection(db, recoveryDeps(recoveryStaff), {
      commandId: `close-${fixture.activityId}`,
      activityId: fixture.activityId,
      roundId: fixture.roundId,
      performanceId: fact.performanceId,
      scoreFactId: fact.id,
      correctionId: opened.body.id,
      panelSnapshotId: fact.panelSnapshotId,
      scope: "judging",
    });
    await recalculateAfterCorrection(db, recoveryDeps(recoveryStaff), {
      commandId: `recalc-${fixture.activityId}`,
      activityId: fixture.activityId,
      roundId: fixture.roundId,
      performanceId: fact.performanceId,
      scoreFactId: fact.id,
      correctionId: opened.body.id,
      panelSnapshotId: fact.panelSnapshotId,
      scope: "judging",
    });
    // Reopening for correction puts the round back into scoring; resolution
    // needs the round gate closed again.
    const reopened = await db.selectFrom("competition_round").selectAll()
      .where("id", "=", fixture.roundId).executeTakeFirstOrThrow();
    await lockRound(db, recoveryDeps(recoveryStaff), {
      commandId: `relock-${fixture.activityId}`,
      activityId: fixture.activityId,
      roundId: fixture.roundId,
      expectedRevision: reopened.revision,
      scope: "judging",
    });
    const reranked = await resolveRound(db, recoveryDeps(recoveryStaff), {
      commandId: `resolve-again-${fixture.activityId}`,
      activityId: fixture.activityId,
      roundId: fixture.roundId,
      scope: "judging",
    });
    expect(reranked.body.inputFingerprint).not.toBe(ranking.body.inputFingerprint);

    await expect(createGroupingStage(db, recoveryDeps(recoveryStaff), {
      commandId: `grouping-stale-${fixture.activityId}`,
      activityId: fixture.activityId,
      stageKey: "next",
      name: "下一阶段",
      rosterSource: "round_advanced",
      sourceRoundId: fixture.roundId,
    })).rejects.toMatchObject({ code: "STALE_ADVANCEMENT" });
  });
});
