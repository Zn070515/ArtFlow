import { randomUUID } from "node:crypto";

import { closeDb, createDb, migrate } from "@artflow-plus/db";
import type { Database } from "@artflow-plus/db";
import { Client } from "pg";
import type { Kysely } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createActivityRealtimeTopic } from "../src/realtime-topics.js";

const connectionString = process.env.ARTFLOW_PLUS_DATABASE_URL;
if (process.env.REQUIRE_DB === "1" && connectionString === undefined) {
  throw new Error("REQUIRE_DB=1 but ARTFLOW_PLUS_DATABASE_URL is unset.");
}
const schema = `artflow_api_activity_topic_${Date.now()}_${process.pid}`;

let db: Kysely<Database>;
let admin: Client;

async function activity(): Promise<string> {
  const activityId = `act-${randomUUID()}`;
  await db.insertInto("activity").values({
    id: activityId,
    public_code: activityId,
    title: "Live",
    status: "active",
    revision: 1,
    enabled_capabilities: JSON.stringify(["competition"]),
    active_definition_version: 1,
  }).execute();
  return activityId;
}

async function event(activityId: string): Promise<string> {
  const row = await db.insertInto("outbox").values({
    event_id: `event-${randomUUID()}`,
    event_type: "ProbeEvent",
    payload: "{}",
    occurred_at: "2026-10-27T09:00:00Z",
    activity_id: activityId,
    aggregate_type: "activity",
    aggregate_id: activityId,
    capability: "engine",
    revision: 1,
    mode: "formal",
    scope: null,
    attempts: 0,
  }).returning("id").executeTakeFirstOrThrow();
  return String(row.id);
}

describe.skipIf(!connectionString)("activity realtime topic", () => {
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

  it("snapshots the newest outbox id and returns zero with no events", async () => {
    const activityId = await activity();
    const topic = createActivityRealtimeTopic(db);
    const target = { topic: `activity:${activityId}`, activityId, aggregateId: activityId };

    const empty = await topic.snapshot(target);
    expect(empty).toEqual({ seq: 0, data: { lastSequence: 0 } });

    const head = Number(await event(activityId));
    const snapshot = await topic.snapshot(target);
    expect(snapshot?.seq).toBe(head);
    expect(snapshot?.data).toEqual({ lastSequence: head });
  });

  it("authorizes operations permissions and the admin role", async () => {
    const activityId = await activity();
    const topic = createActivityRealtimeTopic(db);
    const target = { topic: `activity:${activityId}`, activityId, aggregateId: activityId };

    expect(
      await topic.authorize({ actorId: "p", roles: [], permissions: [] }, target),
    ).toBe(false);
    for (const permission of ["studio.manage", "competition.manage", "judge.manage"]) {
      expect(
        await topic.authorize({ actorId: "s", roles: [], permissions: [permission] }, target),
      ).toBe(true);
    }
    expect(
      await topic.authorize({ actorId: "a", roles: ["admin"], permissions: [] }, target),
    ).toBe(true);
  });

  it("returns no snapshot for an unknown activity", async () => {
    const topic = createActivityRealtimeTopic(db);
    expect(
      await topic.snapshot({ topic: "activity:nope", activityId: "nope", aggregateId: "nope" }),
    ).toBeNull();
  });
});
