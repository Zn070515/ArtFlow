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
const schema = `artflow_api_public_event_${Date.now()}_${process.pid}`;

let app: FastifyInstance;
let db: Kysely<Database>;
let admin: Client;

const deps: RuntimeDeps = {
  now: () => new Date().toISOString(),
  newEventId: () => randomUUID(),
};

async function seed(status: "draft" | "active" | "closed" | "archived" = "active") {
  const activityId = `act-${randomUUID()}`;
  const publicCode = `SITE-${randomUUID()}`;
  await db.insertInto("activity").values({
    id: activityId,
    public_code: publicCode,
    title: "春日声场",
    status,
    revision: 1,
    enabled_capabilities: JSON.stringify(["publishing"]),
    active_definition_version: 1,
  }).execute();
  await db.insertInto("activity_public_profile").values({
    activity_id: activityId,
    tagline: "春日",
    description: "介绍",
    venue: "剧场",
    starts_at: new Date("2026-04-18T11:00:00.000Z"),
    ends_at: new Date("2026-04-18T13:30:00.000Z"),
    organizer: "学生会",
    contact: "联系",
    announcement: "公告",
    announcements: JSON.stringify([]),
    faq: JSON.stringify([]),
    links: JSON.stringify([]),
    participants_visible: false,
    revision: 1,
    updated_by: "seed",
    updated_at: new Date("2026-04-01T10:00:00.000Z"),
  }).execute();
  return { activityId, publicCode };
}

describe.skipIf(!connectionString)("public event site route", () => {
  beforeAll(async () => {
    if (!connectionString) return;
    admin = new Client({ connectionString });
    await admin.connect();
    await admin.query(`CREATE SCHEMA "${schema}"`);
    db = createDb({ connectionString, schema });
    await migrate(db);
    app = await buildApp({ db, deps, enableRuntimeFacts: true });
    await app.ready();
  });

  afterAll(async () => {
    if (!connectionString) return;
    await app.close();
    await closeDb(db);
    await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
    await admin.end();
  });

  it("returns the public event without internal ids", async () => {
    const { activityId, publicCode } = await seed("active");
    const response = await app.inject({
      method: "GET",
      url: `/api/public/events/${publicCode}`,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      activity: { publicCode, title: "春日声场", status: "active" },
      profile: { tagline: "春日", venue: "剧场" },
    });
    expect(response.body).not.toContain(activityId);
  });

  it("returns 404 for missing, draft and archived activities", async () => {
    const draft = await seed("draft");
    const archived = await seed("archived");
    for (const publicCode of ["NOPE", draft.publicCode, archived.publicCode]) {
      const response = await app.inject({
        method: "GET",
        url: `/api/public/events/${publicCode}`,
      });
      expect(response.statusCode).toBe(404);
    }
  });
});
