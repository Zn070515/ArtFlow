import { randomUUID } from "node:crypto";

import type { Kysely } from "kysely";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  appendEvent,
  claimCommand,
  claimPendingEvents,
  StaleRevisionError,
  closeDb,
  CommandIdConflictError,
  completeCommand,
  createDb,
  getCompiled,
  getDraft,
  getExecutionProjection,
  getLatestRelease,
  headSequence,
  insertCompiled,
  insertDraft,
  insertRelease,
  insertSession,
  listRunningSessions,
  markPublished,
  migrate,
  readEventsSince,
  recordFailure,
  updateDraft,
  updateSession,
  upsertExecutionProjection,
} from "../src/index.js";
import type { Database, StoredDraft } from "../src/index.js";

const connectionString = process.env.ARTFLOW_PLUS_DATABASE_URL;
if (process.env.REQUIRE_DB === "1" && connectionString === undefined) {
  throw new Error("REQUIRE_DB=1 but ARTFLOW_PLUS_DATABASE_URL is unset.");
}
const schema = `artflow_runtime_${Date.now()}_${process.pid}`;

let db: Kysely<Database>;
let admin: Client;

const definitionPackage = {
  schemaVersion: 1 as const,
  manifest: { key: "pkg", title: "Package" },
  capabilities: {},
  bindings: [],
};

async function seedActivity(id = `act-${randomUUID()}`): Promise<string> {
  await db
    .insertInto("activity")
    .values({
      id,
      title: "Runtime test",
      status: "active",
      revision: 1,
      enabled_capabilities: JSON.stringify([]),
      active_definition_version: 1,
    })
    .execute();
  await insertRelease(db, {
    activityId: id,
    version: 1,
    contentHash: "hash-1",
    capabilities: {},
    releasedAt: "2026-10-19T10:00:00Z",
    sourceDraftRevision: 1,
  });
  return id;
}

describe.skipIf(!connectionString)("runtime repositories on PostgreSQL", () => {
  beforeAll(async () => {
    if (!connectionString) return;
    admin = new Client({ connectionString });
    await admin.connect();
    await admin.query(`CREATE SCHEMA "${schema}"`);
    db = createDb({ connectionString, schema });
    await migrate(db);
  });

  afterAll(async () => {
    if (!connectionString) return;
    await closeDb(db);
    await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
    await admin.end();
  });

  it("replays a completed command and refuses a changed payload", async () => {
    const base = {
      commandId: `cmd-${randomUUID()}`,
      activityId: "act-receipt",
      capability: "engine",
      commandType: "activity.create",
      payloadHash: "hash-a",
      scope: null,
    };
    const first = await db.transaction().execute(async (trx) => {
      expect(await claimCommand(trx, base)).toEqual({ kind: "claimed" });
      await completeCommand(trx, base.commandId, { id: "act-1" }, 201);
      return true;
    });
    expect(first).toBe(true);

    const replay = await db.transaction().execute((trx) => claimCommand(trx, base));
    expect(replay).toEqual({
      kind: "replay",
      result: { id: "act-1" },
      httpStatus: 201,
    });

    await expect(
      db.transaction().execute((trx) =>
        claimCommand(trx, { ...base, payloadHash: "hash-b" }),
      ),
    ).rejects.toBeInstanceOf(CommandIdConflictError);
  });

  it("compare-and-swap on a draft revision", async () => {
    const activityId = await seedActivity();
    const draft: StoredDraft = {
      activityId,
      revision: 0,
      package: definitionPackage,
    };
    await insertDraft(db, draft);
    expect(await getDraft(db, activityId)).toEqual(draft);

    const updated = await updateDraft(
      db,
      { ...draft, revision: 1, package: definitionPackage },
      0,
    );
    expect(updated.revision).toBe(1);
    await expect(
      updateDraft(db, { ...draft, revision: 2, package: definitionPackage }, 0),
    ).rejects.toBeInstanceOf(StaleRevisionError);
  });

  it("stores compiled plans and releases", async () => {
    const activityId = await seedActivity();
    await insertCompiled(db, {
      activityId,
      draftRevision: 1,
      contentHash: "hash-1",
      capabilities: {},
    });
    expect(await getCompiled(db, activityId, 1)).toMatchObject({
      contentHash: "hash-1",
    });
    await insertRelease(db, {
      activityId,
      version: 2,
      contentHash: "hash-2",
      capabilities: {},
      releasedAt: "2026-10-19T11:00:00Z",
      sourceDraftRevision: 1,
    });
    expect(await getLatestRelease(db, activityId)).toMatchObject({
      version: 2,
      contentHash: "hash-2",
    });
  });

  it("lists running sessions and closes with OCC", async () => {
    const activityId = await seedActivity();
    const session = {
      id: `session-${randomUUID()}`,
      activityId,
      definitionVersion: 1,
      contentHash: "hash-1",
      scope: "stage",
      mode: "formal" as const,
      status: "running" as const,
      revision: 0,
      openedAt: "2026-10-19T10:00:00Z",
    };
    await insertSession(db, session, session.openedAt);
    expect(await listRunningSessions(db, activityId)).toHaveLength(1);

    const closed = { ...session, status: "closed" as const, revision: 1 };
    await updateSession(db, closed, 0, "2026-10-19T11:00:00Z");
    await expect(
      updateSession(db, closed, 0, "2026-10-19T11:00:00Z"),
    ).rejects.toBeInstanceOf(StaleRevisionError);
    expect(await listRunningSessions(db, activityId)).toHaveLength(0);
  });

  it("reads events by cursor, tracks the head and claims with SKIP LOCKED", async () => {
    const activityId = await seedActivity();
    const ids: number[] = [];
    for (let index = 0; index < 3; index += 1) {
      const sequence = await db.transaction().execute((trx) =>
        appendEvent(trx, {
          eventId: `evt-${randomUUID()}`,
          type: "ExecutionSessionStarted",
          occurredAt: "2026-10-19T10:00:00Z",
          activityId,
          aggregateType: "execution_session",
          aggregateId: `session-${index}`,
          capability: "engine",
          revision: 0,
          mode: "formal",
          scope: "stage",
          payload: { sessionId: `session-${index}`, scope: "stage", mode: "formal" },
        }),
      );
      ids.push(sequence);
    }

    const firstPage = await readEventsSince(db, { activityId, after: 0, limit: 2 });
    expect(firstPage.map((event) => event.sequence)).toEqual(ids.slice(0, 2));
    const secondPage = await readEventsSince(db, {
      activityId,
      after: firstPage[1]?.sequence ?? 0,
      limit: 2,
    });
    expect(secondPage.map((event) => event.sequence)).toEqual([ids[2]]);
    expect(await headSequence(db, activityId, "formal")).toBe(ids[2]);

    let releaseClaim: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      releaseClaim = resolve;
    });
    let claimedInside: readonly unknown[] = [];
    const claimer = db.transaction().execute(async (trx) => {
      claimedInside = await claimPendingEvents(trx, 10);
      await gate;
      for (const event of claimedInside as { sequence: number }[]) {
        await markPublished(trx, event.sequence);
      }
    });

    while (claimedInside.length === 0) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const secondWorker = await db
      .transaction()
      .execute((trx) => claimPendingEvents(trx, 10));
    expect(secondWorker).toHaveLength(0);
    releaseClaim?.();
    await claimer;

    const remaining = await db
      .transaction()
      .execute((trx) => claimPendingEvents(trx, 10));
    expect(remaining).toHaveLength(0);
  });

  it("counts failures and dead-letters after the limit", async () => {
    const activityId = await seedActivity();
    const sequence = await db.transaction().execute((trx) =>
      appendEvent(trx, {
        eventId: `evt-${randomUUID()}`,
        type: "ExecutionSessionStarted",
        occurredAt: "2026-10-19T10:00:00Z",
        activityId,
        aggregateType: "execution_session",
        aggregateId: "session-1",
        capability: "engine",
        revision: 0,
        mode: "formal",
        scope: "stage",
        payload: {},
      }),
    );
    const first = await db
      .transaction()
      .execute((trx) => recordFailure(trx, sequence, "boom", 2));
    expect(first).toEqual({ attempts: 1, deadLettered: false });
    const second = await db
      .transaction()
      .execute((trx) => recordFailure(trx, sequence, "boom", 2));
    expect(second).toEqual({ attempts: 2, deadLettered: true });
  });

  it("stores an execution projection", async () => {
    const activityId = await seedActivity();
    expect(await getExecutionProjection(db, activityId, "formal")).toBeNull();
    await db.transaction().execute((trx) =>
      upsertExecutionProjection(trx, {
        activityId,
        mode: "formal",
        lastSequence: 3,
        state: {
          activityId,
          mode: "formal",
          sessions: {},
          runningScopes: [],
        },
      }),
    );
    expect(await getExecutionProjection(db, activityId, "formal")).toMatchObject({
      lastSequence: 3,
    });
  });
});
