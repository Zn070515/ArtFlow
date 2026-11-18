import { randomUUID } from "node:crypto";

import { Client } from "pg";
import type { Kysely } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { closeDb, createDb, migrate } from "@artflow-plus/db";
import type { Database } from "@artflow-plus/db";
import type { ActorContext } from "@artflow-plus/domain";

import type { RuntimeDeps } from "../src/deps.js";
import { getPublicEventSite } from "../src/public-event-service.js";
import { updateActivityPublicProfile } from "../src/public-profile-service.js";

const connectionString = process.env.ARTFLOW_PLUS_DATABASE_URL;
if (process.env.REQUIRE_DB === "1" && connectionString === undefined) {
  throw new Error("REQUIRE_DB=1 but ARTFLOW_PLUS_DATABASE_URL is unset.");
}
const schema = `artflow_public_event_${Date.now()}_${process.pid}`;

let db: Kysely<Database>;
let admin: Client;
let tick = 0;

const staff: ActorContext = {
  actorId: "public-event-staff",
  actorType: "user",
  roles: ["staff"],
  permissions: ["studio.manage"],
};

function deps(): RuntimeDeps {
  return {
    actor: staff,
    now: () => new Date(Date.UTC(2026, 3, 1, 10, 0, tick++)).toISOString(),
    newEventId: () => `public-event-${randomUUID()}`,
  };
}

async function seed(status: "draft" | "active" | "closed" | "archived") {
  const id = `act-${randomUUID()}`;
  const publicCode = `SITE-${randomUUID()}`;
  await db.insertInto("activity").values({
    id,
    public_code: publicCode,
    title: "春日声场",
    status,
    revision: 1,
    enabled_capabilities: JSON.stringify(["publishing"]),
    active_definition_version: 1,
  }).execute();
  return { id, publicCode };
}

function input(activityId: string) {
  return {
    commandId: randomUUID(),
    activityId,
    expectedRevision: 0,
    tagline: "春日",
    description: "介绍",
    venue: "剧场",
    startsAt: null,
    endsAt: null,
    organizer: "学生会",
    contact: "联系",
    announcement: "公告",
  };
}

describe.skipIf(!connectionString)("public event site read model", () => {
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

  it("returns null for draft and archived activities", async () => {
    const draft = await seed("draft");
    expect(await getPublicEventSite(db, draft.publicCode)).toBeNull();
    const archived = await seed("archived");
    expect(await getPublicEventSite(db, archived.publicCode)).toBeNull();
  });

  it("composes the profile without internal ids", async () => {
    const activity = await seed("active");
    await updateActivityPublicProfile(db, deps(), input(activity.id));
    const site = await getPublicEventSite(db, activity.publicCode);
    expect(site?.profile.tagline).toBe("春日");
    expect(site?.activity.publicCode).toBe(activity.publicCode);
    expect(JSON.stringify(site)).not.toContain(activity.id);
  });

  it("returns default profile and null sections when nothing is published", async () => {
    const activity = await seed("active");
    const site = await getPublicEventSite(db, activity.publicCode);
    expect(site?.profile.tagline).toBe("");
    expect(site?.results).toBeNull();
  });

  it("restores the public event after unarchive", async () => {
    const activity = await seed("archived");
    expect(await getPublicEventSite(db, activity.publicCode)).toBeNull();
    await db.updateTable("activity").set({ status: "closed" })
      .where("id", "=", activity.id).execute();
    expect(await getPublicEventSite(db, activity.publicCode)).not.toBeNull();
  });
});
