import { randomUUID } from "node:crypto";

import type { Kysely } from "kysely";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  closeDb,
  createDb,
  findTicketAccessSession,
  findTicketByCredential,
  getTicket,
  getTicketForUpdate,
  insertTicket,
  insertTicketAccessSession,
  migrate,
  revokeTicketAccessSession,
  updateTicket,
} from "../src/index.js";
import type { Database, StoredTicket } from "../src/index.js";

const connectionString = process.env.ARTFLOW_PLUS_DATABASE_URL;
if (process.env.REQUIRE_DB === "1" && connectionString === undefined) {
  throw new Error("REQUIRE_DB=1 but ARTFLOW_PLUS_DATABASE_URL is unset.");
}
const schema = `artflow_ticket_${Date.now()}_${process.pid}`;

let db: Kysely<Database>;
let otherDb: Kysely<Database>;
let admin: Client;
let activityId: string;

function ticket(overrides: Partial<StoredTicket> = {}): StoredTicket {
  const id = `ticket-${randomUUID()}`;
  return {
    id,
    activityId,
    publicCode: `code-${randomUUID().slice(0, 8)}`,
    credentialDigest: `digest-${id}`,
    credentialVersion: 1,
    state: "issued",
    issuedAt: new Date().toISOString(),
    ...overrides,
  };
}

describe.skipIf(!connectionString)("voting ticket repository", () => {
  beforeAll(async () => {
    if (connectionString === undefined) return;
    admin = new Client({ connectionString });
    await admin.connect();
    await admin.query(`CREATE SCHEMA "${schema}"`);
    db = createDb({ connectionString, schema });
    otherDb = createDb({ connectionString, schema });
    await migrate(db);
    activityId = `act-${randomUUID()}`;
    await db.insertInto("activity").values({
      id: activityId,
      title: "Tickets",
      status: "active",
      revision: 1,
      enabled_capabilities: JSON.stringify(["ticketing"]),
      active_definition_version: 1,
    }).execute();
  });

  afterAll(async () => {
    if (connectionString === undefined) return;
    await closeDb(db);
    await closeDb(otherDb);
    await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
    await admin.end();
  });

  it("inserts and reads a ticket", async () => {
    const stored = ticket();
    await insertTicket(db, stored);

    await expect(getTicket(db, stored.id)).resolves.toEqual(stored);
    await expect(findTicketByCredential(db, stored.publicCode, 1)).resolves.toEqual(stored);
    await expect(findTicketByCredential(db, stored.publicCode, 2)).resolves.toBeNull();
  });

  it("enforces unique public codes and credential digests", async () => {
    const first = ticket();
    const second = ticket();
    await insertTicket(db, first);

    await expect(insertTicket(db, { ...second, publicCode: first.publicCode })).rejects.toThrow();
    await expect(insertTicket(db, { ...second, credentialDigest: first.credentialDigest })).rejects.toThrow();
  });

  it("rotates the credential version and digest", async () => {
    const stored = ticket();
    await insertTicket(db, stored);

    await updateTicket(db, {
      ...stored,
      credentialVersion: 2,
      credentialDigest: `rotated-${stored.id}`,
    });

    const rotated = await getTicket(db, stored.id);
    expect(rotated?.credentialVersion).toBe(2);
    expect(rotated?.credentialDigest).toBe(`rotated-${stored.id}`);
    await expect(findTicketByCredential(db, stored.publicCode, 1)).resolves.toBeNull();
    await expect(findTicketByCredential(db, stored.publicCode, 2)).resolves.toMatchObject({ credentialVersion: 2 });
  });

  it("serializes concurrent rotations through the row lock", async () => {
    const stored = ticket();
    await insertTicket(db, stored);

    let releaseFirst: (() => void) | undefined;
    const firstLocked = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    const first = db.transaction().execute(async (trx) => {
      const current = await getTicketForUpdate(trx, stored.id);
      expect(current?.credentialVersion).toBe(1);
      await updateTicket(trx, {
        ...current!,
        credentialVersion: 2,
        credentialDigest: `rotate-a-${stored.id}`,
      });
      releaseFirst?.();
      await new Promise((resolve) => setImmediate(resolve));
      return current!.credentialVersion;
    });

    await firstLocked;
    const second = otherDb.transaction().execute(async (trx) => {
      const current = await getTicketForUpdate(trx, stored.id);
      await updateTicket(trx, {
        ...current!,
        credentialVersion: current!.credentialVersion + 1,
        credentialDigest: `rotate-b-${stored.id}`,
      });
      return current!.credentialVersion;
    });

    const [firstVersion, secondVersion] = await Promise.all([first, second]);
    expect(firstVersion).toBe(1);
    expect(secondVersion).toBe(2);
    await expect(getTicket(db, stored.id)).resolves.toMatchObject({ credentialVersion: 3 });
  });

  it("revokes an access session once and leaves the timestamp stable", async () => {
    const stored = ticket();
    await insertTicket(db, stored);
    const sessionId = `session-${randomUUID()}`;
    const tokenDigest = `token-${randomUUID()}`;
    await insertTicketAccessSession(db, {
      id: sessionId,
      activity_id: activityId,
      ticket_id: stored.id,
      token_digest: tokenDigest,
      expires_at: new Date(Date.now() + 60_000).toISOString(),
      last_seen_at: null,
      revoked_at: null,
    });

    const active = await findTicketAccessSession(db, tokenDigest);
    expect(active?.id).toBe(sessionId);
    expect(active?.revokedAt).toBeUndefined();

    await db.transaction().execute((trx) => revokeTicketAccessSession(trx, sessionId, "2026-11-13T10:00:00.000Z"));
    const revoked = await findTicketAccessSession(db, tokenDigest);
    expect(revoked?.revokedAt).toBe("2026-11-13T10:00:00.000Z");

    await db.transaction().execute((trx) => revokeTicketAccessSession(trx, sessionId, "2026-11-13T11:00:00.000Z"));
    const stillRevoked = await findTicketAccessSession(db, tokenDigest);
    expect(stillRevoked?.revokedAt).toBe("2026-11-13T10:00:00.000Z");
  });

  it("rejects a duplicate access-session token digest", async () => {
    const stored = ticket();
    await insertTicket(db, stored);
    const tokenDigest = `token-${randomUUID()}`;
    const base = {
      activity_id: activityId,
      ticket_id: stored.id,
      token_digest: tokenDigest,
      expires_at: new Date(Date.now() + 60_000).toISOString(),
      last_seen_at: null,
      revoked_at: null,
    };
    await insertTicketAccessSession(db, { id: `session-${randomUUID()}`, ...base });

    await expect(
      insertTicketAccessSession(db, { id: `session-${randomUUID()}`, ...base }),
    ).rejects.toThrow();
  });
});
