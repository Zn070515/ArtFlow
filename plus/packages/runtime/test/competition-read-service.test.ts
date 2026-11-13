import { closeDb, createDb, migrate } from "@artflow-plus/db";
import type { Database } from "@artflow-plus/db";
import { Client } from "pg";
import type { Kysely } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { getRoundScores } from "../src/index.js";
import { seedLockedRound } from "./helpers/recovery-fixture.js";

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
    const result = await getRoundScores(db, {
      activityId: fixture.activityId,
      roundId: fixture.roundId,
      scope: "judging",
    });
    expect(result.session).toMatchObject({ mode: "formal", scope: "judging" });
    expect(result.facts).toHaveLength(3);
    expect(result.facts[0]).toMatchObject({ seatId: fixture.seatId, version: 1, correction: null });
    expect(result.ranking).toMatchObject({ status: "hold" });
    expect(result.ranking?.tieGroups).toHaveLength(1);
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
