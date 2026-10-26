import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import {
  closeDb,
  createDb,
  insertRegistration,
  insertRelease,
  migrate,
  upsertRoster,
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

const db = createDb({
  connectionString,
  ...(schema === undefined ? {} : { schema }),
});
await migrate(db);

const stamp = Date.now();
const activityId = `act_e2e_live_${stamp}`;
const publicCode = `E2E-LIVE-${stamp}`;
const title = `E2E Live ${stamp}`;
const competition = {
  order: ["round-1"],
  nodes: [
    { key: "roster", type: "roster" },
    { key: "round-1", type: "round" },
    { key: "result", type: "output" },
  ],
  edges: [
    { from: "roster", to: "round-1" },
    { from: "round-1", to: "result" },
  ],
  rounds: [
    {
      key: "round-1",
      judgeCount: 1,
      minimumJudges: 1,
      completion: "minimum_valid",
      advanceCount: 1,
      scoringMethod: "average",
    },
  ],
  rubric: {
    criteria: [
      { key: "演唱技巧", weight: 1, maximum: 100, minimum: 0 },
      { key: "舞台表现", weight: 1, maximum: 100, minimum: 0 },
      { key: "情感表达", weight: 1, maximum: 100, minimum: 0 },
    ],
  },
  tiePolicy: "review",
};

await db.transaction().execute(async (trx) => {
  await trx.insertInto("activity").values({
    id: activityId,
    public_code: publicCode,
    title,
    status: "active",
    revision: 1,
    enabled_capabilities: JSON.stringify(["competition"]),
    active_definition_version: 1,
  }).execute();
  await insertRelease(trx, {
    activityId,
    version: 1,
    contentHash: `e2e-live-${stamp}`,
    capabilities: {
      competition: {
        ok: true,
        capabilityKey: "competition",
        contentHash: `e2e-live-${stamp}`,
        artifact: competition,
      },
    },
    executionPolicy: { declaredScopes: ["judging"], conflicts: {}, runtimeContractVersion: 1 },
    capabilityVersions: { competition: "1" },
    bindings: [],
    releasedAt: new Date().toISOString(),
    sourceDraftRevision: 1,
  });
  await insertRegistration(trx, {
    id: `live-reg-${stamp}`,
    activityId,
    participantId: "singer-a",
    questionnaireVersion: "live",
    questionnaireHash: "live",
    status: "approved",
    answers: {},
    revision: 1,
  });
  await upsertRoster(trx, activityId, {
    status: "final",
    revision: 1,
    approvedCount: 1,
    finalizedAt: new Date().toISOString(),
  }, 0);
});

const output = process.env.E2E_LIVE_OUTPUT ?? resolve(process.cwd(), "../../apps/web/.e2e-live.json");
await writeFile(output, JSON.stringify({ activityId, publicCode, title }, null, 2), "utf8");
await closeDb(db);
console.log(`Seeded Live E2E activity ${activityId} (${publicCode})`);
