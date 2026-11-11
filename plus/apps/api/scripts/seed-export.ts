import { closeDb, createDb, getActivity, insertMaterial, insertRegistration, migrate } from "@artflow-plus/db";
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

const activityId = "act-e2e-export";
await db.transaction().execute(async (trx) => {
  await trx.deleteFrom("material").where("activity_id", "=", activityId).execute();
  await trx.deleteFrom("registration").where("activity_id", "=", activityId).execute();
  await trx.deleteFrom("roster").where("activity_id", "=", activityId).execute();
});
if ((await getActivity(db, activityId)) === null) {
  await db.insertInto("activity").values({
    id: activityId,
    public_code: "E2E-EXPORT",
    title: "2026 院十佳导出",
    status: "active",
    revision: 1,
    enabled_capabilities: JSON.stringify(["registration", "questionnaire", "materials", "competition", "voting"]),
    active_definition_version: 1,
  }).execute();
}
await insertRegistration(db, {
  id: "e2e-export-reg",
  activityId,
  participantId: "participant-export",
  questionnaireVersion: "e2e-v1",
  questionnaireHash: "e2e-export-hash",
  status: "approved",
  answers: { name: "李明", student_id: "20260001", song: "夜空中最亮的星" },
  revision: 2,
  reviewNote: "通过",
});
await insertMaterial(db, {
  id: "e2e-export-material",
  activityId,
  registrationId: "e2e-export-reg",
  questionKey: "audio",
  storageKey: "private/e2e-do-not-export",
  originalName: "demo.mp3",
  contentType: "audio/mpeg",
  byteLength: 16,
  ownerActorId: "participant-export",
  status: "uploaded",
  reviewNote: "",
  reviewedBy: null,
  reviewedAt: null,
  revision: 0,
  current: true,
});

await closeDb(db);
console.log("Seeded staff export E2E activity");
