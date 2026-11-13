import { randomUUID } from "node:crypto";

import type { Kysely } from "kysely";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  blockLiveState,
  closeDb,
  createDb,
  deleteLiveState,
  getLiveState,
  migrate,
  upsertLiveState,
} from "../src/index.js";
import type { Database } from "../src/index.js";

const connectionString = process.env.ARTFLOW_PLUS_DATABASE_URL;
if (process.env.REQUIRE_DB === "1" && connectionString === undefined) {
  throw new Error("REQUIRE_DB=1 but ARTFLOW_PLUS_DATABASE_URL is unset.");
}
const schema = `artflow_live_state_${Date.now()}_${process.pid}`;

let db: Kysely<Database>;
let admin: Client;
let activityId: string;

const aggregateType = "competition";
const aggregateId = "round-1";

describe.skipIf(!connectionString)("live state repository", () => {
  beforeAll(async () => {
    if (connectionString === undefined) return;
    admin = new Client({ connectionString });
    await admin.connect();
    await admin.query(`CREATE SCHEMA "${schema}"`);
    db = createDb({ connectionString, schema });
    await migrate(db);
    activityId = `act-${randomUUID()}`;
    await db.insertInto("activity").values({
      id: activityId,
      title: "Live state",
      status: "active",
      revision: 1,
      enabled_capabilities: JSON.stringify(["competition"]),
      active_definition_version: 1,
    }).execute();
  });

  afterAll(async () => {
    if (connectionString === undefined) return;
    await closeDb(db);
    await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
    await admin.end();
  });

  it("returns null for an aggregate that has no projection yet", async () => {
    await expect(getLiveState(db, activityId, aggregateType, aggregateId)).resolves.toBeNull();
  });

  it("inserts a running projection and reads it back", async () => {
    await upsertLiveState(db, {
      activityId,
      aggregateType,
      aggregateId,
      lastSequence: 3,
      state: { status: "running", cursor: 3 },
    });

    const stored = await getLiveState(db, activityId, aggregateType, aggregateId);
    expect(stored).not.toBeNull();
    expect(stored?.lastSequence).toBe(3);
    expect(stored?.status).toBe("running");
    expect(stored?.state).toEqual({ status: "running", cursor: 3 });
    expect(stored?.blockedSequence).toBeUndefined();
  });

  it("ignores a stale projection that would move the sequence backwards", async () => {
    await upsertLiveState(db, {
      activityId,
      aggregateType,
      aggregateId,
      lastSequence: 9,
      state: { cursor: 9 },
    });
    await upsertLiveState(db, {
      activityId,
      aggregateType,
      aggregateId,
      lastSequence: 4,
      state: { cursor: 4 },
    });

    const stored = await getLiveState(db, activityId, aggregateType, aggregateId);
    expect(stored?.lastSequence).toBe(9);
    expect(stored?.state).toEqual({ cursor: 9 });
  });

  it("does not clear a blocked projection on a normal upsert", async () => {
    await blockLiveState(db, {
      activityId,
      aggregateType,
      aggregateId,
      sequence: 10,
      reason: "projection failed",
    });
    await upsertLiveState(db, {
      activityId,
      aggregateType,
      aggregateId,
      lastSequence: 11,
      state: { cursor: 11 },
    });

    const stored = await getLiveState(db, activityId, aggregateType, aggregateId);
    expect(stored?.status).toBe("blocked");
    expect(stored?.blockedSequence).toBe(10);
    expect(stored?.blockedReason).toBe("projection failed");
    expect(stored?.lastSequence).toBe(9);
  });

  it("clears the block only for an explicit rebuild", async () => {
    await upsertLiveState(db, {
      activityId,
      aggregateType,
      aggregateId,
      lastSequence: 12,
      state: { cursor: 12 },
      force: true,
    });

    const stored = await getLiveState(db, activityId, aggregateType, aggregateId);
    expect(stored?.status).toBe("running");
    expect(stored?.lastSequence).toBe(12);
    expect(stored?.blockedSequence).toBeUndefined();
    expect(stored?.blockedReason).toBeUndefined();
  });

  it("blocks an aggregate that has no projection row yet", async () => {
    await blockLiveState(db, {
      activityId,
      aggregateType,
      aggregateId: "round-2",
      sequence: 1,
      reason: "no projection",
    });

    const stored = await getLiveState(db, activityId, aggregateType, "round-2");
    expect(stored).toMatchObject({
      lastSequence: 0,
      status: "blocked",
      blockedSequence: 1,
      blockedReason: "no projection",
      state: {},
    });
  });

  it("deletes only the addressed projection", async () => {
    await deleteLiveState(db, activityId, aggregateType, aggregateId);

    await expect(getLiveState(db, activityId, aggregateType, aggregateId)).resolves.toBeNull();
    await expect(getLiveState(db, activityId, aggregateType, "round-2")).resolves.not.toBeNull();
  });

  it("keeps the highest sequence when two projections race", async () => {
    const activity = `act-${randomUUID()}`;
    await db.insertInto("activity").values({
      id: activity,
      title: "Race",
      status: "active",
      revision: 1,
      enabled_capabilities: JSON.stringify(["competition"]),
      active_definition_version: 1,
    }).execute();

    await Promise.all([
      upsertLiveState(db, { activityId: activity, aggregateType, aggregateId: "round-r", lastSequence: 5, state: { cursor: 5 } }),
      upsertLiveState(db, { activityId: activity, aggregateType, aggregateId: "round-r", lastSequence: 7, state: { cursor: 7 } }),
    ]);

    const stored = await getLiveState(db, activity, aggregateType, "round-r");
    expect(stored?.lastSequence).toBe(7);
    expect(stored?.state).toEqual({ cursor: 7 });
  });
});
