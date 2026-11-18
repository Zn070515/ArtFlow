import { randomUUID } from "node:crypto";

import { Client } from "pg";
import type { Kysely } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { closeDb, createDb, migrate } from "../src/index.js";
import type { Database } from "../src/index.js";
import {
  findActivityPublicProfile,
  getActivityPublicProfile,
  upsertActivityPublicProfile,
} from "../src/activity-public-profile-repository.js";

const connectionString = process.env.ARTFLOW_PLUS_DATABASE_URL;
if (process.env.REQUIRE_DB === "1" && connectionString === undefined) {
  throw new Error("REQUIRE_DB=1 but ARTFLOW_PLUS_DATABASE_URL is unset.");
}
const schema = `artflow_public_profile_repo_${Date.now()}_${process.pid}`;

let db: Kysely<Database>;
let admin: Client;

describe.skipIf(!connectionString)("activity public profile repository", () => {
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

  async function seedActivity(): Promise<string> {
    const id = `act-${randomUUID()}`;
    await db.insertInto("activity").values({
      id,
      public_code: id,
      title: "公开资料",
      status: "active",
      revision: 1,
      enabled_capabilities: JSON.stringify(["publishing"]),
      active_definition_version: 1,
    }).execute();
    return id;
  }

  it("returns empty defaults when no row exists", async () => {
    const activityId = await seedActivity();
    expect(await findActivityPublicProfile(db, activityId)).toBeNull();
    expect(await getActivityPublicProfile(db, activityId)).toMatchObject({
      activityId,
      tagline: "",
      revision: 0,
    });
  });

  it("creates then rejects a stale revision", async () => {
    const activityId = await seedActivity();
    const created = await upsertActivityPublicProfile(db, {
      activityId,
      tagline: "春日",
      description: "",
      venue: "",
      startsAt: null,
      endsAt: null,
      organizer: "",
      contact: "",
      announcement: "",
      updatedBy: "staff",
      updatedAt: "2026-04-01T10:00:00.000Z",
    }, 0);
    expect(created.revision).toBe(1);
    await expect(upsertActivityPublicProfile(db, {
      activityId,
      tagline: "第二次",
      description: "",
      venue: "",
      startsAt: null,
      endsAt: null,
      organizer: "",
      contact: "",
      announcement: "",
      updatedBy: "staff",
      updatedAt: "2026-04-01T10:01:00.000Z",
    }, 0)).rejects.toMatchObject({ code: "STALE_REVISION" });
  });
});
