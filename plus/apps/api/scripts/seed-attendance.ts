import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";

import { closeDb, createDb, getActivity, insertRelease, migrate } from "@artflow-plus/db";
import {
  compileAttendanceDefinition,
  createEmptyAttendanceDefinition,
} from "@artflow-plus/domain";
import {
  addAttendanceStaff,
  createAttendancePoint,
  issueTicket,
} from "@artflow-plus/runtime";
import type { RuntimeDeps } from "@artflow-plus/runtime";
import { Client } from "pg";

const connectionString = process.env.ARTFLOW_PLUS_DATABASE_URL;
if (connectionString === undefined || connectionString.trim() === "") {
  throw new Error("ARTFLOW_PLUS_DATABASE_URL is required.");
}
const schema = process.env.ARTFLOW_PLUS_DB_SCHEMA;
if (schema !== undefined && !/^[a-z_][a-z0-9_]*$/.test(schema)) {
  throw new Error(`Unsafe ARTFLOW_PLUS_DB_SCHEMA: ${schema}`);
}

if (schema !== undefined) {
  const admin = new Client({ connectionString });
  await admin.connect();
  await admin.query(`CREATE SCHEMA IF NOT EXISTS "${schema}"`);
  await admin.end();
}

const db = createDb({
  connectionString,
  ...(schema === undefined ? {} : { schema }),
});
await migrate(db);

const activityId = "act_e2e_attendance";
const registrationId = "e2e-attendance-registration";
const artifact = compileAttendanceDefinition(createEmptyAttendanceDefinition());
if (!artifact.ok) throw new Error(JSON.stringify(artifact));

const actor = {
  actorId: "e2e-ops",
  actorType: "user" as const,
  roles: ["admin"],
  permissions: ["attendance.manage", "ticket.manage", "studio.manage"],
};
const deps: RuntimeDeps = {
  actor,
  now: () => new Date().toISOString(),
  newEventId: () => `e2e-attendance-${randomUUID()}`,
  credentialSecret: "artflow-plus-development-secret",
};

const existing = await getActivity(db, activityId);
if (existing === null) {
  await db.transaction().execute(async (trx) => {
    await trx.insertInto("activity").values({
      id: activityId,
      public_code: "E2E-ATT",
      title: "2026 现场签到验证",
      status: "active",
      revision: 1,
      enabled_capabilities: JSON.stringify(["attendance", "registration", "ticketing"]),
      active_definition_version: 1,
    }).execute();
    await insertRelease(trx, {
      activityId,
      version: 1,
      contentHash: "e2e-attendance-release",
      capabilities: { attendance: artifact },
      executionPolicy: {
        declaredScopes: ["checkin"],
        conflicts: {},
        runtimeContractVersion: 2,
        commandScopes: {
          "attendance.checkin": ["checkin"],
          "attendance.undo": ["checkin"],
        },
      },
      capabilityVersions: { attendance: "1" },
      bindings: [],
      releasedAt: "2026-11-10T09:00:00Z",
      sourceDraftRevision: 1,
    });
  });
}

await db.transaction().execute(async (trx) => {
  await trx.deleteFrom("attendance_current").where("activity_id", "=", activityId).execute();
  await trx.deleteFrom("attendance_fact").where("activity_id", "=", activityId).execute();
  await trx.deleteFrom("attendance_point").where("activity_id", "=", activityId).execute();
  await trx.deleteFrom("attendance_staff").where("activity_id", "=", activityId).execute();
  await trx.deleteFrom("ticket_access_session").where("activity_id", "=", activityId).execute();
  await trx.deleteFrom("ticket").where("activity_id", "=", activityId).execute();
  await trx.deleteFrom("registration").where("activity_id", "=", activityId).execute();
  await trx.insertInto("registration").values({
    id: registrationId,
    activity_id: activityId,
    participant_id: "e2e-attendance-participant",
    questionnaire_version: "v1",
    questionnaire_hash: "e2e-attendance-hash",
    status: "approved",
    answers: JSON.stringify({ name: "选手甲" }),
    supplement_keys: JSON.stringify([]),
    revision: 0,
    review_note: "",
    reviewed_by: null,
  }).execute();
});

await createAttendancePoint(db, deps, {
  commandId: `e2e-point-${randomUUID()}`,
  activityId,
  actor,
  key: "gate",
  name: "入口",
  subjectTypes: ["participant", "ticket", "staff"],
});
await addAttendanceStaff(db, deps, {
  commandId: `e2e-staff-${randomUUID()}`,
  activityId,
  actor,
  displayName: "志愿者甲",
});
const issued = await issueTicket(db, deps, {
  commandId: `e2e-ticket-${randomUUID()}`,
  activityId,
});
if (issued.body.credential === undefined) throw new Error("ticket credential missing");

const output = new URL("../../web/.e2e-attendance.json", import.meta.url);
await writeFile(output, JSON.stringify({
  activityId,
  registrationId,
  pointKey: "gate",
  ticketCredential: issued.body.credential,
  ticketPublicCode: issued.body.ticket.publicCode,
}, null, 2), "utf8");

await closeDb(db);
