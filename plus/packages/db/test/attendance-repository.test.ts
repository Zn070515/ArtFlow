import { randomUUID } from "node:crypto";

import { type Kysely } from "kysely";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  closeDb,
  createDb,
  getAttendanceCurrentForUpdate,
  hasAttendanceCurrentForPointType,
  insertAttendanceFact,
  insertAttendancePoint,
  insertAttendanceStaff,
  listAttendanceCurrent,
  listAttendancePoints,
  listAttendanceStaff,
  listTicketsForAttendance,
  migrate,
  upsertAttendanceCurrent,
} from "../src/index.js";
import type { Database } from "../src/index.js";

const connectionString = process.env.ARTFLOW_PLUS_DATABASE_URL;
if (process.env.REQUIRE_DB === "1" && connectionString === undefined) {
  throw new Error("REQUIRE_DB=1 but ARTFLOW_PLUS_DATABASE_URL is unset.");
}
const schema = `artflow_attendance_db_${Date.now()}_${process.pid}`;

let db: Kysely<Database>;
let admin: Client;

async function seedActivity(): Promise<string> {
  const id = `attendance-${randomUUID()}`;
  await db.insertInto("activity").values({
    id,
    title: "Attendance DB",
    status: "active",
    revision: 1,
    enabled_capabilities: JSON.stringify(["attendance"]),
    active_definition_version: 1,
  }).execute();
  return id;
}

describe.skipIf(!connectionString)("attendance repository on PostgreSQL", () => {
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

  it("stores points, staff, facts and one current row per subject", async () => {
    const activityId = await seedActivity();
    const now = "2026-11-10T10:00:00.000Z";
    await db.transaction().execute(async (trx) => {
      await insertAttendancePoint(trx, {
        id: "point-1", activityId, key: "gate", name: "入口",
        subjectTypes: ["participant", "ticket"], active: true, revision: 0,
        createdBy: "staff-1", createdAt: now, updatedAt: now,
      });
      await insertAttendanceStaff(trx, {
        id: "staff-entry", activityId, displayName: "志愿者甲", actorId: null,
        active: true, revision: 0, createdBy: "staff-1", createdAt: now, updatedAt: now,
      });
      await insertAttendanceFact(trx, {
        id: "fact-1", activityId, mode: "formal", pointKey: "gate",
        subjectType: "participant", subjectId: "registration-1",
        action: "checkin", note: null, actorId: "staff-1",
        commandId: "cmd-1", occurredAt: now,
      });
      await upsertAttendanceCurrent(trx, {
        activityId, mode: "formal", pointKey: "gate",
        subjectType: "participant", subjectId: "registration-1",
        status: "present", note: null, revision: 1, updatedAt: now,
      });
    });

    const points = await listAttendancePoints(db, activityId);
    expect(points.map((point) => point.key)).toEqual(["gate"]);
    expect(points[0]?.subjectTypes).toEqual(["participant", "ticket"]);
    const staff = await listAttendanceStaff(db, activityId);
    expect(staff.map((entry) => entry.displayName)).toEqual(["志愿者甲"]);
    const current = await listAttendanceCurrent(db, activityId, "formal");
    expect(current).toHaveLength(1);
    expect(current[0]?.status).toBe("present");
    expect(await hasAttendanceCurrentForPointType(db, activityId, "gate", "participant")).toBe(true);
    expect(await hasAttendanceCurrentForPointType(db, activityId, "gate", "staff")).toBe(false);

    await expect(
      db.insertInto("attendance_current").values({
        activity_id: activityId, mode: "formal", point_key: "gate",
        subject_type: "participant", subject_id: "registration-1",
        status: "present", note: null, revision: 2, updated_at: now,
      }).execute(),
    ).rejects.toMatchObject({ code: "23505" });

    await db.transaction().execute(async (trx) => {
      const row = await getAttendanceCurrentForUpdate(trx, {
        activityId, mode: "formal", pointKey: "gate",
        subjectType: "participant", subjectId: "registration-1",
      });
      expect(row?.revision).toBe(1);
    });
  });

  it("lists ticket summaries without credential digests", async () => {
    const activityId = await seedActivity();
    await db.insertInto("ticket").values({
      id: "ticket-1", activity_id: activityId, public_code: "ABC123",
      credential_digest: "digest", credential_version: 1, state: "issued",
      issued_at: "2026-11-10T10:00:00.000Z", redeemed_at: null, revoked_at: null,
    }).execute();
    const tickets = await listTicketsForAttendance(db, activityId);
    expect(tickets).toEqual([{ id: "ticket-1", publicCode: "ABC123", state: "issued" }]);
    expect(JSON.stringify(tickets)).not.toContain("digest");
  });
});
