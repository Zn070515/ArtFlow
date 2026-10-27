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

const activityId = "act_e2e_voting";
const publicCode = "E2E-VOTING";

// Reset only what this seed owns; the activity and its release are reused.
await db.deleteFrom("result_release").where("activity_id", "=", activityId).execute();
await db.deleteFrom("result_publication").where("activity_id", "=", activityId).execute();
await db.deleteFrom("stage_result").where("activity_id", "=", activityId).execute();
await db.deleteFrom("live_state").where("activity_id", "=", activityId).execute();
// A stale dead letter blocks the (activity, mode) projection partition forever.
await db.deleteFrom("outbox").where("activity_id", "=", activityId).execute();
await db.deleteFrom("execution_projection").where("activity_id", "=", activityId).execute();
await db.deleteFrom("vote_record").where("activity_id", "=", activityId).execute();
await db.deleteFrom("ballot").where("activity_id", "=", activityId).execute();
await db.deleteFrom("vote_option").where("activity_id", "=", activityId).execute();
await db.deleteFrom("vote_session").where("activity_id", "=", activityId).execute();
await db.deleteFrom("execution_session").where("activity_id", "=", activityId).execute();

if ((await getActivity(db, activityId)) === null) {
  await db.insertInto("activity").values({
    id: activityId,
    public_code: publicCode,
    title: "E2E 投票",
    status: "active",
    revision: 1,
    enabled_capabilities: JSON.stringify(["voting", "publishing"]),
    active_definition_version: 1,
  }).execute();

  await insertRelease(db, {
    activityId,
    version: 1,
    contentHash: "e2e-voting-release",
    capabilities: {
      voting: {
        ok: true,
        capabilityKey: "voting",
        contentHash: "e2e-voting",
        artifact: {
          version: 2,
          schemaVersion: 2,
          purpose: "popularity",
          selectionType: "single",
          maxSelections: 1,
          identityPolicy: "browser",
          scoringRule: { kind: "ballot_share_percent", scale: 100, decimals: 2 },
        },
      },
      publishing: {
        ok: true,
        capabilityKey: "publishing",
        contentHash: "e2e-voting-publishing",
        artifact: {
          version: 1,
          schemaVersion: 1,
          stages: [{ key: "vote_result", label: "投票结果" }],
        },
      },
    },
    executionPolicy: {
      declaredScopes: ["voting", "publishing"],
      conflicts: {},
      runtimeContractVersion: 1,
    },
    capabilityVersions: { voting: "1", publishing: "1" },
    bindings: [],
    releasedAt: "2026-10-27T09:00:00Z",
    sourceDraftRevision: 1,
  });
}

await closeDb(db);
console.log(`Seeded voting activity ${activityId} (${publicCode}).`);
