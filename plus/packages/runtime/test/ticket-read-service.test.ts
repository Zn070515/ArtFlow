import { randomUUID } from "node:crypto";

import { Client } from "pg";
import type { Kysely } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { closeDb, createDb, getTicket, migrate } from "@artflow-plus/db";
import type { Database } from "@artflow-plus/db";
import type { ActorContext } from "@artflow-plus/domain";

import type { RuntimeDeps } from "../src/deps.js";
import { getPublicTicketLookup } from "../src/ticket-read-service.js";
import { issueTicket, revokeTicket, rotateTicketCredential } from "../src/ticket-service.js";

const connectionString = process.env.ARTFLOW_PLUS_DATABASE_URL;
if (process.env.REQUIRE_DB === "1" && connectionString === undefined) {
  throw new Error("REQUIRE_DB=1 but ARTFLOW_PLUS_DATABASE_URL is unset.");
}
const schema = `artflow_ticket_read_${Date.now()}_${process.pid}`;
let db: Kysely<Database>;
let admin: Client;

const staff: ActorContext = {
  actorId: "ticket-staff",
  actorType: "user",
  roles: ["staff"],
  permissions: ["ticket.manage"],
};
const secret = "test-credential-secret-0123456789";

function deps(): RuntimeDeps {
  return {
    actor: staff,
    credentialSecret: secret,
    now: () => "2026-04-18T10:00:00.000Z",
    newEventId: () => randomUUID(),
  };
}

async function seedActivity(status: "active" | "closed" | "draft" | "archived" = "active"): Promise<void> {
  await db.insertInto("activity").values({
    id: "act-ticket",
    public_code: "TICKET-1",
    title: "电子票活动",
    status,
    revision: 1,
    enabled_capabilities: JSON.stringify(["ticketing"]),
    active_definition_version: 1,
  }).execute();
}

describe.skipIf(!connectionString)("public ticket lookup", () => {
  beforeAll(async () => {
    if (!connectionString) return;
    admin = new Client({ connectionString });
    await admin.connect();
    await admin.query(`CREATE SCHEMA "${schema}"`);
    db = createDb({ connectionString, schema });
    await migrate(db);
    await seedActivity();
  });

  afterAll(async () => {
    if (!connectionString) return;
    await closeDb(db);
    await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
    await admin.end();
  });

  it("returns the ticket and public activity without changing state", async () => {
    const issued = await issueTicket(db, deps(), { commandId: randomUUID(), activityId: "act-ticket" });
    const credential = issued.body.credential;
    if (credential === undefined) throw new Error("credential missing");
    const lookup = await getPublicTicketLookup(db, deps(), credential);
    expect(lookup.ticket.publicCode).toBe(issued.body.ticket.publicCode);
    expect(lookup.ticket.state).toBe("issued");
    expect(lookup.activity).toMatchObject({ publicCode: "TICKET-1", title: "电子票活动" });
    expect((await getTicket(db, issued.body.ticket.id))?.state).toBe("issued");
  });

  it("rejects rotated, archived and revoked tickets", async () => {
    const issued = await issueTicket(db, deps(), { commandId: randomUUID(), activityId: "act-ticket" });
    const credential = issued.body.credential;
    if (credential === undefined) throw new Error("credential missing");
    const rotated = await rotateTicketCredential(db, deps(), {
      commandId: randomUUID(),
      activityId: "act-ticket",
      ticketId: issued.body.ticket.id,
    });
    await expect(getPublicTicketLookup(db, deps(), credential))
      .rejects.toMatchObject({ code: "INVALID_TICKET" });
    const currentCredential = rotated.body.credential;
    if (currentCredential === undefined || currentCredential === null) {
      throw new Error("rotated credential missing");
    }
    await db.updateTable("activity").set({ status: "archived" }).where("id", "=", "act-ticket").execute();
    await expect(getPublicTicketLookup(db, deps(), currentCredential))
      .rejects.toMatchObject({ code: "TICKET_ACTIVITY_NOT_PUBLIC" });
    await db.updateTable("activity").set({ status: "active" }).where("id", "=", "act-ticket").execute();
    await revokeTicket(db, deps(), {
      commandId: randomUUID(),
      activityId: "act-ticket",
      ticketId: issued.body.ticket.id,
      reason: "测试",
    });
    await expect(getPublicTicketLookup(db, deps(), currentCredential))
      .rejects.toMatchObject({ code: "TICKET_REVOKED" });
  });
});
