import { randomUUID } from "node:crypto";

import { closeDb, createDb, migrate } from "@artflow-plus/db";
import type { Database } from "@artflow-plus/db";
import type { ActorContext } from "@artflow-plus/domain";
import { issueTicket, type RuntimeDeps } from "@artflow-plus/runtime";
import type { FastifyInstance } from "fastify";
import { Client } from "pg";
import type { Kysely } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { buildApp } from "../src/app.js";

const connectionString = process.env.ARTFLOW_PLUS_DATABASE_URL;
if (process.env.REQUIRE_DB === "1" && connectionString === undefined) {
  throw new Error("REQUIRE_DB=1 but ARTFLOW_PLUS_DATABASE_URL is unset.");
}
const schema = `artflow_api_public_ticket_${Date.now()}_${process.pid}`;
const credentialSecret = "test-credential-secret-0123456789";

let db: Kysely<Database>;
let admin: Client;
let app: FastifyInstance;
let credential = "";

const staff: ActorContext = {
  actorId: "ticket-staff",
  actorType: "user",
  roles: ["staff"],
  permissions: ["ticket.manage"],
};
const deps: RuntimeDeps = {
  actor: staff,
  credentialSecret,
  now: () => new Date().toISOString(),
  newEventId: () => randomUUID(),
};

describe.skipIf(!connectionString)("public ticket lookup", () => {
  beforeAll(async () => {
    if (!connectionString) return;
    admin = new Client({ connectionString });
    await admin.connect();
    await admin.query(`CREATE SCHEMA "${schema}"`);
    db = createDb({ connectionString, schema });
    await migrate(db);
    await db.insertInto("activity").values({
      id: "act-ticket",
      public_code: "TICKET-1",
      title: "电子票活动",
      status: "active",
      revision: 1,
      enabled_capabilities: JSON.stringify(["ticketing"]),
      active_definition_version: 1,
    }).execute();
    const issued = await issueTicket(db, deps, { commandId: randomUUID(), activityId: "act-ticket" });
    if (issued.body.credential === undefined) throw new Error("credential missing");
    credential = issued.body.credential;
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

  it("returns the ticket and activity without echoing the credential", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/public/tickets/lookup",
      headers: { "content-type": "application/json" },
      payload: { credential },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      ticket: { state: "issued" },
      activity: { publicCode: "TICKET-1", title: "电子票活动" },
    });
    expect(response.body).not.toContain(credential);
  });
});
