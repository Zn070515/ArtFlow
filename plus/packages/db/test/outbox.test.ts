import { randomUUID } from "node:crypto";

import type { Kysely } from "kysely";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  appendEvent,
  claimPendingEventsForPartition,
  closeDb,
  createDb,
  getOutboxRelayHealth,
  headSequence,
  listPendingPartitions,
  markPublished,
  migrate,
  readEventsSince,
  recordFailure,
  retryEvent,
  tryLockPartition,
} from "../src/index.js";
import type { Database } from "../src/index.js";

const connectionString = process.env.ARTFLOW_PLUS_DATABASE_URL;
if (process.env.REQUIRE_DB === "1" && connectionString === undefined) {
  throw new Error("REQUIRE_DB=1 but ARTFLOW_PLUS_DATABASE_URL is unset.");
}
const schema = `artflow_outbox_${Date.now()}_${process.pid}`;

let db: Kysely<Database>;
let otherDb: Kysely<Database>;
let admin: Client;

async function append(
  activityId: string,
  type: string,
  mode?: "test" | "rehearsal" | "formal",
): Promise<number> {
  return appendEvent(db, {
    eventId: `${type}-${randomUUID()}`,
    type,
    occurredAt: new Date().toISOString(),
    activityId,
    aggregateType: "activity",
    aggregateId: activityId,
    capability: "engine",
    revision: 1,
    ...(mode === undefined ? {} : { mode }),
    payload: { type },
  });
}

async function seedActivity(id: string): Promise<void> {
  await db.insertInto("activity").values({
    id,
    title: id,
    status: "active",
    revision: 1,
    enabled_capabilities: JSON.stringify([]),
    active_definition_version: 1,
  }).execute();
}

describe.skipIf(!connectionString)("outbox repository", () => {
  beforeAll(async () => {
    if (connectionString === undefined) return;
    admin = new Client({ connectionString });
    await admin.connect();
    await admin.query(`CREATE SCHEMA "${schema}"`);
    db = createDb({ connectionString, schema });
    otherDb = createDb({ connectionString, schema });
    await migrate(db);
  });

  afterAll(async () => {
    if (connectionString === undefined) return;
    await closeDb(db);
    await closeDb(otherDb);
    await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
    await admin.end();
  });

  it("appends events in sequence and reads them in order", async () => {
    const activity = `act-${randomUUID()}`;
    await seedActivity(activity);

    const first = await append(activity, "ActivityCreated");
    const second = await append(activity, "ActivityRenamed");

    expect(second).toBeGreaterThan(first);

    const events = await readEventsSince(db, { activityId: activity, after: 0, limit: 10 });
    expect(events.map((event) => event.type)).toEqual(["ActivityCreated", "ActivityRenamed"]);
    expect(events.map((event) => event.sequence)).toEqual([first, second]);

    const afterFirst = await readEventsSince(db, { activityId: activity, after: first, limit: 10 });
    expect(afterFirst.map((event) => event.type)).toEqual(["ActivityRenamed"]);
  });

  it("partitions execution events by mode but includes engine events in every feed", async () => {
    const activity = `act-${randomUUID()}`;
    await seedActivity(activity);
    await append(activity, "EngineNote");
    await append(activity, "FormalFact", "formal");
    await append(activity, "TestFact", "test");

    const formal = await readEventsSince(db, { activityId: activity, after: 0, limit: 10, mode: "formal" });
    expect(formal.map((event) => event.type)).toEqual(["EngineNote", "FormalFact"]);

    const test = await readEventsSince(db, { activityId: activity, after: 0, limit: 10, mode: "test" });
    expect(test.map((event) => event.type)).toEqual(["EngineNote", "TestFact"]);
  });

  it("computes the head sequence for an activity and mode", async () => {
    const activity = `act-${randomUUID()}`;
    await seedActivity(activity);
    await append(activity, "EngineNote");
    const newest = await append(activity, "FormalFact", "formal");
    await append(activity, "TestFact", "test");

    await expect(headSequence(db, activity)).resolves.toBeGreaterThanOrEqual(newest);
    await expect(headSequence(db, activity, "formal")).resolves.toBe(newest);
    await expect(headSequence(db, activity, "formal", ["FormalFact"])).resolves.toBe(newest);
    await expect(headSequence(db, activity, "formal", ["Missing"])).resolves.toBe(0);
  });

  it("lists pending partitions once and skips published or dead-lettered events", async () => {
    const activity = `act-${randomUUID()}`;
    await seedActivity(activity);
    const first = await append(activity, "EngineNote");
    const second = await append(activity, "EngineNote");

    const before = await listPendingPartitions(db, 100);
    expect(before.filter((partition) => partition.activityId === activity)).toHaveLength(1);

    await markPublished(db, first);
    const afterPublished = await listPendingPartitions(db, 100);
    expect(afterPublished.filter((partition) => partition.activityId === activity)).toHaveLength(1);

    await markPublished(db, second);
    const afterAll = await listPendingPartitions(db, 100);
    expect(afterAll.filter((partition) => partition.activityId === activity)).toHaveLength(0);
  });

  it("orders blocked partitions after healthy ones", async () => {
    const healthy = `act-${randomUUID()}`;
    const blocked = `act-${randomUUID()}`;
    await seedActivity(healthy);
    await seedActivity(blocked);
    const healthyEvent = await append(healthy, "FormalFact", "formal");
    await append(blocked, "FormalFact", "formal");
    await db.insertInto("execution_projection").values({
      activity_id: blocked,
      mode: "formal",
      last_sequence: 0,
      state: JSON.stringify({}),
      status: "blocked",
      blocked_sequence: 1,
      blocked_reason: "boom",
    }).execute();

    const partitions = await listPendingPartitions(db, 100);
    const healthyIndex = partitions.findIndex((partition) => partition.activityId === healthy);
    const blockedIndex = partitions.findIndex((partition) => partition.activityId === blocked);
    expect(healthyIndex).toBeGreaterThanOrEqual(0);
    expect(blockedIndex).toBeGreaterThan(healthyIndex);

    await markPublished(db, healthyEvent);
  });

  it("claims only the requested partition, oldest first, while another relay holds the lock", async () => {
    const activity = `act-${randomUUID()}`;
    await seedActivity(activity);
    const first = await append(activity, "EngineNote");
    const second = await append(activity, "EngineNote");

    await db.transaction().execute(async (trx) => {
      expect(await tryLockPartition(trx, `${activity}:null`)).toBe(true);
      const claimed = await claimPendingEventsForPartition(trx, activity, null, 1);
      expect(claimed.map((event) => event.sequence)).toEqual([first]);

      const competing = await otherDb.transaction().execute(async (other) => {
        // The partition lock is what serializes relays; a relay that cannot
        // take it never claims. Skip-locked is the second line of defence and
        // must never hand out the row the first relay still holds.
        expect(await tryLockPartition(other, `${activity}:null`)).toBe(false);
        return claimPendingEventsForPartition(other, activity, null, 10);
      });
      expect(competing.map((event) => event.sequence)).toEqual([second]);
    });

    const afterCommit = await claimPendingEventsForPartition(db, activity, null, 10);
    expect(afterCommit.length).toBeGreaterThanOrEqual(2);

    for (const event of afterCommit) {
      await markPublished(db, event.sequence);
    }
  });

  it("retries a dead letter and dead-letters after the retry budget", async () => {
    const activity = `act-${randomUUID()}`;
    await seedActivity(activity);
    const sequence = await append(activity, "EngineNote");

    const firstFailure = await recordFailure(db, sequence, "first", 2);
    expect(firstFailure).toEqual({ attempts: 1, deadLettered: false });

    const secondFailure = await recordFailure(db, sequence, "second", 2);
    expect(secondFailure).toEqual({ attempts: 2, deadLettered: true });

    const pendingBeforeRetry = await listPendingPartitions(db, 100);
    expect(pendingBeforeRetry.filter((partition) => partition.activityId === activity)).toHaveLength(0);

    await retryEvent(db, sequence);
    const pendingAfterRetry = await listPendingPartitions(db, 100);
    expect(pendingAfterRetry.filter((partition) => partition.activityId === activity)).toHaveLength(1);

    const health = await getOutboxRelayHealth(db);
    expect(health.pendingCount).toBeGreaterThan(0);
  });
});
