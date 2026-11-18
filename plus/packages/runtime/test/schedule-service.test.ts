import { randomUUID } from "node:crypto";

import { closeDb, createDb, insertRelease, insertSession, migrate } from "@artflow-plus/db";
import type { Database } from "@artflow-plus/db";
import type { ActorContext } from "@artflow-plus/domain";
import { Client } from "pg";
import type { Kysely } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  advanceSchedule,
  getPublicProgram,
  getPublicSchedule,
  getScheduleState,
  releaseSchedule,
  removeScheduleEntry,
  reorderSchedule,
  revokeScheduleReleaseCommand,
  upsertScheduleEntry,
} from "../src/index.js";
import type { RuntimeDeps } from "../src/index.js";

const connectionString = process.env.ARTFLOW_PLUS_DATABASE_URL;
if (process.env.REQUIRE_DB === "1" && connectionString === undefined) {
  throw new Error("REQUIRE_DB=1 but ARTFLOW_PLUS_DATABASE_URL is unset.");
}
const schema = `artflow_schedule_${Date.now()}_${process.pid}`;
let db: Kysely<Database>;
let admin: Client;

const actor: ActorContext = {
  actorId: "schedule-staff",
  actorType: "user",
  roles: ["staff"],
  permissions: ["schedule.manage"],
};
let tick = 0;
const deps: RuntimeDeps = {
  actor,
  now: () => new Date(Date.UTC(2026, 10, 14, 10, 0, tick++)).toISOString(),
  newEventId: () => `schedule-${randomUUID()}`,
};

async function seed(): Promise<string> {
  const activityId = `activity-${randomUUID()}`;
  await db.insertInto("activity").values({
    id: activityId,
    public_code: `SCH-${activityId.slice(-8)}`,
    title: "毕业晚会",
    status: "active",
    revision: 1,
    enabled_capabilities: JSON.stringify(["schedule"]),
    active_definition_version: 1,
  }).execute();
  await insertRelease(db, {
    activityId,
    version: 1,
    contentHash: "schedule-release",
    capabilities: {
      schedule: {
        ok: true,
        capabilityKey: "schedule",
        contentHash: "schedule-content",
        artifact: {
          version: 1,
          schemaVersion: 1,
          slots: [
            { key: "opening", label: "开场", durationMinutes: 10, kind: "ceremony" },
            { key: "programs", label: "节目", durationMinutes: 6, kind: "program" },
          ],
        },
      },
    },
    executionPolicy: {
      declaredScopes: ["schedule"],
      conflicts: {},
      runtimeContractVersion: 2,
      commandScopes: { "schedule.current.advance": ["schedule"] },
    },
    capabilityVersions: { schedule: "1" },
    bindings: [],
    releasedAt: "2026-11-14T09:00:00Z",
    sourceDraftRevision: 1,
  });
  return activityId;
}

describe.skipIf(!connectionString)("schedule service", () => {
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

  it("adds, reorders, releases, and exposes a public snapshot", async () => {
    const activityId = await seed();
    const add = await upsertScheduleEntry(db, deps, {
      commandId: randomUUID(),
      activityId,
      mode: "formal",
      expectedRevision: 0,
      slotKey: "opening",
      participantId: "p1",
      title: "开场舞",
    });
    expect(add.body.revision).toBe(1);
    expect(add.body.entry.title).toBe("开场舞");

    const reordered = await reorderSchedule(db, deps, {
      commandId: randomUUID(),
      activityId,
      mode: "formal",
      expectedRevision: 1,
      orderedIds: [add.body.entry.id],
    });
    expect(reordered.body.revision).toBe(2);
    expect(reordered.body.entries).toHaveLength(1);

    const release = await releaseSchedule(db, deps, {
      commandId: randomUUID(),
      activityId,
      mode: "formal",
      expectedRevision: 2,
      note: "首版节目单",
    });
    expect(release.body.version).toBe(1);
    expect(release.body.snapshot.entries[0]).toMatchObject({
      order: 1,
      slotKey: "opening",
      slotLabel: "开场",
      title: "开场舞",
    });

    const activity = await db.selectFrom("activity").select("public_code")
      .where("id", "=", activityId).executeTakeFirstOrThrow();
    const publicView = await getPublicSchedule(db, activity.public_code);
    expect(publicView?.entries[0]?.title).toBe("开场舞");
    expect(publicView?.entries[0]?.slotLabel).toBe("开场");
  });

  it("advances the current entry inside a running schedule session", async () => {
    const activityId = await seed();
    const first = await upsertScheduleEntry(db, deps, {
      commandId: randomUUID(),
      activityId,
      mode: "formal",
      expectedRevision: 0,
      slotKey: "opening",
      title: "开场舞",
    });
    const second = await upsertScheduleEntry(db, deps, {
      commandId: randomUUID(),
      activityId,
      mode: "formal",
      expectedRevision: 1,
      slotKey: "programs",
      title: "合唱",
    });
    await insertSession(db, {
      id: `session-${activityId}`,
      activityId,
      definitionVersion: 1,
      contentHash: "schedule-release",
      scope: "schedule",
      mode: "formal",
      status: "running",
      revision: 0,
    }, "2026-11-14T09:30:00Z");

    const advanced = await advanceSchedule(db, deps, {
      commandId: randomUUID(),
      activityId,
    });
    expect(advanced.body.mode).toBe("formal");
    expect([first.body.entry.id, second.body.entry.id]).toContain(advanced.body.currentEntryId);

    const view = await getScheduleState(db, activityId, "formal");
    expect(view.currentEntryId).toBe(advanced.body.currentEntryId);
  });

  it("rejects a stale schedule revision and removes an entry", async () => {
    const activityId = await seed();
    const entry = await upsertScheduleEntry(db, deps, {
      commandId: randomUUID(),
      activityId,
      mode: "formal",
      expectedRevision: 0,
      slotKey: "opening",
      title: "开场舞",
    });

    await expect(
      upsertScheduleEntry(db, deps, {
        commandId: randomUUID(),
        activityId,
        mode: "formal",
        expectedRevision: 0,
        slotKey: "opening",
        title: "重复",
      }),
    ).rejects.toMatchObject({ code: "STALE_REVISION" });

    const removed = await removeScheduleEntry(db, deps, {
      commandId: randomUUID(),
      activityId,
      mode: "formal",
      expectedRevision: 1,
      entryId: entry.body.entry.id,
    });
    expect(removed.body.revision).toBe(2);
    expect((await getScheduleState(db, activityId, "formal")).entries).toHaveLength(0);
  });

  it("normalizes positions after removing a middle entry", async () => {
    const activityId = await seed();
    const first = await upsertScheduleEntry(db, deps, {
      commandId: randomUUID(), activityId, mode: "formal", expectedRevision: 0,
      slotKey: "opening", title: "开场",
    });
    const second = await upsertScheduleEntry(db, deps, {
      commandId: randomUUID(), activityId, mode: "formal", expectedRevision: 1,
      slotKey: "programs", title: "节目一",
    });
    const third = await upsertScheduleEntry(db, deps, {
      commandId: randomUUID(), activityId, mode: "formal", expectedRevision: 2,
      slotKey: "programs", title: "节目二",
    });
    expect(third.body.entry.position).toBe(2);
    await removeScheduleEntry(db, deps, {
      commandId: randomUUID(), activityId, mode: "formal", expectedRevision: 3,
      entryId: second.body.entry.id,
    });
    const view = await getScheduleState(db, activityId, "formal");
    expect(view.entries.map((item) => item.id)).toEqual([first.body.entry.id, third.body.entry.id]);
    expect(view.entries.map((item) => item.position)).toEqual([0, 1]);
  });

  it("requires schedule.manage to advance and bumps the state revision", async () => {
    const activityId = await seed();
    await upsertScheduleEntry(db, deps, {
      commandId: randomUUID(), activityId, mode: "formal", expectedRevision: 0,
      slotKey: "opening", title: "开场",
    });
    await insertSession(db, {
      id: `session-${activityId}`, activityId, definitionVersion: 1,
      contentHash: "schedule-release", scope: "schedule", mode: "formal",
      status: "running", revision: 0,
    }, "2026-11-14T09:30:00Z");
    const outsider: RuntimeDeps = {
      ...deps,
      actor: { actorId: "outsider", actorType: "user", roles: ["participant"], permissions: [] },
    };
    await expect(advanceSchedule(db, outsider, {
      commandId: randomUUID(), activityId,
    })).rejects.toMatchObject({ code: "FORBIDDEN" });

    await advanceSchedule(db, deps, { commandId: randomUUID(), activityId });
    expect((await getScheduleState(db, activityId, "formal")).revision).toBe(2);
  });

  it("rejects revoking another activity's release", async () => {
    const owner = await seed();
    const other = await seed();
    await upsertScheduleEntry(db, deps, {
      commandId: randomUUID(), activityId: owner, mode: "formal", expectedRevision: 0,
      slotKey: "opening", title: "开场",
    });
    const release = await releaseSchedule(db, deps, {
      commandId: randomUUID(), activityId: owner, mode: "formal", expectedRevision: 1,
    });
    await expect(revokeScheduleReleaseCommand(db, deps, {
      commandId: randomUUID(), activityId: other, releaseId: release.body.id,
      expectedRevision: 0,
    })).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("fails closed when the newest public release is revoked and hides archived activities", async () => {
    const activityId = await seed();
    await upsertScheduleEntry(db, deps, {
      commandId: randomUUID(), activityId, mode: "formal", expectedRevision: 0,
      slotKey: "opening", title: "第一版",
    });
    const first = await releaseSchedule(db, deps, {
      commandId: randomUUID(), activityId, mode: "formal", expectedRevision: 1,
    });
    await upsertScheduleEntry(db, deps, {
      commandId: randomUUID(), activityId, mode: "formal", expectedRevision: 2,
      slotKey: "programs", title: "第二版新增",
    });
    const second = await releaseSchedule(db, deps, {
      commandId: randomUUID(), activityId, mode: "formal", expectedRevision: 3,
    });
    const activity = await db.selectFrom("activity").select("public_code")
      .where("id", "=", activityId).executeTakeFirstOrThrow();
    expect((await getPublicSchedule(db, activity.public_code))?.entries.length).toBe(2);

    await revokeScheduleReleaseCommand(db, deps, {
      commandId: randomUUID(), activityId, releaseId: second.body.id,
      expectedRevision: 4,
    });
    expect(await getPublicSchedule(db, activity.public_code)).toBeNull();
    expect(first.body.version).toBe(1);

    const archived = await seed();
    await upsertScheduleEntry(db, deps, {
      commandId: randomUUID(), activityId: archived, mode: "formal", expectedRevision: 0,
      slotKey: "opening", title: "归档节目",
    });
    await releaseSchedule(db, deps, {
      commandId: randomUUID(), activityId: archived, mode: "formal", expectedRevision: 1,
    });
    const archivedRow = await db.selectFrom("activity").select("public_code")
      .where("id", "=", archived).executeTakeFirstOrThrow();
    expect(await getPublicSchedule(db, archivedRow.public_code)).not.toBeNull();
    await db.updateTable("activity").set({ status: "archived" })
      .where("id", "=", archived).execute();
    expect(await getPublicSchedule(db, archivedRow.public_code)).toBeNull();
  });

  it("revokes a released snapshot", async () => {
    const activityId = await seed();
    const entry = await upsertScheduleEntry(db, deps, {
      commandId: randomUUID(),
      activityId,
      mode: "formal",
      expectedRevision: 0,
      slotKey: "opening",
      title: "开场舞",
    });
    const release = await releaseSchedule(db, deps, {
      commandId: randomUUID(),
      activityId,
      mode: "formal",
      expectedRevision: 1,
      note: "首版节目单",
    });
    const revoked = await revokeScheduleReleaseCommand(db, deps, {
      commandId: randomUUID(),
      activityId,
      releaseId: release.body.id,
      expectedRevision: 2,
      note: "节目调整",
    });
    expect(revoked.body.revokedAt).not.toBeNull();
    expect(revoked.body.note).toContain("首版节目单");
    expect(revoked.body.note).toContain("节目调整");
    expect(entry.body.entry.id).toBeDefined();
    expect((await getScheduleState(db, activityId, "formal")).revision).toBe(3);
  });

  it("stores startsAt, preserves it on update, and freezes it into the release snapshot", async () => {
    const activityId = await seed();
    const first = await upsertScheduleEntry(db, deps, {
      commandId: randomUUID(), activityId, mode: "formal", expectedRevision: 0,
      slotKey: "opening", title: "开场舞", startsAt: "2026-04-18T11:00:00.000Z",
    });
    expect(first.body.entry.startsAt).toBe("2026-04-18T11:00:00.000Z");
    const second = await upsertScheduleEntry(db, deps, {
      commandId: randomUUID(), activityId, mode: "formal", expectedRevision: 1,
      entryId: first.body.entry.id, slotKey: "opening", title: "开场舞 2",
    });
    expect(second.body.entry.startsAt).toBe("2026-04-18T11:00:00.000Z");
    const cleared = await upsertScheduleEntry(db, deps, {
      commandId: randomUUID(), activityId, mode: "formal", expectedRevision: 2,
      entryId: first.body.entry.id, slotKey: "opening", title: "开场舞 3", startsAt: null,
    });
    expect(cleared.body.entry.startsAt).toBeNull();
    await expect(upsertScheduleEntry(db, deps, {
      commandId: randomUUID(), activityId, mode: "formal", expectedRevision: 3,
      slotKey: "opening", title: "坏时间", startsAt: "not-a-date",
    })).rejects.toMatchObject({ code: "INVALID_INPUT" });
  });

  it("normalizes a legacy snapshot without startsAt", async () => {
    const activityId = await seed();
    await db.insertInto("schedule_release").values({
      id: `release-legacy-${randomUUID()}`,
      activity_id: activityId,
      mode: "formal",
      version: 1,
      snapshot: JSON.stringify({
        version: 1, schemaVersion: 1, releasedAt: "2026-04-01T10:00:00.000Z",
        entries: [{ order: 1, slotKey: "opening", slotLabel: "开场", participantId: null, title: "旧版", note: "" }],
      }),
      note: "", released_at: new Date("2026-04-01T10:00:00.000Z"), revoked_at: null,
    }).execute();
    const activity = await db.selectFrom("activity").select("public_code")
      .where("id", "=", activityId).executeTakeFirstOrThrow();
    expect((await getPublicSchedule(db, activity.public_code))?.entries[0]?.startsAt).toBeNull();
  });

  it("fails the public program closed when the newest release is revoked", async () => {
    const activityId = await seed();
    await upsertScheduleEntry(db, deps, {
      commandId: randomUUID(), activityId, mode: "formal", expectedRevision: 0,
      slotKey: "opening", title: "开场舞",
    });
    const first = await releaseSchedule(db, deps, {
      commandId: randomUUID(), activityId, mode: "formal", expectedRevision: 1,
    });
    await upsertScheduleEntry(db, deps, {
      commandId: randomUUID(), activityId, mode: "formal", expectedRevision: 2,
      slotKey: "programs", title: "第二版",
    });
    const second = await releaseSchedule(db, deps, {
      commandId: randomUUID(), activityId, mode: "formal", expectedRevision: 3,
    });
    await revokeScheduleReleaseCommand(db, deps, {
      commandId: randomUUID(), activityId, releaseId: second.body.id, expectedRevision: 4,
    });
    const activity = await db.selectFrom("activity").select("public_code")
      .where("id", "=", activityId).executeTakeFirstOrThrow();
    expect(await getPublicSchedule(db, activity.public_code)).toBeNull();
    expect(await getPublicProgram(db, activity.public_code)).toBeNull();
    expect(first.body.version).toBe(1);
  });

  it("never exposes a rehearsal schedule release", async () => {
    const activityId = await seed();
    await upsertScheduleEntry(db, deps, {
      commandId: randomUUID(), activityId, mode: "rehearsal", expectedRevision: 0,
      slotKey: "opening", title: "彩排节目",
    });
    await releaseSchedule(db, deps, {
      commandId: randomUUID(), activityId, mode: "rehearsal", expectedRevision: 1,
    });
    const activity = await db.selectFrom("activity").select("public_code")
      .where("id", "=", activityId).executeTakeFirstOrThrow();
    expect(await getPublicSchedule(db, activity.public_code)).toBeNull();
    expect((await getPublicProgram(db, activity.public_code))?.entries).toEqual([]);
  });
});
