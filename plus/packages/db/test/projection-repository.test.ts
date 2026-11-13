import { randomUUID } from "node:crypto";

import { emptyExecutionProjection } from "@artflow-plus/domain";
import type { Kysely } from "kysely";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  blockExecutionProjection,
  clearExecutionProjectionBlock,
  closeDb,
  createDb,
  deleteExecutionProjection,
  getExecutionProjection,
  migrate,
  upsertExecutionProjection,
} from "../src/index.js";
import type { Database } from "../src/index.js";

const connectionString = process.env.ARTFLOW_PLUS_DATABASE_URL;
if (process.env.REQUIRE_DB === "1" && connectionString === undefined) {
  throw new Error("REQUIRE_DB=1 but ARTFLOW_PLUS_DATABASE_URL is unset.");
}
const schema = `artflow_projection_${Date.now()}_${process.pid}`;

let db: Kysely<Database>;
let admin: Client;
let activityId: string;

async function seedActivity(): Promise<string> {
  const id = `act-${randomUUID()}`;
  await db.insertInto("activity").values({
    id,
    title: "Projection",
    status: "active",
    revision: 1,
    enabled_capabilities: JSON.stringify(["competition"]),
    active_definition_version: 1,
  }).execute();
  return id;
}

describe.skipIf(!connectionString)("execution projection repository", () => {
  beforeAll(async () => {
    if (connectionString === undefined) return;
    admin = new Client({ connectionString });
    await admin.connect();
    await admin.query(`CREATE SCHEMA "${schema}"`);
    db = createDb({ connectionString, schema });
    await migrate(db);
  });

  afterAll(async () => {
    if (connectionString === undefined) return;
    await closeDb(db);
    await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
    await admin.end();
  });

  it("returns null when no projection exists", async () => {
    activityId = await seedActivity();
    await expect(getExecutionProjection(db, activityId, "formal")).resolves.toBeNull();
  });

  it("inserts a running projection", async () => {
    activityId = await seedActivity();
    const state = emptyExecutionProjection(activityId, "formal");
    const written = await db.transaction().execute((trx) =>
      upsertExecutionProjection(trx, { activityId, mode: "formal", lastSequence: 3, state }),
    );

    expect(written).toBe(true);
    const stored = await getExecutionProjection(db, activityId, "formal");
    expect(stored).toMatchObject({ lastSequence: 3, status: "running" });
    expect(stored?.blockedSequence).toBeUndefined();
  });

  it("never lets an older sequence overwrite a newer projection", async () => {
    activityId = await seedActivity();
    const state = emptyExecutionProjection(activityId, "formal");
    await db.transaction().execute((trx) =>
      upsertExecutionProjection(trx, { activityId, mode: "formal", lastSequence: 3, state }),
    );
    const stale = await db.transaction().execute((trx) =>
      upsertExecutionProjection(trx, { activityId, mode: "formal", lastSequence: 2, state }),
    );
    expect(stale).toBe(false);
    await expect(getExecutionProjection(db, activityId, "formal")).resolves.toMatchObject({ lastSequence: 3 });

    const newer = await db.transaction().execute((trx) =>
      upsertExecutionProjection(trx, { activityId, mode: "formal", lastSequence: 9, state }),
    );
    expect(newer).toBe(true);
    await expect(getExecutionProjection(db, activityId, "formal")).resolves.toMatchObject({ lastSequence: 9 });
  });

  it("keeps a block in place on a normal upsert and clears it only on rebuild", async () => {
    activityId = await seedActivity();
    const state = emptyExecutionProjection(activityId, "formal");
    await db.transaction().execute((trx) =>
      upsertExecutionProjection(trx, { activityId, mode: "formal", lastSequence: 9, state }),
    );
    await db.transaction().execute((trx) =>
      blockExecutionProjection(trx, activityId, "formal", 10, "event failed"),
    );
    const blocked = await getExecutionProjection(db, activityId, "formal");
    expect(blocked).toMatchObject({
      status: "blocked",
      blockedSequence: 10,
      blockedReason: "event failed",
    });

    await db.transaction().execute((trx) =>
      upsertExecutionProjection(trx, { activityId, mode: "formal", lastSequence: 11, state }),
    );
    const stillBlocked = await getExecutionProjection(db, activityId, "formal");
    expect(stillBlocked?.status).toBe("blocked");
    expect(stillBlocked?.lastSequence).toBe(11);

    await db.transaction().execute((trx) =>
      upsertExecutionProjection(trx, { activityId, mode: "formal", lastSequence: 12, state, force: true }),
    );
    const rebuilt = await getExecutionProjection(db, activityId, "formal");
    expect(rebuilt?.status).toBe("running");
    expect(rebuilt?.lastSequence).toBe(12);
    expect(rebuilt?.blockedSequence).toBeUndefined();
  });

  it("blocks a missing projection with the empty state", async () => {
    activityId = await seedActivity();
    await db.transaction().execute((trx) =>
      blockExecutionProjection(trx, activityId, "test", 1, "no history"),
    );

    const stored = await getExecutionProjection(db, activityId, "test");
    expect(stored).toMatchObject({ lastSequence: 0, status: "blocked", blockedSequence: 1 });
  });

  it("clears a block without rebuilding and deletes the projection", async () => {
    activityId = await seedActivity();
    await db.transaction().execute((trx) =>
      blockExecutionProjection(trx, activityId, "test", 4, "boom"),
    );
    await db.transaction().execute((trx) => clearExecutionProjectionBlock(trx, activityId, "test"));
    await expect(getExecutionProjection(db, activityId, "test")).resolves.toMatchObject({ status: "running" });

    await db.transaction().execute((trx) => deleteExecutionProjection(trx, activityId, "test"));
    await expect(getExecutionProjection(db, activityId, "test")).resolves.toBeNull();
  });
});
