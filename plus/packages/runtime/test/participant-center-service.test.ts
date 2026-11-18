import { randomUUID } from "node:crypto";

import { Client } from "pg";
import type { Kysely } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  closeDb,
  createDb,
  insertMaterial,
  insertRegistration,
  insertResultPublication,
  insertResultRelease,
  insertStageResult,
  migrate,
} from "@artflow-plus/db";
import type { Database } from "@artflow-plus/db";
import type { ActorContext } from "@artflow-plus/domain";

import type { RuntimeDeps } from "../src/deps.js";
import { getParticipantCenter, markParticipantNotificationsRead } from "../src/participant-center-service.js";

const connectionString = process.env.ARTFLOW_PLUS_DATABASE_URL;
if (process.env.REQUIRE_DB === "1" && connectionString === undefined) {
  throw new Error("REQUIRE_DB=1 but ARTFLOW_PLUS_DATABASE_URL is unset.");
}
const schema = `artflow_participant_center_${Date.now()}_${process.pid}`;

let db: Kysely<Database>;
let admin: Client;

function actor(actorId: string): ActorContext {
  return { actorId, actorType: "user", roles: ["participant"], permissions: [] };
}
function deps(actorId: string): RuntimeDeps {
  return {
    actor: actor(actorId),
    now: () => "2026-04-18T13:00:00.000Z",
    newEventId: () => randomUUID(),
  };
}

async function seedActivity(id: string, publicCode: string, title: string): Promise<void> {
  await db.insertInto("activity").values({
    id,
    public_code: publicCode,
    title,
    status: "active",
    revision: 1,
    enabled_capabilities: JSON.stringify(["registration", "questionnaire", "materials"]),
    active_definition_version: 1,
  }).execute();
}

async function seedRegistration(
  id: string,
  activityId: string,
  participantId: string,
  status: "approved" | "submitted",
): Promise<void> {
  await insertRegistration(db, {
    id,
    activityId,
    participantId,
    questionnaireVersion: "v1",
    questionnaireHash: "hash",
    status,
    answers: { name: participantId },
    supplementKeys: [],
    revision: 2,
    reviewNote: "欢迎",
    reviewedBy: "staff",
  });
}

async function seedMaterial(activityId: string, registrationId: string, ownerActorId: string): Promise<void> {
  await insertMaterial(db, {
    id: `mat-${ownerActorId}`,
    activityId,
    registrationId,
    questionKey: "audio",
    storageKey: `storage-${ownerActorId}`,
    originalName: "demo.mp3",
    contentType: "audio/mpeg",
    byteLength: 3,
    ownerActorId,
    status: "approved",
    reviewNote: "很好",
    reviewedBy: "staff",
    reviewedAt: "2026-04-18T12:00:00.000Z",
    revision: 1,
    current: true,
    contentReady: true,
  });
}

describe.skipIf(!connectionString)("participant center service", () => {
  beforeAll(async () => {
    if (!connectionString) return;
    admin = new Client({ connectionString });
    await admin.connect();
    await admin.query(`CREATE SCHEMA "${schema}"`);
    db = createDb({ connectionString, schema });
    await migrate(db);

    await seedActivity("act-me-1", "ME-1", "活动 ME-1");
    await seedActivity("act-me-2", "ME-2", "活动 ME-2");
    await seedRegistration("reg-a", "act-me-1", "participant-a", "approved");
    await seedRegistration("reg-b", "act-me-2", "participant-b", "submitted");
    await seedMaterial("act-me-1", "reg-a", "participant-a");
    await seedMaterial("act-me-2", "reg-b", "participant-b");

    await db.insertInto("schedule_release").values({
      id: "release-schedule-1",
      activity_id: "act-me-1",
      mode: "formal",
      version: 1,
      snapshot: JSON.stringify({
        version: 1,
        schemaVersion: 1,
        releasedAt: "2026-04-18T11:00:00.000Z",
        entries: [
          {
            order: 1,
            slotKey: "opening",
            slotLabel: "第一轮",
            participantId: "participant-a",
            title: "我的节目",
            note: "",
            startsAt: "2026-04-18T11:00:00.000Z",
          },
          {
            order: 2,
            slotKey: "opening",
            slotLabel: "第一轮",
            participantId: "participant-b",
            title: "别人的节目",
            note: "",
            startsAt: "2026-04-18T11:10:00.000Z",
          },
        ],
      }),
      note: "",
      released_at: new Date("2026-04-18T11:00:00.000Z"),
      revoked_at: null,
    }).execute();

    const decisions = [
      { rank: 1, contestantId: "participant-a", score: "98.00" },
      { rank: 2, contestantId: "participant-b", score: "97.00" },
    ];
    const awards = [{ award: "冠军", contestantId: "participant-a" }];
    await insertStageResult(db, {
      id: "stage-me-1",
      activityId: "act-me-1",
      stageKey: "final",
      status: "confirmed",
      candidateRevision: 1,
      sourceCandidateRevision: 1,
      inputFingerprint: "fp",
      source: {
        kind: "podium_candidate",
        aggregateId: "stage-me-1",
        definitionVersion: 1,
        releaseHash: "test",
        mode: "formal",
        sourceRevision: 1,
        inputFingerprint: "fp",
      },
      decisions,
      awards,
      note: "",
      revision: 1,
      confirmedAt: "2026-04-18T13:00:00.000Z",
      staleReason: "",
    });
    await insertResultPublication(db, {
      id: "pub-me-1",
      activityId: "act-me-1",
      stageKey: "final",
      title: "正式赛果",
      content: "",
      version: 1,
      revision: 0,
    });
    await insertResultRelease(db, {
      id: "release-result-1",
      activityId: "act-me-1",
      publicationId: "pub-me-1",
      stageResultId: "stage-me-1",
      stageKey: "final",
      status: "active",
      snapshot: {
        activityTitle: "活动 ME-1",
        publicTitle: "活动 ME-1 · 正式赛果",
        stageKey: "final",
        decisions,
        awards,
      },
      snapshotCandidateRevision: 1,
      resultVersion: 1,
      postVersion: 1,
      inputFingerprint: "fp",
      note: "",
      releasedAt: "2026-04-18T13:00:00.000Z",
      revision: 0,
    });
  });

  afterAll(async () => {
    if (!connectionString) return;
    await closeDb(db);
    await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
    await admin.end();
  });

  it("returns only the actor's events", async () => {
    const center = await getParticipantCenter(db, deps("participant-a"));
    expect(center.events).toHaveLength(1);
    expect(center.events[0]?.activity.publicCode).toBe("ME-1");
    expect(JSON.stringify(center)).not.toContain("ME-2");
  });

  it("filters schedule and results to the actor", async () => {
    const center = await getParticipantCenter(db, deps("participant-a"));
    expect(center.events[0]?.schedule).toEqual([
      expect.objectContaining({ title: "我的节目", startsAt: "2026-04-18T11:00:00.000Z" }),
    ]);
    expect(center.events[0]?.schedule).toHaveLength(1);
    expect(center.events[0]?.results[0]).toMatchObject({ rank: 1, awards: ["冠军"] });
  });

  it("derives notifications and marks keys read idempotently", async () => {
    const center = await getParticipantCenter(db, deps("participant-a"));
    const keys = center.notifications.items.map((item) => item.key);
    expect(keys.length).toBeGreaterThan(0);
    expect(center.notifications.unreadCount).toBe(keys.length);
    const first = await markParticipantNotificationsRead(db, deps("participant-a"), keys);
    expect(first.unreadCount).toBe(0);
    const second = await markParticipantNotificationsRead(db, deps("participant-a"), keys);
    expect(second.unreadCount).toBe(0);
    const after = await getParticipantCenter(db, deps("participant-a"));
    expect(after.notifications.items.every((item) => item.read)).toBe(true);
  });

  it("ignores unknown keys and keeps actors isolated", async () => {
    await markParticipantNotificationsRead(db, deps("participant-b"), [
      "ME-1:registration:approved:x:y",
    ]);
    const rows = await db.selectFrom("participant_notification_read")
      .select("notification_key")
      .where("actor_id", "=", "participant-b")
      .execute();
    expect(rows).toHaveLength(0);
    const a = await getParticipantCenter(db, deps("participant-a"));
    expect(JSON.stringify(a)).not.toContain("ME-2");
  });

  it("marks archived events read-only", async () => {
    await db.updateTable("activity").set({ status: "archived" }).where("id", "=", "act-me-1").execute();
    const center = await getParticipantCenter(db, deps("participant-a"));
    expect(center.events[0]?.archived).toBe(true);
    expect(center.events[0]?.links.event).toBeNull();
    expect(center.events[0]?.schedule).toEqual([]);
    expect(center.events[0]?.results).toEqual([]);
    expect(center.notifications.items.some((item) => item.kind === "schedule")).toBe(false);
    expect(center.notifications.items.some((item) => item.kind === "result")).toBe(false);
    expect(center.notifications.items.some((item) => item.kind === "registration")).toBe(true);
    await db.updateTable("activity").set({ status: "active" }).where("id", "=", "act-me-1").execute();
  });
});
