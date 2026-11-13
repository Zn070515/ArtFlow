import { randomUUID } from "node:crypto";

import type { ExecutionSession } from "@artflow-plus/domain";
import type { Kysely } from "kysely";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  closeDb,
  createDb,
  findRunningSessionByScope,
  getSessionForUpdate,
  insertSession,
  listRunningSessions,
  listSessionRecords,
  migrate,
  StaleRevisionError,
  updateSession,
} from "../src/index.js";
import type { Database } from "../src/index.js";

const connectionString = process.env.ARTFLOW_PLUS_DATABASE_URL;
if (process.env.REQUIRE_DB === "1" && connectionString === undefined) {
  throw new Error("REQUIRE_DB=1 but ARTFLOW_PLUS_DATABASE_URL is unset.");
}
const schema = `artflow_session_${Date.now()}_${process.pid}`;

let db: Kysely<Database>;
let admin: Client;
let activityId: string;

function session(overrides: Partial<ExecutionSession> = {}): ExecutionSession {
  return {
    id: `session-${randomUUID()}`,
    activityId,
    definitionVersion: 1,
    contentHash: "hash-1",
    scope: `scope-${randomUUID()}`,
    mode: "formal",
    status: "running",
    revision: 1,
    ...overrides,
  };
}

describe.skipIf(!connectionString)("execution session repository", () => {
  beforeAll(async () => {
    if (connectionString === undefined) return;
    admin = new Client({ connectionString });
    await admin.connect();
    await admin.query(`CREATE SCHEMA "${schema}"`);
    db = createDb({ connectionString, schema });
    await migrate(db);
    activityId = `act-${randomUUID()}`;
    await db.insertInto("activity").values({
      id: activityId,
      title: "Sessions",
      status: "active",
      revision: 1,
      enabled_capabilities: JSON.stringify(["competition"]),
      active_definition_version: 1,
    }).execute();
    await db.insertInto("definition_release").values({
      activity_id: activityId,
      version: 1,
      content_hash: "hash-1",
      capabilities: JSON.stringify({}),
      execution_policy: JSON.stringify({
        declaredScopes: [],
        conflicts: {},
        runtimeContractVersion: 1,
      }),
      capability_versions: JSON.stringify({}),
      bindings: JSON.stringify([]),
      released_at: new Date().toISOString(),
      source_draft_revision: 1,
    }).execute();
  });

  afterAll(async () => {
    if (connectionString === undefined) return;
    await closeDb(db);
    await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
    await admin.end();
  });

  it("inserts a running session and reads it back", async () => {
    const input = session();
    const openedAt = "2026-11-13T09:00:00.000Z";
    const record = await db.transaction().execute((trx) => insertSession(trx, input, openedAt));

    expect(record).toMatchObject({ ...input, openedAt });
    expect(record.closedAt).toBeUndefined();

    const sessions = await listSessionRecords(db, activityId);
    expect(sessions.map((row) => row.id)).toContain(input.id);
    const running = await listRunningSessions(db, activityId);
    expect(running.map((row) => row.id)).toContain(input.id);
    await expect(findRunningSessionByScope(db, activityId, input.scope)).resolves.toMatchObject({ id: input.id });
    await expect(findRunningSessionByScope(db, activityId, "missing-scope")).resolves.toBeNull();
  });

  it("closes a session through the revision CAS and stamps closed_at", async () => {
    const input = session();
    await db.transaction().execute((trx) => insertSession(trx, input, "2026-11-13T09:00:00.000Z"));

    const closedAt = "2026-11-13T10:00:00.000Z";
    const closed = await db.transaction().execute((trx) =>
      updateSession(trx, { ...input, status: "closed", revision: 2 }, 1, closedAt),
    );

    expect(closed).toMatchObject({ status: "closed", revision: 2, closedAt });
    const running = await listRunningSessions(db, activityId);
    expect(running.map((row) => row.id)).not.toContain(input.id);
  });

  it("rejects a stale revision instead of overwriting", async () => {
    const input = session();
    await db.transaction().execute((trx) => insertSession(trx, input, "2026-11-13T09:00:00.000Z"));
    await db.transaction().execute((trx) =>
      updateSession(trx, { ...input, status: "closed", revision: 2 }, 1, "2026-11-13T10:00:00.000Z"),
    );

    await expect(
      db.transaction().execute((trx) =>
        updateSession(trx, { ...input, status: "closed", revision: 2 }, 1, "2026-11-13T11:00:00.000Z"),
      ),
    ).rejects.toBeInstanceOf(StaleRevisionError);
  });

  it("clears closed_at when a session is reopened", async () => {
    const input = session();
    await db.transaction().execute((trx) => insertSession(trx, input, "2026-11-13T09:00:00.000Z"));
    await db.transaction().execute((trx) =>
      updateSession(trx, { ...input, status: "closed", revision: 2 }, 1, "2026-11-13T10:00:00.000Z"),
    );

    const reopened = await db.transaction().execute((trx) =>
      updateSession(trx, { ...input, status: "running", revision: 3 }, 2, "2026-11-13T11:00:00.000Z"),
    );
    expect(reopened.status).toBe("running");
    expect(reopened.closedAt).toBeUndefined();
  });

  it("locks a session row for update and returns null when absent", async () => {
    const input = session();
    await db.transaction().execute((trx) => insertSession(trx, input, "2026-11-13T09:00:00.000Z"));

    const locked = await db.transaction().execute((trx) => getSessionForUpdate(trx, input.id));
    expect(locked).toMatchObject({ id: input.id, status: "running" });

    await expect(db.transaction().execute((trx) => getSessionForUpdate(trx, "missing"))).resolves.toBeNull();
  });
});
