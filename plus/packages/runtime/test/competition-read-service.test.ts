import { closeDb, createDb, migrate } from "@artflow-plus/db";
import type { Database } from "@artflow-plus/db";
import { Client } from "pg";
import type { Kysely } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  finalizeAdvancement,
  getRoundScores,
  openScoreCorrection,
  reopenRoundForCorrection,
  resolveRound,
} from "../src/index.js";
import {
  recoveryDeps,
  recoveryStaff,
  seedLockedRound,
} from "./helpers/recovery-fixture.js";

const connectionString = process.env.ARTFLOW_PLUS_DATABASE_URL;
const schema = `artflow_round_scores_${Date.now()}_${process.pid}`;
let db: Kysely<Database>;
let admin: Client;

describe.skipIf(!connectionString)("round scores read service", () => {
  beforeAll(async () => {
    if (!connectionString) return;
    admin = new Client({ connectionString }); await admin.connect();
    await admin.query(`CREATE SCHEMA "${schema}"`);
    db = createDb({ connectionString, schema }); await migrate(db);
  });
  afterAll(async () => {
    await closeDb(db); await admin.query(`DROP SCHEMA "${schema}" CASCADE`); await admin.end();
  });

  it("projects current score facts and the running session mode", async () => {
    const fixture = await seedLockedRound(db);
    const ranking = await resolveRound(db, recoveryDeps(recoveryStaff), {
      commandId: `resolve-${fixture.activityId}`,
      activityId: fixture.activityId,
      roundId: fixture.roundId,
      scope: "judging",
    });
    const result = await getRoundScores(db, {
      activityId: fixture.activityId,
      roundId: fixture.roundId,
      scope: "judging",
    });
    expect(result.round).toMatchObject({ key: "final", state: "locked", advanceCount: 1 });
    expect(result.round.revision).toBeGreaterThan(0);
    expect(result.round.scoreVersion).toBeGreaterThan(0);
    expect(result.session).toMatchObject({ mode: "formal", scope: "judging" });
    expect(result.facts).toHaveLength(3);
    expect(result.facts[0]).toMatchObject({ seatId: fixture.seatId, version: 1, correction: null });
    expect(result.ranking).toMatchObject({ status: "hold", revision: ranking.body.revision });
    expect(result.ranking?.tieGroups).toHaveLength(1);
    expect(result.performances).toHaveLength(3);
  });

  it("returns an empty projection when no session is running", async () => {
    const fixture = await seedLockedRound(db);
    await resolveRound(db, recoveryDeps(recoveryStaff), {
      commandId: `resolve-${fixture.activityId}`,
      activityId: fixture.activityId,
      roundId: fixture.roundId,
      scope: "judging",
    });
    await db.updateTable("execution_session").set({ status: "closed" })
      .where("activity_id", "=", fixture.activityId).execute();
    const result = await getRoundScores(db, {
      activityId: fixture.activityId, roundId: fixture.roundId, scope: "judging",
    });
    expect(result.session).toBeNull();
    expect(result.facts).toEqual([]);
    expect(result.ranking).toBeNull();
  });

  it("rejects a scope other than judging", async () => {
    const fixture = await seedLockedRound(db);
    await expect(getRoundScores(db, {
      activityId: fixture.activityId, roundId: fixture.roundId, scope: "publishing",
    })).rejects.toMatchObject({ code: "INVALID_INPUT" });
  });

  it("projects a finalized advancement decision", async () => {
    const fixture = await seedLockedRound(db);
    const ranking = await resolveRound(db, recoveryDeps(recoveryStaff), {
      commandId: `resolve-${fixture.activityId}`,
      activityId: fixture.activityId,
      roundId: fixture.roundId,
      scope: "judging",
    });
    const finalized = await finalizeAdvancement(db, recoveryDeps(recoveryStaff), {
      commandId: `advance-${fixture.activityId}`,
      activityId: fixture.activityId,
      roundId: fixture.roundId,
      expectedRankingRevision: ranking.body.revision,
      scope: "judging",
    });
    expect(finalized.body.status).toBe("needs_review");
    const result = await getRoundScores(db, {
      activityId: fixture.activityId, roundId: fixture.roundId, scope: "judging",
    });
    expect(result.advancement).toMatchObject({ status: "needs_review" });
    expect(result.advancement?.decisions).toHaveLength(3);
  });

  it("projects an open score correction", async () => {
    const fixture = await seedLockedRound(db);
    await resolveRound(db, recoveryDeps(recoveryStaff), {
      commandId: `resolve-${fixture.activityId}`,
      activityId: fixture.activityId,
      roundId: fixture.roundId,
      scope: "judging",
    });
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
    const before = await getRoundScores(db, {
      activityId: fixture.activityId, roundId: fixture.roundId, scope: "judging",
    });
    const fact = before.facts[0]!;
    await openScoreCorrection(db, recoveryDeps(recoveryStaff), {
      commandId: `open-${fixture.activityId}`,
      activityId: fixture.activityId,
      roundId: fixture.roundId,
      performanceId: fact.performanceId,
      scoreFactId: fact.id,
      panelSnapshotId: fact.panelSnapshotId,
      reason: "看错分",
      scope: "judging",
    });
    const after = await getRoundScores(db, {
      activityId: fixture.activityId, roundId: fixture.roundId, scope: "judging",
    });
    expect(after.facts.find((item) => item.id === fact.id)?.correction)
      .toMatchObject({ state: "open" });
  });
});
