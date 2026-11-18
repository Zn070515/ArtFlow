import { randomUUID } from "node:crypto";

import { closeDb, createDb, insertRelease, migrate } from "@artflow-plus/db";
import {
  compileResourcesDefinition,
  createResourcesDefinition,
} from "@artflow-plus/domain";

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

const activityId = "act-e2e-resources";
await db.deleteFrom("definition_release").where("activity_id", "=", activityId).execute();
await db.deleteFrom("activity").where("id", "=", activityId).execute();

const artifact = compileResourcesDefinition(createResourcesDefinition([
  { key: "hall", name: "主礼堂", kind: "venue", capacity: 800, notes: "" },
  { key: "piano", name: "三角钢琴", kind: "equipment", notes: "需调音" },
]));
if (!artifact.ok) throw new Error(JSON.stringify(artifact));

await db.transaction().execute(async (trx) => {
  await trx.insertInto("activity").values({
    id: activityId,
    public_code: "E2E-RESOURCES",
    title: "E2E 资源与排练",
    status: "active",
    revision: 1,
    enabled_capabilities: JSON.stringify(["resources"]),
    active_definition_version: 1,
  }).execute();
  await insertRelease(trx, {
    activityId,
    version: 1,
    contentHash: `resources-e2e-${randomUUID()}`,
    capabilities: { resources: artifact },
    executionPolicy: {
      declaredScopes: [],
      conflicts: {},
      runtimeContractVersion: 2,
      commandScopes: {},
    },
    capabilityVersions: { resources: "1.0.0" },
    bindings: [],
    releasedAt: new Date().toISOString(),
    sourceDraftRevision: 1,
  });
});

await closeDb(db);
console.log(`Seeded ${activityId}.`);
