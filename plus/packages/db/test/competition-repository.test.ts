import { randomUUID } from "node:crypto";

import type { Kysely } from "kysely";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  closeDb,
  createDb,
  getPerformanceForUpdate,
  getRoundByKeyForUpdate,
  insertPerformance,
  insertRound,
  migrate,
} from "../src/index.js";
import type { Database, StoredPerformance, StoredRound } from "../src/index.js";

const connectionString = process.env.ARTFLOW_PLUS_DATABASE_URL;
if (process.env.REQUIRE_DB === "1" && connectionString === undefined) {
  throw new Error("REQUIRE_DB=1 but ARTFLOW_PLUS_DATABASE_URL is unset.");
}
const schema = `artflow_competition_repository_${Date.now()}_${process.pid}`;

let db: Kysely<Database>;
let admin: Client;

async function seedActivity(): Promise<string> {
  const activityId = `act-${randomUUID()}`;
  await db.insertInto("activity").values({
    id: activityId,
    title: "Competition repository",
    status: "active",
    revision: 1,
    enabled_capabilities: JSON.stringify(["competition"]),
    active_definition_version: 1,
  }).execute();
  return activityId;
}

function round(activityId: string): StoredRound {
  return {
    id: `round-${activityId}`,
    activityId,
    roundKey: "round-1",
    releaseVersion: 1,
    state: "prepared",
    revision: 0,
    scoreVersion: 0,
    minimumJudges: 3,
    judgeCount: 5,
    completionMode: "minimum_valid",
    advanceCount: 10,
    currentPanelId: null,
    lockedAt: null,
  };
}

describe.skipIf(!connectionString)("competition persistence on PostgreSQL", () => {
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

  it("enforces one round key per activity and locks it by key", async () => {
    const activityId = await seedActivity();
    const value = round(activityId);
    await insertRound(db, value);
    await expect(insertRound(db, value)).rejects.toThrow();
    await expect(getRoundByKeyForUpdate(db, activityId, "round-1")).resolves.toMatchObject({
      id: value.id,
      revision: 0,
      state: "prepared",
    });
  });

  it("enforces one performance per contestant in a round", async () => {
    const activityId = await seedActivity();
    const value = round(activityId);
    await insertRound(db, value);
    const performance: StoredPerformance = {
      id: `performance-${activityId}`,
      activityId,
      roundId: value.id,
      contestantId: "contestant-a",
      sequence: 1,
      state: "open",
      contextVersion: 1,
    };
    await insertPerformance(db, performance);
    await expect(insertPerformance(db, { ...performance, id: `${performance.id}-duplicate` })).rejects.toThrow();
    await expect(getPerformanceForUpdate(db, performance.id)).resolves.toMatchObject({
      contestantId: "contestant-a",
      contextVersion: 1,
    });
  });
});
