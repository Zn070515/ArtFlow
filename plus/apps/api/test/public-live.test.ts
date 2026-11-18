import { randomUUID } from "node:crypto";

import { closeDb, createDb, migrate } from "@artflow-plus/db";
import type { Database } from "@artflow-plus/db";
import type { RuntimeDeps } from "@artflow-plus/runtime";
import type { FastifyInstance } from "fastify";
import { Client } from "pg";
import type { Kysely } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { buildApp } from "../src/app.js";

const connectionString = process.env.ARTFLOW_PLUS_DATABASE_URL;
if (process.env.REQUIRE_DB === "1" && connectionString === undefined) {
  throw new Error("REQUIRE_DB=1 but ARTFLOW_PLUS_DATABASE_URL is unset.");
}
const schema = `artflow_api_public_live_${Date.now()}_${process.pid}`;

let db: Kysely<Database>;
let admin: Client;
let app: FastifyInstance;

const deps: RuntimeDeps = {
  now: () => new Date().toISOString(),
  newEventId: () => randomUUID(),
};

describe.skipIf(!connectionString)("public live routes", () => {
  beforeAll(async () => {
    if (!connectionString) return;
    admin = new Client({ connectionString });
    await admin.connect();
    await admin.query(`CREATE SCHEMA "${schema}"`);
    db = createDb({ connectionString, schema });
    await migrate(db);
    await db.insertInto("activity").values({
      id: "act-live",
      public_code: "LIVE-1",
      title: "现场活动",
      status: "active",
      revision: 1,
      enabled_capabilities: JSON.stringify(["schedule", "voting"]),
      active_definition_version: 1,
    }).execute();
    const entries = [
      { id: "entry-1", slotKey: "opening", title: "开场舞", startsAt: "2026-04-18T19:00:00.000Z" },
      { id: "entry-2", slotKey: "program", title: "第一首", startsAt: "2026-04-18T19:10:00.000Z" },
      { id: "entry-3", slotKey: "program", title: "第二首", startsAt: "2026-04-18T19:20:00.000Z" },
    ];
    for (const [index, entry] of entries.entries()) {
      await db.insertInto("schedule_entry").values({
        id: entry.id,
        activity_id: "act-live",
        mode: "formal",
        position: index,
        slot_key: entry.slotKey,
        participant_id: null,
        title: entry.title,
        note: "",
        starts_at: new Date(entry.startsAt),
        revision: 0,
        created_at: new Date("2026-04-18T10:00:00.000Z"),
        updated_at: new Date("2026-04-18T10:00:00.000Z"),
      }).execute();
    }
    await db.insertInto("schedule_release").values({
      id: "release-live",
      activity_id: "act-live",
      mode: "formal",
      version: 1,
      snapshot: JSON.stringify({
        version: 1,
        schemaVersion: 1,
        releasedAt: "2026-04-18T10:00:00.000Z",
        entries: [
          { entryId: "entry-1", order: 1, slotKey: "opening", slotLabel: "开场", participantId: null, title: "开场舞", note: "", startsAt: "2026-04-18T19:00:00.000Z" },
          { entryId: "entry-2", order: 2, slotKey: "program", slotLabel: "第一轮", participantId: null, title: "第一首", note: "", startsAt: "2026-04-18T19:10:00.000Z" },
          { entryId: "entry-3", order: 3, slotKey: "program", slotLabel: "第一轮", participantId: null, title: "第二首", note: "", startsAt: "2026-04-18T19:20:00.000Z" },
        ],
      }),
      note: "",
      released_at: new Date("2026-04-18T10:00:00.000Z"),
      revoked_at: null,
    }).execute();
    await db.insertInto("schedule_current").values({
      activity_id: "act-live",
      mode: "formal",
      entry_id: "entry-2",
      updated_at: new Date("2026-04-18T10:00:00.000Z"),
    }).execute();
    await db.insertInto("vote_session").values({
      id: "vote-open",
      activity_id: "act-live",
      definition_version: 1,
      mode: "formal",
      purpose: "popularity",
      selection_type: "single",
      max_selections: 1,
      identity_policy: "browser",
      scoring_rule: JSON.stringify({ kind: "ballot_share_percent", scale: 100, decimals: 2 }),
      status: "open",
      revision: 0,
      opened_at: new Date("2026-04-18T10:00:00.000Z"),
      closed_at: null,
    }).execute();
    app = await buildApp({ db, deps });
    await app.ready();
  });

  afterAll(async () => {
    if (!connectionString) return;
    await app.close();
    await closeDb(db);
    await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
    await admin.end();
  });

  it("returns the current program without participant ids", async () => {
    const response = await app.inject({ method: "GET", url: "/api/public/activities/LIVE-1/current" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ current: { title: "第一首", order: 2 } });
    expect(response.json().next.map((entry: { title: string }) => entry.title)).toEqual(["第二首"]);
    expect(response.body).not.toContain("participantId");
  });

  it("returns the open formal vote locator and 404 for archived", async () => {
    const vote = await app.inject({ method: "GET", url: "/api/public/activities/LIVE-1/voting" });
    expect(vote.json()).toEqual({ sessionId: "vote-open", status: "open" });
    await db.updateTable("activity").set({ status: "archived" }).where("id", "=", "act-live").execute();
    expect((await app.inject({ method: "GET", url: "/api/public/activities/LIVE-1/current" })).statusCode).toBe(404);
    expect((await app.inject({ method: "GET", url: "/api/public/activities/LIVE-1/voting" })).statusCode).toBe(404);
    await db.updateTable("activity").set({ status: "active" }).where("id", "=", "act-live").execute();
  });
});
