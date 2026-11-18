import { randomUUID } from "node:crypto";

import { closeDb, createDb, insertRelease, migrate } from "@artflow-plus/db";
import type { Database } from "@artflow-plus/db";
import {
  compileResourcesDefinition,
  createResourcesDefinition,
  type ActorContext,
} from "@artflow-plus/domain";
import { Client } from "pg";
import type { Kysely } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  cancelResourceBookingCommand,
  confirmResourceBookingCommand,
  createResourceBooking,
  getResourcesView,
  updateResourceBooking,
} from "../src/index.js";
import type { RuntimeDeps } from "../src/index.js";

const connectionString = process.env.ARTFLOW_PLUS_DATABASE_URL;
if (process.env.REQUIRE_DB === "1" && connectionString === undefined) {
  throw new Error("REQUIRE_DB=1 but ARTFLOW_PLUS_DATABASE_URL is unset.");
}
const schema = `artflow_resources_${Date.now()}_${process.pid}`;

let db: Kysely<Database>;
let db2: Kysely<Database>;
let admin: Client;
let activityId = "";

const actor: ActorContext = {
  actorId: "resources-manager",
  actorType: "user",
  roles: ["staff"],
  permissions: ["resources.manage"],
};

function deps(target: Kysely<Database> = db): RuntimeDeps {
  return {
    now: () => "2026-11-18T10:00:00.000Z",
    newEventId: () => randomUUID(),
    actor,
  };
}

async function seed(): Promise<void> {
  const artifact = compileResourcesDefinition(createResourcesDefinition([
    { key: "hall", name: "主礼堂", kind: "venue", capacity: 800, notes: "" },
    { key: "piano", name: "钢琴", kind: "equipment", notes: "" },
  ]));
  if (!artifact.ok) throw new Error(JSON.stringify(artifact));
  activityId = `resources-activity-${randomUUID()}`;
  await db.insertInto("activity").values({
    id: activityId,
    title: "Resources runtime",
    status: "active",
    revision: 1,
    enabled_capabilities: JSON.stringify(["resources"]),
    active_definition_version: 1,
  }).execute();
  await insertRelease(db, {
    activityId,
    version: 1,
    contentHash: "resources-release",
    capabilities: { resources: artifact },
    executionPolicy: {
      declaredScopes: [],
      conflicts: {},
      runtimeContractVersion: 2,
      commandScopes: {},
    },
    capabilityVersions: { resources: "1.0.0" },
    bindings: [],
    releasedAt: "2026-11-18T09:00:00Z",
    sourceDraftRevision: 1,
  });
}

function window(startHour: number, endHour: number) {
  return {
    startsAt: `2026-11-20T${String(startHour).padStart(2, "0")}:00:00.000Z`,
    endsAt: `2026-11-20T${String(endHour).padStart(2, "0")}:00:00.000Z`,
  };
}

async function draft(startHour: number, endHour: number, title = "排练") {
  return await createResourceBooking(db, deps(), {
    commandId: randomUUID(),
    activityId,
    resourceKey: "hall",
    title,
    ...window(startHour, endHour),
  });
}

describe.skipIf(!connectionString)("resources and rehearsal bookings", () => {
  beforeAll(async () => {
    if (!connectionString) return;
    admin = new Client({ connectionString });
    await admin.connect();
    await admin.query(`CREATE SCHEMA "${schema}"`);
    db = createDb({ connectionString, schema });
    db2 = createDb({ connectionString, schema, max: 2 });
    await migrate(db);
    await seed();
  });

  afterAll(async () => {
    if (!connectionString) return;
    await closeDb(db2);
    await closeDb(db);
    await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
    await admin.end();
  });

  it("keeps drafts overlapping but rejects a conflicting confirmation", async () => {
    const first = await draft(10, 12);
    const second = await draft(11, 13);
    expect(first.body.status).toBe("draft");
    expect(second.body.status).toBe("draft");

    const confirmed = await confirmResourceBookingCommand(db, deps(), {
      commandId: randomUUID(),
      activityId,
      bookingId: first.body.id,
      expectedRevision: first.body.revision,
    });
    expect(confirmed.body.status).toBe("confirmed");

    await expect(confirmResourceBookingCommand(db, deps(), {
      commandId: randomUUID(),
      activityId,
      bookingId: second.body.id,
      expectedRevision: second.body.revision,
    })).rejects.toMatchObject({ code: "RESOURCE_CONFLICT" });

    const cancelled = await cancelResourceBookingCommand(db, deps(), {
      commandId: randomUUID(),
      activityId,
      bookingId: first.body.id,
      expectedRevision: confirmed.body.revision,
      reason: "改期",
    });
    expect(cancelled.body.status).toBe("cancelled");

    const confirmedSecond = await confirmResourceBookingCommand(db, deps(), {
      commandId: randomUUID(),
      activityId,
      bookingId: second.body.id,
      expectedRevision: second.body.revision,
    });
    expect(confirmedSecond.body.status).toBe("confirmed");

    await expect(cancelResourceBookingCommand(db, deps(), {
      commandId: randomUUID(),
      activityId,
      bookingId: second.body.id,
      expectedRevision: confirmedSecond.body.revision,
      reason: "",
    })).rejects.toMatchObject({ code: "INVALID_INPUT" });
  });

  it("rejects a confirmed update into a conflicting window and stale revisions", async () => {
    const existing = await draft(14, 16, "已确认");
    const confirmed = await confirmResourceBookingCommand(db, deps(), {
      commandId: randomUUID(),
      activityId,
      bookingId: existing.body.id,
      expectedRevision: existing.body.revision,
    });
    const other = await draft(18, 20, "另一场");
    const otherConfirmed = await confirmResourceBookingCommand(db, deps(), {
      commandId: randomUUID(),
      activityId,
      bookingId: other.body.id,
      expectedRevision: other.body.revision,
    });

    await expect(updateResourceBooking(db, deps(), {
      commandId: randomUUID(),
      activityId,
      bookingId: confirmed.body.id,
      ...window(19, 21),
      expectedRevision: confirmed.body.revision,
    })).rejects.toMatchObject({ code: "RESOURCE_CONFLICT" });

    const moved = await updateResourceBooking(db, deps(), {
      commandId: randomUUID(),
      activityId,
      bookingId: confirmed.body.id,
      ...window(21, 22),
      expectedRevision: confirmed.body.revision,
    });
    expect(moved.body.startsAt).toBe("2026-11-20T21:00:00.000Z");

    await expect(updateResourceBooking(db, deps(), {
      commandId: randomUUID(),
      activityId,
      bookingId: otherConfirmed.body.id,
      title: "stale",
      expectedRevision: otherConfirmed.body.revision - 1,
    })).rejects.toMatchObject({ code: "STALE_REVISION" });
  });

  it("serializes two simultaneous conflicting confirmations", async () => {
    const left = await draft(6, 8, "并发 A");
    const right = await draft(7, 9, "并发 B");
    const results = await Promise.allSettled([
      confirmResourceBookingCommand(db, deps(db), {
        commandId: randomUUID(), activityId, bookingId: left.body.id, expectedRevision: left.body.revision,
      }),
      confirmResourceBookingCommand(db2, deps(db2), {
        commandId: randomUUID(), activityId, bookingId: right.body.id, expectedRevision: right.body.revision,
      }),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected").map((result) => (result as PromiseRejectedResult).reason.code)).toContain("RESOURCE_CONFLICT");
  });

  it("returns the frozen resource definitions with bookings", async () => {
    const view = await getResourcesView(db, deps(), activityId);
    expect(view.definitionVersion).toBe(1);
    expect(view.resources.map((resource) => resource.key)).toEqual(["hall", "piano"]);
    expect(view.bookings.length).toBeGreaterThan(0);
  });
});
