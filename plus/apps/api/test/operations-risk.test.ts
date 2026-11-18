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
const schema = `artflow_api_operations_risk_${Date.now()}_${process.pid}`;

let db: Kysely<Database>;
let admin: Client;
let analyticsApp: FastifyInstance;
let forbiddenApp: FastifyInstance;

const deps: RuntimeDeps = {
  now: () => "2026-11-18T12:00:00.000Z",
  newEventId: () => randomUUID(),
};
const analyticsActor: ActorContext = {
  actorId: "risk-api-staff",
  actorType: "user",
  roles: ["staff"],
  permissions: ["registration.review"],
};
const forbiddenActor: ActorContext = {
  actorId: "risk-api-tasks",
  actorType: "user",
  roles: ["staff"],
  permissions: ["tasks.manage"],
};

describe.skipIf(!connectionString)("operations risk API", () => {
  beforeAll(async () => {
    if (connectionString === undefined) return;
    admin = new Client({ connectionString });
    await admin.connect();
    await admin.query(`CREATE SCHEMA "${schema}"`);
    db = createDb({ connectionString, schema });
    await migrate(db);
    await db.insertInto("activity").values({
      id: "api-risk-activity",
      public_code: "API-RISK",
      title: "API 风险活动",
      status: "active",
      revision: 1,
      enabled_capabilities: JSON.stringify(["registration", "questionnaire"]),
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

  it("serves the risk board to an analytics reader", async () => {
    const response = await analyticsApp.inject({
      method: "GET",
      url: "/api/operations/risks",
    });

    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toMatchObject({
      activities: [
        {
          activity: {
            id: "api-risk-activity",
            publicCode: "API-RISK",
            status: "active",
          },
        },
      ],
    });
  });

  it("rejects a user without an analytics permission", async () => {
    const response = await forbiddenApp.inject({
      method: "GET",
      url: "/api/operations/risks",
    });

    expect(response.statusCode, response.body).toBe(403);
  });
});
