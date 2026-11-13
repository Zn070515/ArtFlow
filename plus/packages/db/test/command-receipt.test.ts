import { randomUUID } from "node:crypto";

import type { Kysely } from "kysely";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  claimCommand,
  closeDb,
  CommandIdConflictError,
  CommandInProgressError,
  completeCommand,
  createDb,
  insertAudit,
  migrate,
} from "../src/index.js";
import type { Database } from "../src/index.js";

const connectionString = process.env.ARTFLOW_PLUS_DATABASE_URL;
if (process.env.REQUIRE_DB === "1" && connectionString === undefined) {
  throw new Error("REQUIRE_DB=1 but ARTFLOW_PLUS_DATABASE_URL is unset.");
}
const schema = `artflow_command_receipt_${Date.now()}_${process.pid}`;

let db: Kysely<Database>;
let otherDb: Kysely<Database>;
let admin: Client;

const actor = {
  actorId: "user-1",
  actorType: "user" as const,
  roles: ["organizer"],
  permissions: ["activity.manage"],
};

function claimInput(commandId: string, overrides: Partial<Parameters<typeof claimCommand>[1]> = {}) {
  return {
    commandId,
    activityId: "activity-1",
    capability: "activity",
    commandType: "activity.rename",
    payloadHash: "hash-a",
    scope: null,
    actor,
    ...overrides,
  };
}

describe.skipIf(!connectionString)("command receipt", () => {
  beforeAll(async () => {
    if (connectionString === undefined) return;
    admin = new Client({ connectionString });
    await admin.connect();
    await admin.query(`CREATE SCHEMA "${schema}"`);
    db = createDb({ connectionString, schema });
    otherDb = createDb({ connectionString, schema });
    await migrate(db);
  });

  afterAll(async () => {
    if (connectionString === undefined) return;
    await closeDb(db);
    await closeDb(otherDb);
    await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
    await admin.end();
  });

  it("claims a fresh command id", async () => {
    const commandId = `cmd-${randomUUID()}`;
    const claim = await db.transaction().execute((trx) => claimCommand(trx, claimInput(commandId)));
    expect(claim).toEqual({ kind: "claimed" });
  });

  it("replays the stored result for the same id and payload", async () => {
    const commandId = `cmd-${randomUUID()}`;
    await db.transaction().execute(async (trx) => {
      await claimCommand(trx, claimInput(commandId));
      await completeCommand(trx, commandId, { ok: true, id: "row-1" }, 201);
    });

    const claim = await db.transaction().execute((trx) => claimCommand(trx, claimInput(commandId)));
    expect(claim).toEqual({ kind: "replay", result: { ok: true, id: "row-1" }, httpStatus: 201 });
  });

  it("defaults a replay without an http status to 200", async () => {
    const commandId = `cmd-${randomUUID()}`;
    await db.transaction().execute(async (trx) => {
      await claimCommand(trx, claimInput(commandId));
      await trx.updateTable("command_receipt").set({ result: JSON.stringify({ ok: true }) }).where("command_id", "=", commandId).execute();
    });

    const claim = await db.transaction().execute((trx) => claimCommand(trx, claimInput(commandId)));
    expect(claim).toMatchObject({ kind: "replay", httpStatus: 200 });
  });

  it("rejects the same id with a different payload hash", async () => {
    const commandId = `cmd-${randomUUID()}`;
    await db.transaction().execute((trx) => claimCommand(trx, claimInput(commandId)));

    await expect(
      db.transaction().execute((trx) => claimCommand(trx, claimInput(commandId, { payloadHash: "hash-b" }))),
    ).rejects.toBeInstanceOf(CommandIdConflictError);
  });

  it("rejects the same id claimed by a different actor", async () => {
    const commandId = `cmd-${randomUUID()}`;
    await db.transaction().execute((trx) => claimCommand(trx, claimInput(commandId)));

    await expect(
      db.transaction().execute((trx) =>
        claimCommand(trx, claimInput(commandId, { actor: { ...actor, actorId: "user-2" } })),
      ),
    ).rejects.toBeInstanceOf(CommandIdConflictError);
  });

  it("reports an unfinished claim as in progress", async () => {
    const commandId = `cmd-${randomUUID()}`;
    await db.transaction().execute((trx) => claimCommand(trx, claimInput(commandId)));

    await expect(
      db.transaction().execute((trx) => claimCommand(trx, claimInput(commandId))),
    ).rejects.toBeInstanceOf(CommandInProgressError);
  });

  it("leaves no receipt when the claiming transaction rolls back", async () => {
    const commandId = `cmd-${randomUUID()}`;
    await expect(
      db.transaction().execute(async (trx) => {
        await claimCommand(trx, claimInput(commandId));
        throw new Error("rollback");
      }),
    ).rejects.toThrow("rollback");

    const claim = await db.transaction().execute((trx) => claimCommand(trx, claimInput(commandId)));
    expect(claim).toEqual({ kind: "claimed" });
  });

  it("serializes two concurrent claims: one executes, the other replays", async () => {
    const commandId = `cmd-${randomUUID()}`;
    let releaseFirst: (() => void) | undefined;
    const firstClaimed = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    const first = db.transaction().execute(async (trx) => {
      const claim = await claimCommand(trx, claimInput(commandId));
      releaseFirst?.();
      // Hold the insert open until the competing claim is already blocked on
      // the unique index, then finish and commit.
      await new Promise((resolve) => setImmediate(resolve));
      await completeCommand(trx, commandId, { winner: "first" }, 200);
      return claim;
    });

    await firstClaimed;
    const second = otherDb.transaction().execute((trx) => claimCommand(trx, claimInput(commandId)));

    const [firstClaim, secondClaim] = await Promise.all([first, second]);
    expect(firstClaim).toEqual({ kind: "claimed" });
    expect(secondClaim).toEqual({ kind: "replay", result: { winner: "first" }, httpStatus: 200 });
  });

  it("writes one audit entry per executing command", async () => {
    const commandId = `cmd-${randomUUID()}`;
    await db.transaction().execute(async (trx) => {
      await claimCommand(trx, claimInput(commandId));
      await insertAudit(trx, {
        commandId,
        activityId: "activity-1",
        capability: "activity",
        commandType: "activity.rename",
        actor,
        detail: { to: "new title" },
      });
    });

    const entries = await db.selectFrom("audit_entry").selectAll().where("command_id", "=", commandId).execute();
    expect(entries).toHaveLength(1);
    expect(entries[0]?.detail).toEqual({ to: "new title" });
  });
});
