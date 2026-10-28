import { randomUUID } from "node:crypto";

import { closeDb, createDb, migrate } from "@artflow-plus/db";
import type { Database } from "@artflow-plus/db";
import { authenticateTicketSession, issueTicket } from "@artflow-plus/runtime";
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
const schema = `artflow_api_ticket_redeem_${Date.now()}_${process.pid}`;
const credentialSecret = "api-ticket-replay-test-secret";
const staff: ActorContext = {
  actorId: "api-ticket-staff",
  actorType: "user",
  roles: ["staff"],
  permissions: ["ticket.manage"],
};
const deps: RuntimeDeps = {
  actor: staff,
  credentialSecret,
  now: () => "2026-10-28T10:00:00.000Z",
  newEventId: () => randomUUID(),
};

let app: FastifyInstance;
let db: Kysely<Database>;
let admin: Client;

function ticketSessionCookie(setCookie: unknown): string {
  const header = Array.isArray(setCookie) ? setCookie[0] : setCookie;
  if (typeof header !== "string") throw new Error("The ticket session cookie was not set.");
  const value = /^artflow_ticket_session=([^;]+)/.exec(header)?.[1];
  if (value === undefined) throw new Error("The ticket session cookie was not present.");
  return value;
}

describe.skipIf(!connectionString)("ticket redemption HTTP recovery", () => {
  beforeAll(async () => {
    if (connectionString === undefined) return;
    admin = new Client({ connectionString });
    await admin.connect();
    await admin.query(`CREATE SCHEMA "${schema}"`);
    db = createDb({ connectionString, schema });
    await migrate(db);
    app = await buildApp({ db, deps });
    await app.ready();
  });

  afterAll(async () => {
    if (connectionString === undefined) return;
    await app.close();
    await closeDb(db);
    await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
    await admin.end();
  });

  it("sets the recoverable HttpOnly cookie again on an idempotent replay", async () => {
    const activityId = `activity-${randomUUID()}`;
    await db.insertInto("activity").values({
      id: activityId,
      public_code: activityId,
      title: "Ticket replay test",
      status: "active",
      revision: 1,
      enabled_capabilities: JSON.stringify(["ticketing"]),
      active_definition_version: 1,
    }).execute();
    const issued = await issueTicket(db, deps, { commandId: "api-ticket-issue", activityId });
    const credential = issued.body.credential;
    if (credential === undefined) throw new Error("The test ticket credential was not issued.");
    const commandId = "api-ticket-redeem";

    const first = await app.inject({
      method: "POST",
      url: "/api/tickets/redeem",
      headers: { "content-type": "application/json", "idempotency-key": commandId },
      payload: { credential },
    });
    expect(first.statusCode).toBe(200);
    expect(first.json()).toMatchObject({ ticketId: issued.body.ticket.id, accessToken: null });
    const firstCookie = ticketSessionCookie(first.headers["set-cookie"]);

    const replay = await app.inject({
      method: "POST",
      url: "/api/tickets/redeem",
      headers: { "content-type": "application/json", "idempotency-key": commandId },
      payload: { credential },
    });
    expect(replay.statusCode).toBe(200);
    expect(replay.json()).toMatchObject({
      ticketId: issued.body.ticket.id,
      sessionId: first.json().sessionId,
      accessToken: null,
    });
    const replayCookie = ticketSessionCookie(replay.headers["set-cookie"]);
    expect(replayCookie).toBe(firstCookie);
    await expect(authenticateTicketSession(db, replayCookie, new Date("2026-10-28T10:01:00.000Z"))).resolves.toMatchObject({
      ticketId: issued.body.ticket.id,
    });
  });
});
