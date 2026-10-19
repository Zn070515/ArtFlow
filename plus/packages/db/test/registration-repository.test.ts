import { randomUUID } from "node:crypto";

import { sql, type Kysely } from "kysely";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  closeDb,
  createDb,
  getRoster,
  insertMaterial,
  insertRegistration,
  listApprovedRegistrationCount,
  migrate,
  updateRegistration,
} from "../src/index.js";
import type { Database, StoredMaterial, StoredRegistration } from "../src/index.js";

const connectionString = process.env.ARTFLOW_PLUS_DATABASE_URL;
if (process.env.REQUIRE_DB === "1" && connectionString === undefined) {
  throw new Error("REQUIRE_DB=1 but ARTFLOW_PLUS_DATABASE_URL is unset.");
}
const schema = `artflow_registration_${Date.now()}_${process.pid}`;

let db: Kysely<Database>;
let admin: Client;

async function seedActivity(id = `act-${randomUUID()}`): Promise<string> {
  await db
    .insertInto("activity")
    .values({
      id,
      title: "Registration test",
      status: "active",
      revision: 1,
      enabled_capabilities: JSON.stringify(["registration", "questionnaire", "materials"]),
      active_definition_version: 1,
    })
    .execute();
  return id;
}

function registration(activityId: string, participantId: string): StoredRegistration {
  return {
    id: `reg-${activityId}-${participantId}`,
    activityId,
    participantId,
    questionnaireVersion: "v1",
    questionnaireHash: "qhash",
    status: "draft",
    answers: {},
    revision: 0,
  };
}

describe.skipIf(!connectionString)("registration persistence on PostgreSQL", () => {
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

  it("reads an absent roster as unknown rather than zero", async () => {
    const activityId = await seedActivity();
    expect(await getRoster(db, activityId)).toEqual({ status: "unknown", revision: 0 });
  });

  it("enforces one registration per participant and compare-and-swap revisions", async () => {
    const activityId = await seedActivity();
    const first = registration(activityId, "student-1");
    await insertRegistration(db, first);
    await expect(insertRegistration(db, first)).rejects.toThrow();
    const updated = await updateRegistration(db, { ...first, revision: 1, status: "submitted" }, 0);
    expect(updated).toMatchObject({ revision: 1, status: "submitted" });
    await expect(updateRegistration(db, { ...first, revision: 2 }, 0)).rejects.toMatchObject({
      code: "STALE_REVISION",
    });
  });

  it("counts only approved registrations and keeps material ownership by slot", async () => {
    const activityId = await seedActivity();
    const first = { ...registration(activityId, "student-1"), status: "approved" as const };
    const second = { ...registration(activityId, "student-2"), status: "submitted" as const };
    await insertRegistration(db, first);
    await insertRegistration(db, second);
    expect(await listApprovedRegistrationCount(db, activityId)).toBe(1);

    const material: StoredMaterial = {
      id: "mat-1",
      activityId,
      registrationId: first.id,
      questionKey: "audio",
      storageKey: "private/act-1/mat-1",
      originalName: "song.mp3",
      contentType: "audio/mpeg",
      byteLength: 100,
      ownerActorId: "student-1",
      status: "uploaded",
      reviewNote: "",
      reviewedBy: null,
      reviewedAt: null,
      revision: 0,
      current: true,
    };
    await insertMaterial(db, material);
    const row = await db.selectFrom("material").selectAll().where("id", "=", material.id).executeTakeFirstOrThrow();
    expect(row).toMatchObject({ registration_id: first.id, question_key: "audio", storage_key: material.storageKey });
    expect((await sql<{ count: string }>`select count(*)::text as count from material where registration_id = ${first.id}`.execute(db)).rows[0]?.count).toBe("1");
  });
});
