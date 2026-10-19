import { randomUUID } from "node:crypto";

import { SYSTEM_ACTOR } from "@artflow-plus/domain";
import type { Kysely } from "kysely";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  appendEvent,
  blockExecutionProjection,
  claimCommand,
  claimPendingEventsForPartition,
  clearExecutionProjectionBlock,
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
  listPendingPartitions,
  listRunningSessions,
  markPublished,
  migrate,
  readEventsSince,
  recordFailure,
  retryEvent,
  tryLockPartition,
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

const releaseSnapshot = {
  executionPolicy: {
    declaredScopes: [] as string[],
    conflicts: {},
    runtimeContractVersion: 1,
  },
  capabilityVersions: {} as Record<string, string>,
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
    ...releaseSnapshot,
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
      actor: SYSTEM_ACTOR,
    };
    await db.transaction().execute(async (trx) => {
      expect(await claimCommand(trx, base)).toEqual({ kind: "claimed" });
      await completeCommand(trx, base.commandId, { id: "act-1" }, 201);
    });

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
    ).rejects.toBeInstanceOf(Error);
  });

  it("stores compiled plans and frozen releases", async () => {
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
      executionPolicy: {
        declaredScopes: ["stage"],
        conflicts: { stage: ["rehearsal"] },
        runtimeContractVersion: 1,
      },
      capabilityVersions: { competition: "1" },
      bindings: [],
    });
    expect(await getLatestRelease(db, activityId)).toMatchObject({
      version: 2,
      contentHash: "hash-2",
      executionPolicy: {
        declaredScopes: ["stage"],
        conflicts: { stage: ["rehearsal"] },
      },
      capabilityVersions: { competition: "1" },
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
    ).rejects.toBeInstanceOf(Error);
    expect(await listRunningSessions(db, activityId)).toHaveLength(0);
  });

  it("serializes a projection partition and reads events by cursor", async () => {
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
          actorId: "tester",
          actorType: "user",
          payload: { sessionId: `session-${index}`, scope: "stage", mode: "formal" },
        }),
      );
      ids.push(sequence);
    }

    const firstPage = await readEventsSince(db, { activityId, after: 0, limit: 2 });
    expect(firstPage.map((event) => event.sequence)).toEqual(ids.slice(0, 2));
    expect(firstPage[0]?.actorId).toBe("tester");
    expect(await headSequence(db, activityId, "formal")).toBe(ids[2]);

    const partitions = await listPendingPartitions(db, 10);
    expect(partitions.some((item) => item.activityId === activityId)).toBe(true);

    let releaseClaim: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      releaseClaim = resolve;
    });
    let claimedInside = 0;
    const claimer = db.transaction().execute(async (trx) => {
      expect(await tryLockPartition(trx, `${activityId}:formal`)).toBe(true);
      const events = await claimPendingEventsForPartition(trx, activityId, "formal", 10);
      claimedInside = events.length;
      await gate;
      for (const event of events) {
        await markPublished(trx, event.sequence);
      }
    });

    while (claimedInside === 0) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const secondWorker = await db.transaction().execute(async (trx) => {
      const locked = await tryLockPartition(trx, `${activityId}:formal`);
      return locked;
    });
    expect(secondWorker).toBe(false);
    releaseClaim?.();
    await claimer;

    const remaining = await db
      .transaction()
      .execute((trx) => claimPendingEventsForPartition(trx, activityId, "formal", 10));
    expect(remaining).toHaveLength(0);
  });

  it("counts failures, blocks the partition and can retry", async () => {
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

    await db.transaction().execute((trx) =>
      blockExecutionProjection(trx, activityId, "formal", sequence, "boom"),
    );
    let projection = await getExecutionProjection(db, activityId, "formal");
    expect(projection).toMatchObject({
      status: "blocked",
      blockedSequence: sequence,
    });

    await db.transaction().execute(async (trx) => {
      await retryEvent(trx, sequence);
      await clearExecutionProjectionBlock(trx, activityId, "formal");
    });
    projection = await getExecutionProjection(db, activityId, "formal");
    expect(projection?.status).toBe("running");
    expect(projection?.blockedSequence).toBeUndefined();
  });

  it("lists healthy partitions before blocked ones", async () => {
    const blocked = await seedActivity();
    const healthy = await seedActivity();
    const append = (activityId: string, sessionId: string) =>
      db.transaction().execute((trx) =>
        appendEvent(trx, {
          eventId: `evt-${randomUUID()}`,
          type: "ExecutionSessionStarted",
          occurredAt: "2026-10-19T10:00:00Z",
          activityId,
          aggregateType: "execution_session",
          aggregateId: sessionId,
          capability: "engine",
          revision: 0,
          mode: "formal",
          scope: "stage",
          payload: {
            sessionId,
            definitionVersion: 1,
            contentHash: "hash",
            scope: "stage",
            mode: "formal",
            openedAt: "2026-10-19T10:00:00Z",
          },
        }),
      );
    // The blocked partition has the older event, so id order alone would pick it.
    const blockedSequence = await append(blocked, "session-blocked");
    await append(healthy, "session-healthy");
    await db.transaction().execute((trx) =>
      blockExecutionProjection(trx, blocked, "formal", blockedSequence, "boom"),
    );

    // Other tests may leave pending partitions in this schema; only relative
    // order matters here.
    const partitions = await listPendingPartitions(db, 50);
    const healthyIndex = partitions.findIndex((item) => item.activityId === healthy);
    const blockedIndex = partitions.findIndex((item) => item.activityId === blocked);
    expect(healthyIndex).toBeGreaterThanOrEqual(0);
    expect(blockedIndex).toBeGreaterThanOrEqual(0);
    expect(healthyIndex).toBeLessThan(blockedIndex);
  });

  it("never lets an older projection overwrite a newer one", async () => {
    const activityId = await seedActivity();
    const state = {
      activityId,
      mode: "formal" as const,
      sessions: {},
      runningScopes: [] as string[],
    };
    expect(
      await db.transaction().execute((trx) =>
        upsertExecutionProjection(trx, { activityId, mode: "formal", lastSequence: 5, state }),
      ),
    ).toBe(true);
    expect(
      await db.transaction().execute((trx) =>
        upsertExecutionProjection(trx, { activityId, mode: "formal", lastSequence: 4, state }),
      ),
    ).toBe(false);
    expect(await getExecutionProjection(db, activityId, "formal")).toMatchObject({
      lastSequence: 5,
    });
  });
});
