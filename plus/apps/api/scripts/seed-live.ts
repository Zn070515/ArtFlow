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
const modeActivityId = `act_e2e_mode_${stamp}`;
const modePublicCode = `E2E-MODE-${stamp}`;
const modeTitle = `E2E Mode ${stamp}`;
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

async function seedLiveActivity(id: string, code: string, label: string): Promise<void> {
  await db.transaction().execute(async (trx) => {
    await trx.insertInto("activity").values({
      id,
      public_code: code,
      title: label,
      status: "active",
      revision: 1,
      enabled_capabilities: JSON.stringify(["competition", "ticketing"]),
      active_definition_version: 1,
    }).execute();
    await insertRelease(trx, {
      activityId: id,
      version: 1,
      contentHash: `e2e-live-${code}`,
      capabilities: {
        competition: {
          ok: true,
          capabilityKey: "competition",
          contentHash: `e2e-live-${code}`,
          artifact: competition,
        },
        ticketing: {
          ok: true,
          capabilityKey: "ticketing",
          contentHash: `e2e-live-ticketing-${code}`,
          artifact: { schemaVersion: 1 },
        },
      },
      executionPolicy: {
        declaredScopes: ["judging"],
        conflicts: {},
        runtimeContractVersion: 1,
        commandScopes: Object.fromEntries(
          [
            "competition.configure",
            "competition.round.prepare",
            "competition.panel.activate",
            "competition.performance.open",
            "competition.performance.advance",
            "competition.performance.lock",
            "competition.round.lock",
            "competition.score.direct_judge",
            "competition.score.staff_rapid",
            "competition.score.staff_proxy",
            "competition.score.paper_dr",
            "competition.score.edit",
            "competition.score.correction.open",
            "competition.score.correction.close",
            "competition.score.correction.recalculate",
            "competition.ranking.resolve",
            "competition.advancement.finalize",
            "competition.tie.decide",
            "competition.podium.recompute",
            "competition.rehearsal.reset",
          ].map((command) => [command, ["judging"]]),
        ),
      },
      capabilityVersions: { competition: "1", ticketing: "1" },
      bindings: [],
      releasedAt: new Date().toISOString(),
      sourceDraftRevision: 1,
    });
    await insertRegistration(trx, {
      id: `live-reg-${code}`,
      activityId: id,
      participantId: "singer-a",
      questionnaireVersion: "live",
      questionnaireHash: "live",
      status: "approved",
      answers: {},
      revision: 1,
    });
    await upsertRoster(trx, id, {
      status: "final",
      revision: 1,
      approvedCount: 1,
      finalizedAt: new Date().toISOString(),
    }, 0);
  });
}

await seedLiveActivity(activityId, publicCode, title);
await seedLiveActivity(modeActivityId, modePublicCode, modeTitle);

const output = process.env.E2E_LIVE_OUTPUT ?? resolve(process.cwd(), "../../apps/web/.e2e-live.json");
await writeFile(output, JSON.stringify({
  activityId,
  publicCode,
  title,
  modeActivityId,
  modePublicCode,
  modeTitle,
}, null, 2), "utf8");
await closeDb(db);
console.log(`Seeded Live E2E activities ${activityId} and ${modeActivityId}`);
