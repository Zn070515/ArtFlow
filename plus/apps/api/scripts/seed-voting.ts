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

async function seedActivity(
  activityId: string,
  publicCode: string,
  title: string,
): Promise<void> {
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
      title,
      status: "active",
      revision: 1,
      enabled_capabilities: JSON.stringify(["voting", "publishing"]),
      active_definition_version: 1,
    }).execute();
  } else {
    // Re-seeding refreshes the frozen release so a schema kept from an older
    // run cannot keep serving an outdated execution policy.
    await db.deleteFrom("definition_release").where("activity_id", "=", activityId).execute();
  }

  await insertRelease(db, {
    activityId,
    version: 1,
    contentHash: `${publicCode}-release`,
    capabilities: {
      voting: {
        ok: true,
        capabilityKey: "voting",
        contentHash: `${publicCode}-voting`,
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
        contentHash: `${publicCode}-publishing`,
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
      runtimeContractVersion: 2,
      commandScopes: {
        "voting.session.open": ["voting"],
        "voting.ballot.submit": ["voting"],
        "voting.session.close": ["voting"],
        "voting.scores.compute": ["voting"],
        "publishing.stage_result.confirm": ["publishing"],
        "publishing.stage_result.unlock": ["publishing"],
        "publishing.result.release": ["publishing"],
        "publishing.result.revoke": ["publishing"],
        "publishing.publication.edit": ["publishing"],
        "publishing.vote_result.confirm": ["publishing"],
      },
    },
    capabilityVersions: { voting: "1", publishing: "1" },
    bindings: [],
    releasedAt: "2026-10-27T09:00:00Z",
    sourceDraftRevision: 1,
  });
}

await seedActivity("act_e2e_voting", "E2E-VOTING", "E2E 投票");
await seedActivity("act_e2e_vote_page", "E2E-VOTE-PAGE", "E2E 投票页");

await closeDb(db);
console.log("Seeded voting activities act_e2e_voting and act_e2e_vote_page.");
