import { randomUUID } from "node:crypto";

import { closeDb, createDb, migrate } from "@artflow-plus/db";
import type { Database } from "@artflow-plus/db";
import type { ActorContext } from "@artflow-plus/domain";
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
const schema = `artflow_api_analytics_${Date.now()}_${process.pid}`;

let db: Kysely<Database>;
let admin: Client;
let analyticsApp: FastifyInstance;
let forbiddenApp: FastifyInstance;

const deps: RuntimeDeps = {
  now: () => "2026-10-28T12:00:00.000Z",
  newEventId: () => randomUUID(),
};
const analyticsActor: ActorContext = {
  actorId: "analytics-staff",
  actorType: "user",
  roles: ["staff"],
  permissions: ["registration.review"],
};
const forbiddenActor: ActorContext = {
  actorId: "no-analytics",
  actorType: "user",
  roles: ["participant"],
  permissions: [],
};

describe.skipIf(!connectionString)("activity analytics API", () => {
  beforeAll(async () => {
    if (connectionString === undefined) return;
    admin = new Client({ connectionString });
    await admin.connect();
    await admin.query(`CREATE SCHEMA "${schema}"`);
    db = createDb({ connectionString, schema });
    await migrate(db);
    await db.insertInto("activity").values({
      id: "api-analytics-activity",
      public_code: "API-ANALYTICS",
      title: "API 运营分析",
      status: "draft",
      revision: 0,
      enabled_capabilities: JSON.stringify([]),
      active_definition_version: 1,
    }).execute();
    analyticsApp = await buildApp({ db, deps, actor: analyticsActor });
    forbiddenApp = await buildApp({ db, deps, actor: forbiddenActor });
    await Promise.all([analyticsApp.ready(), forbiddenApp.ready()]);
  });

  afterAll(async () => {
    if (connectionString === undefined) return;
    await Promise.all([analyticsApp.close(), forbiddenApp.close()]);
    await closeDb(db);
    await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
    await admin.end();
  });

  it("serves aggregate analytics to a narrow analytics read surface", async () => {
    const response = await analyticsApp.inject({
      method: "GET",
      url: "/api/activities/api-analytics-activity/operations/analytics",
    });

    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toMatchObject({
      activity: { id: "api-analytics-activity", title: "API 运营分析" },
      registration: { total: 0, byStatus: {} },
      voting: { validBallots: 0 },
      attention: [],
    });
    expect(response.body).not.toContain("password");
  });

  it("refuses actors without analytics permission and hides missing activities", async () => {
    const forbidden = await forbiddenApp.inject({
      method: "GET",
      url: "/api/activities/api-analytics-activity/operations/analytics",
    });
    expect(forbidden.statusCode).toBe(403);

    const missing = await analyticsApp.inject({
      method: "GET",
      url: "/api/activities/does-not-exist/operations/analytics",
    });
    expect(missing.statusCode).toBe(404);
  });
});
