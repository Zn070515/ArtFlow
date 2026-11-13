import { randomUUID } from "node:crypto";

import { closeDb, createDb, insertLocalAccount, insertTicket, insertTicketAccessSession, migrate } from "@artflow-plus/db";
import type { Database } from "@artflow-plus/db";
import { hashPassword } from "@artflow-plus/runtime";
import type { RuntimeDeps } from "@artflow-plus/runtime";
import type { FastifyInstance } from "fastify";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Kysely } from "kysely";

import { buildApp } from "../src/app.js";

const connectionString = process.env.ARTFLOW_PLUS_DATABASE_URL;
if (process.env.REQUIRE_DB === "1" && connectionString === undefined) {
  throw new Error("REQUIRE_DB=1 but ARTFLOW_PLUS_DATABASE_URL is unset.");
}
const schema = `artflow_ticketing_api_${Date.now()}_${process.pid}`;
const activityId = "act_ticketing_api";

let app: FastifyInstance;
let db: Kysely<Database>;
let admin: Client;
let ticketManagerToken = "";
let outsiderToken = "";

const deps: RuntimeDeps = {
  now: () => new Date(Date.UTC(2026, 10, 13, 10, 0, 0)).toISOString(),
  newEventId: () => randomUUID(),
};

async function tokenFor(username: string, password: string): Promise<string> {
  const response = await app.inject({
    method: "POST",
    url: "/api/auth/token",
    headers: { "content-type": "application/json" },
    payload: { username, password },
  });
  expect(response.statusCode).toBe(200);
  return (response.json() as { token: string }).token;
}

describe.skipIf(!connectionString)("ticketing state read", () => {
  beforeAll(async () => {
    if (connectionString === undefined) return;
    admin = new Client({ connectionString });
    await admin.connect();
    await admin.query(`CREATE SCHEMA "${schema}"`);
    db = createDb({ connectionString, schema });
    await migrate(db);
    await insertLocalAccount(db, {
      username: "ticket-manager",
      passwordDigest: hashPassword("ticket-manager-pass"),
      actor: {
        actorId: "ticket-manager",
        actorType: "user",
        roles: ["staff"],
        permissions: ["ticket.manage"],
      },
      active: true,
    });
    await insertLocalAccount(db, {
      username: "ticket-outsider",
      passwordDigest: hashPassword("ticket-outsider-pass"),
      actor: {
        actorId: "ticket-outsider",
        actorType: "user",
        roles: ["participant"],
        permissions: [],
      },
      active: true,
    });
    await db.insertInto("activity").values({
      id: activityId,
      public_code: "TICKET01",
      title: "Ticketing Activity",
      status: "active",
      revision: 1,
      enabled_capabilities: JSON.stringify(["ticketing"]),
      active_definition_version: 1,
    }).execute();
    await insertTicket(db, {
      id: "ticket-1",
      activityId,
      publicCode: "PUBLIC01",
      credentialDigest: "digest-1",
      credentialVersion: 2,
      state: "issued",
      issuedAt: "2026-11-13T09:00:00.000Z",
    });
    await insertTicketAccessSession(db, {
      id: "session-1",
      activity_id: activityId,
      ticket_id: "ticket-1",
      token_digest: "token-digest-1",
      expires_at: "2026-11-13T12:00:00.000Z",
      last_seen_at: null,
      revoked_at: null,
    });
    app = await buildApp({ db, deps, enableRuntimeFacts: false });
    await app.ready();
    ticketManagerToken = await tokenFor("ticket-manager", "ticket-manager-pass");
    outsiderToken = await tokenFor("ticket-outsider", "ticket-outsider-pass");
  });

  afterAll(async () => {
    if (connectionString === undefined) return;
    await app.close();
    await closeDb(db);
    await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
    await admin.end();
  });

  it("returns tickets and sessions without credential digests", async () => {
    const response = await app.inject({
      method: "GET",
      url: `/api/activities/${activityId}/ticketing/state`,
      headers: { authorization: `Bearer ${ticketManagerToken}` },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json() as {
      tickets: readonly Record<string, unknown>[];
      sessions: readonly Record<string, unknown>[];
    };
    expect(body.tickets).toEqual([
      expect.objectContaining({ id: "ticket-1", publicCode: "PUBLIC01", state: "issued", credentialVersion: 2 }),
    ]);
    expect(body.tickets[0]).not.toHaveProperty("credentialDigest");
    expect(body.sessions).toEqual([
      expect.objectContaining({ id: "session-1", ticketId: "ticket-1" }),
    ]);
    expect(body.sessions[0]).not.toHaveProperty("tokenDigest");
  });

  it("rejects an authenticated actor without ticket.manage", async () => {
    const response = await app.inject({
      method: "GET",
      url: `/api/activities/${activityId}/ticketing/state`,
      headers: { authorization: `Bearer ${outsiderToken}` },
    });
    expect(response.statusCode).toBe(403);
  });

  it("rejects an anonymous request", async () => {
    const response = await app.inject({
      method: "GET",
      url: `/api/activities/${activityId}/ticketing/state`,
    });
    expect(response.statusCode).toBe(401);
  });
});
