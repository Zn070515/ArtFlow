import { COMPETITION_COMMAND_SCOPES } from "@artflow-plus/domain";
import { randomUUID } from "node:crypto";

import { closeDb, createDb, insertRelease, insertSession, migrate, readEventsSince } from "@artflow-plus/db";
import type { Database } from "@artflow-plus/db";
import type { ActorContext, ExecutionSession } from "@artflow-plus/domain";
import { Client } from "pg";
import type { Kysely } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { closeActivity, renameActivity } from "../src/index.js";
import type { RuntimeDeps } from "../src/index.js";

const connectionString = process.env.ARTFLOW_PLUS_DATABASE_URL;
if (process.env.REQUIRE_DB === "1" && connectionString === undefined) {
  throw new Error("REQUIRE_DB=1 but ARTFLOW_PLUS_DATABASE_URL is unset.");
}
const schema = `artflow_activity_service_${Date.now()}_${process.pid}`;

let db: Kysely<Database>;
let admin: Client;
let tick = 0;

const staff: ActorContext = {
  actorId: "activity-staff",
  actorType: "user",
  roles: ["staff"],
  permissions: ["archive.manage", "studio.manage"],
};
const participant: ActorContext = {
  actorId: "activity-participant",
  actorType: "user",
  roles: ["participant"],
  permissions: [],
};

function deps(actor: ActorContext = staff): RuntimeDeps {
  return {
    actor,
    now: () => new Date(Date.UTC(2026, 9, 20, 10, 0, tick++)).toISOString(),
    newEventId: () => `activity-${randomUUID()}`,
  };
}

async function seed(status: "active" | "closed" | "archived" = "active"): Promise<string> {
  const activityId = `act-${randomUUID()}`;
  await db.insertInto("activity").values({
    id: activityId,
    public_code: activityId,
    title: "2026 院十佳",
    status,
    revision: 1,
    enabled_capabilities: JSON.stringify(["archive"]),
    active_definition_version: 1,
  }).execute();
  return activityId;
}

describe.skipIf(!connectionString)("activity lifecycle commands", () => {
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

  it("closes an active activity with no running sessions", async () => {
    const activityId = await seed();
    const closed = await closeActivity(db, deps(), {
      commandId: "activity-close-1",
      activityId,
      expectedRevision: 1,
    });
    expect(closed.body).toMatchObject({ status: "closed", revision: 2 });
    const events = await readEventsSince(db, { activityId, after: 0, limit: 20 });
    expect(events.map((event) => event.type)).toContain("ActivityClosed");
  });

  it("refuses to close while a session is running", async () => {
    const activityId = await seed();
    await insertRelease(db, {
      activityId,
      version: 1,
      contentHash: "hash",
      capabilities: {},
      executionPolicy: { declaredScopes: ["judging"], conflicts: {}, runtimeContractVersion: 2, commandScopes: COMPETITION_COMMAND_SCOPES },
      capabilityVersions: {},
      bindings: [],
      releasedAt: "2026-10-20T09:00:00Z",
      sourceDraftRevision: 1,
    });
    const session: ExecutionSession = {
      id: `session-${activityId}`,
      activityId,
      definitionVersion: 1,
      contentHash: "hash",
      scope: "judging",
      mode: "formal",
      status: "running",
      revision: 0,
    };
    await insertSession(db, session, "2026-10-20T09:00:00Z");
    await expect(closeActivity(db, deps(), {
      commandId: "activity-close-running",
      activityId,
      expectedRevision: 1,
    })).rejects.toMatchObject({ code: "ACTIVITY_HAS_RUNNING_SESSIONS" });
  });

  it("renames a closed activity and rejects an archived one", async () => {
    const closed = await seed("closed");
    const renamed = await renameActivity(db, deps(), {
      commandId: "activity-rename-1",
      activityId: closed,
      title: "渡梦十佳",
      expectedRevision: 1,
    });
    expect(renamed.body).toMatchObject({ title: "渡梦十佳", revision: 2 });
    const event = (await readEventsSince(db, { activityId: closed, after: 0, limit: 20 }))
      .find((item) => item.type === "ActivityRenamed");
    expect(event).toBeDefined();
    const archived = await seed("archived");
    await expect(renameActivity(db, deps(), {
      commandId: "activity-rename-archived",
      activityId: archived,
      title: "改名",
      expectedRevision: 1,
    })).rejects.toMatchObject({ code: "ACTIVITY_ARCHIVED" });
  });

  it("requires studio.manage to close or rename an activity", async () => {
    const activityId = await seed();
    await expect(closeActivity(db, deps(participant), {
      commandId: "activity-close-forbidden",
      activityId,
      expectedRevision: 1,
    })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(renameActivity(db, deps(participant), {
      commandId: "activity-rename-forbidden",
      activityId,
      title: "越权改名",
      expectedRevision: 1,
    })).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(await readEventsSince(db, { activityId, after: 0, limit: 20 })).toEqual([]);
  });

  it("writes audit entries for lifecycle commands", async () => {
    const activityId = await seed();
    await closeActivity(db, deps(), {
      commandId: "activity-audit-close",
      activityId,
      expectedRevision: 1,
    });
    const audits = await db.selectFrom("audit_entry").select(["command_id"]).where("activity_id", "=", activityId).execute();
    expect(audits.map((row) => row.command_id)).toContain("activity-audit-close");
  });
});
