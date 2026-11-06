import {
  closeDb,
  createDb,
  getActivity,
  insertRelease,
  migrate,
} from "@artflow-plus/db";
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

const db = createDb({ connectionString, ...(schema === undefined ? {} : { schema }) });
await migrate(db);

const activityId = "act_e2e_grouping";
const publicCode = "E2E-GROUPING";

// Reset only the data this seed owns; the activity and its release are reused.
await db.deleteFrom("grouping_stage").where("activity_id", "=", activityId).execute();
await db.deleteFrom("registration").where("activity_id", "=", activityId).execute();
await db.deleteFrom("roster").where("activity_id", "=", activityId).execute();

if ((await getActivity(db, activityId)) === null) {
  await db.insertInto("activity").values({
    id: activityId,
    public_code: publicCode,
    title: "E2E 分组",
    status: "active",
    revision: 1,
    enabled_capabilities: JSON.stringify(["registration", "grouping"]),
    active_definition_version: 1,
  }).execute();

  await insertRelease(db, {
    activityId,
    version: 1,
    contentHash: "e2e-grouping-release",
    capabilities: {
      grouping: {
        ok: true,
        capabilityKey: "grouping",
        contentHash: "e2e-grouping",
        artifact: { schemaVersion: 1, groupCount: 2 },
      },
    },
    executionPolicy: { declaredScopes: [], conflicts: {}, runtimeContractVersion: 2, commandScopes: {} },
    capabilityVersions: { grouping: "1" },
    bindings: [],
    releasedAt: "2026-10-27T09:00:00Z",
    sourceDraftRevision: 1,
  });
}

await db.insertInto("roster").values({
  activity_id: activityId,
  status: "final",
  approved_count: 4,
  revision: 1,
  finalized_at: "2026-10-27T09:30:00Z",
  updated_at: new Date(),
}).execute();

for (const [index, participantId] of ["p1", "p2", "p3", "p4"].entries()) {
  await db.insertInto("registration").values({
    id: `registration-${activityId}-${participantId}`,
    activity_id: activityId,
    participant_id: participantId,
    questionnaire_version: "v1",
    questionnaire_hash: "hash",
    status: "approved",
    answers: JSON.stringify({ name: `选手${index + 1}` }),
    revision: 1,
    review_note: "",
    reviewed_by: "staff",
    created_at: new Date(),
    updated_at: new Date(),
  }).execute();
}

await closeDb(db);
console.log(`Seeded grouping activity ${activityId} (${publicCode}).`);
