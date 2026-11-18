import { randomUUID } from "node:crypto";

import { closeDb, createDb, insertRelease, migrate } from "@artflow-plus/db";
import { compileTeamsDefinition, createTeamsDefinition } from "@artflow-plus/domain";

const connectionString = process.env.ARTFLOW_PLUS_DATABASE_URL;
if (connectionString === undefined || connectionString.trim() === "") {
  throw new Error("ARTFLOW_PLUS_DATABASE_URL is required.");
}
const schema = process.env.ARTFLOW_PLUS_DB_SCHEMA;
const db = createDb({
  connectionString,
  ...(schema === undefined || schema === "" ? {} : { schema }),
});
await migrate(db);

const activityId = "act-e2e-teams";
await db.deleteFrom("definition_release").where("activity_id", "=", activityId).execute();
await db.deleteFrom("activity").where("id", "=", activityId).execute();

const artifact = compileTeamsDefinition(createTeamsDefinition({
  minSize: 1,
  maxSize: 3,
  requireCaptain: false,
  source: "manual",
}));
if (!artifact.ok) throw new Error(JSON.stringify(artifact));

await db.transaction().execute(async (trx) => {
  await trx.insertInto("activity").values({
    id: activityId,
    public_code: "E2E-TEAMS",
    title: "E2E 队伍名册",
    status: "active",
    revision: 1,
    enabled_capabilities: JSON.stringify(["registration", "teams"]),
    active_definition_version: 1,
  }).execute();
  for (const [index, name] of ["选手甲", "选手乙", "选手丙"].entries()) {
    await trx.insertInto("registration").values({
      id: `e2e-teams-registration-${index + 1}`,
      activity_id: activityId,
      participant_id: `e2e-teams-p${index + 1}`,
      questionnaire_version: "v1",
      questionnaire_hash: "e2e-teams-hash",
      status: "approved",
      answers: JSON.stringify({ name }),
      revision: 1,
      review_note: "",
      reviewed_by: "e2e-ops",
      created_at: new Date(),
      updated_at: new Date(),
    }).execute();
  }
  await insertRelease(trx, {
    activityId,
    version: 1,
    contentHash: `teams-e2e-${randomUUID()}`,
    capabilities: { teams: artifact },
    executionPolicy: {
      declaredScopes: [],
      conflicts: {},
      runtimeContractVersion: 2,
      commandScopes: {},
    },
    capabilityVersions: { teams: "1.0.0" },
    bindings: [],
    releasedAt: new Date().toISOString(),
    sourceDraftRevision: 1,
  });
});

await closeDb(db);
console.log(`Seeded ${activityId}.`);
