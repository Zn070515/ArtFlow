import { randomUUID } from "node:crypto";

import { Client } from "pg";
import type { Kysely } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { closeDb, createDb, findActivityPublicProfile, migrate, readEventsSince } from "@artflow-plus/db";
import type { Database } from "@artflow-plus/db";
import { createDefaultCapabilityRegistry } from "@artflow-plus/domain";
import type { ActorContext } from "@artflow-plus/domain";

import { duplicateActivity } from "../src/activity-service.js";
import type { RuntimeDeps } from "../src/deps.js";
import { updateActivityPublicProfile } from "../src/public-profile-service.js";

const connectionString = process.env.ARTFLOW_PLUS_DATABASE_URL;
if (process.env.REQUIRE_DB === "1" && connectionString === undefined) {
  throw new Error("REQUIRE_DB=1 but ARTFLOW_PLUS_DATABASE_URL is unset.");
}
const schema = `artflow_public_profile_${Date.now()}_${process.pid}`;

let db: Kysely<Database>;
let admin: Client;
let tick = 0;

const staff: ActorContext = {
  actorId: "public-profile-staff",
  actorType: "user",
  roles: ["staff"],
  permissions: ["studio.manage"],
};
const participant: ActorContext = {
  actorId: "public-profile-participant",
  actorType: "user",
  roles: ["participant"],
  permissions: [],
};

function deps(actor: ActorContext = staff): RuntimeDeps {
  return {
    actor,
    now: () => new Date(Date.UTC(2026, 3, 1, 10, 0, tick++)).toISOString(),
    newEventId: () => `public-profile-${randomUUID()}`,
  };
}

async function seed(status: "draft" | "active" | "closed" | "archived" = "active"): Promise<string> {
  const id = `act-${randomUUID()}`;
  await db.insertInto("activity").values({
    id,
    public_code: id,
    title: "公开资料",
    status,
    revision: 1,
    enabled_capabilities: JSON.stringify(["publishing"]),
    active_definition_version: 1,
  }).execute();
  return id;
}

function input(activityId: string, overrides: Record<string, unknown> = {}) {
  return {
    commandId: randomUUID(),
    activityId,
    expectedRevision: 0,
    tagline: "春日声场",
    description: "介绍",
    venue: "剧场",
    startsAt: "2026-04-18T11:00:00.000Z",
    endsAt: "2026-04-18T13:30:00.000Z",
    organizer: "学生会",
    contact: "联系",
    announcement: "公告",
    announcements: [],
    faq: [],
    links: [],
    participantsVisible: false,
    listedPublicly: false,
    ...overrides,
  };
}

describe.skipIf(!connectionString)("activity.public_profile.update", () => {
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

  it("creates the profile and writes an engine event", async () => {
    const activityId = await seed();
    const outcome = await updateActivityPublicProfile(db, deps(), input(activityId));
    expect(outcome.body).toMatchObject({ activityId, tagline: "春日声场", revision: 1 });
    expect((await readEventsSince(db, { activityId, after: 0, limit: 20 })).map((event) => event.type))
      .toContain("ActivityPublicProfileUpdated");
  });

  it("saves content blocks and rejects invalid shapes", async () => {
    const activityId = await seed();
    const saved = await updateActivityPublicProfile(db, deps(), input(activityId, {
      announcements: [{
        id: "a1",
        title: "公告",
        body: "内容",
        publishedAt: "2026-04-01T10:00:00.000Z",
      }],
      faq: [{ question: "问", answer: "答" }],
      links: [{ label: "官网", url: "https://example.com" }],
      participantsVisible: true,
      listedPublicly: true,
    }));
    expect(saved.body).toMatchObject({
      participantsVisible: true,
      listedPublicly: true,
      faq: [{ question: "问", answer: "答" }],
    });

    const invalid = await seed();
    await expect(updateActivityPublicProfile(db, deps(), input(invalid, {
      links: [{ label: "坏", url: "javascript:alert(1)" }],
    }))).rejects.toMatchObject({ code: "INVALID_INPUT" });
    await expect(updateActivityPublicProfile(db, deps(), input(invalid, {
      faq: [{ question: "问", answer: "" }],
    }))).rejects.toMatchObject({ code: "INVALID_INPUT" });
    await expect(updateActivityPublicProfile(db, deps(), input(invalid, {
      announcements: [
        { id: "a", title: "t", body: "b", publishedAt: "2026-04-01T10:00:00.000Z" },
        { id: "a", title: "t", body: "b", publishedAt: "2026-04-01T10:00:00.000Z" },
      ],
    }))).rejects.toMatchObject({ code: "INVALID_INPUT" });
    await expect(updateActivityPublicProfile(db, deps(), input(invalid, {
      announcements: Array.from({ length: 21 }, (_, index) => ({
        id: `a${index}`,
        title: "t",
        body: "b",
        publishedAt: "2026-04-01T10:00:00.000Z",
      })),
    }))).rejects.toMatchObject({ code: "INVALID_INPUT" });
  });

  it("rejects stale revisions, invalid order, archived activities and participants", async () => {
    const activityId = await seed();
    await updateActivityPublicProfile(db, deps(), input(activityId));
    await expect(updateActivityPublicProfile(db, deps(), input(activityId)))
      .rejects.toMatchObject({ code: "STALE_REVISION" });
    await expect(updateActivityPublicProfile(db, deps(), input(activityId, {
      expectedRevision: 1,
      startsAt: "2026-04-18T14:00:00.000Z",
      endsAt: "2026-04-18T13:00:00.000Z",
    }))).rejects.toMatchObject({ code: "INVALID_INPUT" });
    const archived = await seed("archived");
    await expect(updateActivityPublicProfile(db, deps(), input(archived)))
      .rejects.toMatchObject({ code: "ACTIVITY_ARCHIVED" });
    const participantActivity = await seed();
    await expect(updateActivityPublicProfile(db, deps(participant), input(participantActivity)))
      .rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("rolls back the profile when the event append fails, then retries cleanly", async () => {
    const activityId = await seed();
    const failing: RuntimeDeps = {
      ...deps(),
      newEventId: () => {
        throw new Error("event id failed");
      },
    };
    await expect(updateActivityPublicProfile(db, failing, input(activityId)))
      .rejects.toThrow("event id failed");
    expect(await findActivityPublicProfile(db, activityId)).toBeNull();
    const retried = await updateActivityPublicProfile(db, deps(), input(activityId));
    expect(retried.body.revision).toBe(1);
  });

  it("serializes two first saves through the activity lock", async () => {
    const activityId = await seed();
    await updateActivityPublicProfile(db, deps(), input(activityId));
    await expect(updateActivityPublicProfile(db, deps(), input(activityId, { tagline: "第二位" })))
      .rejects.toMatchObject({ code: "STALE_REVISION" });
    const rows = await db.selectFrom("activity_public_profile").select("activity_id")
      .where("activity_id", "=", activityId).execute();
    expect(rows).toHaveLength(1);
  });

  it("replays the same command id without a second revision", async () => {
    const activityId = await seed();
    const body = input(activityId);
    const first = await updateActivityPublicProfile(db, deps(), body);
    const second = await updateActivityPublicProfile(db, deps(), body);
    expect(second.replayed).toBe(true);
    expect(second.body.revision).toBe(first.body.revision);
  });

  it("does not copy the public profile when an activity is duplicated", async () => {
    const source = await seed();
    await updateActivityPublicProfile(db, deps(), input(source));
    const duplicated = await duplicateActivity(db, createDefaultCapabilityRegistry(), deps(), {
      commandId: randomUUID(),
      sourceActivityId: source,
    });
    expect(await findActivityPublicProfile(db, duplicated.body.id)).toBeNull();
  });
});
