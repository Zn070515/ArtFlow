import {
  closeDb,
  createDb,
  getActivity,
  insertResultPublication,
  insertResultRelease,
  insertStageResult,
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

const db = createDb({
  connectionString,
  ...(schema === undefined ? {} : { schema }),
});
await migrate(db);

const activityId = "act-e2e-demo";
const existing = await getActivity(db, activityId);
if (existing === null) {
  const decisions = [
    { rank: 1, contestantId: "singer-a", score: "98.30" },
    { rank: 2, contestantId: "singer-b", score: "97.80" },
    { rank: 3, contestantId: "singer-c", score: "96.40" },
  ];
  const awards = [
    { award: "冠军", contestantId: "singer-a" },
    { award: "最佳人气", contestantId: "singer-b" },
  ];
  const snapshot = {
    activityTitle: "2026 院十佳",
    publicTitle: "2026 院十佳 · 正式赛果",
    stageKey: "final_podium",
    decisions,
    awards,
  };
  await db.transaction().execute(async (trx) => {
    await trx.insertInto("activity").values({
      id: activityId,
      public_code: "E2E-DEMO",
      title: "2026 院十佳",
      status: "closed",
      revision: 1,
      enabled_capabilities: JSON.stringify(["publishing"]),
      active_definition_version: 1,
    }).execute();
    await insertStageResult(trx, {
      id: "stage-e2e",
      activityId,
      stageKey: "final_podium",
      status: "confirmed",
      candidateRevision: 3,
      sourceCandidateRevision: 3,
      inputFingerprint: "fingerprint-not-public",
      source: {
        kind: "podium_candidate",
        aggregateId: "stage-e2e",
        definitionVersion: 1,
        releaseHash: "seed-public-result",
        mode: "formal",
        sourceRevision: 3,
        inputFingerprint: "fingerprint-not-public",
      },
      decisions,
      awards,
      note: "",
      revision: 1,
      confirmedAt: "2026-10-20T17:00:00.000Z",
      staleReason: "",
    });
    await insertResultPublication(trx, {
      id: "publication-e2e",
      activityId,
      stageKey: "final_podium",
      title: "正式赛果",
      content: "",
      version: 1,
      revision: 0,
    });
    await insertResultRelease(trx, {
      id: "release-e2e",
      activityId,
      publicationId: "publication-e2e",
      stageResultId: "stage-e2e",
      stageKey: "final_podium",
      status: "active",
      snapshot,
      snapshotCandidateRevision: 3,
      resultVersion: 3,
      postVersion: 1,
      inputFingerprint: "fingerprint-not-public",
      note: "e2e seed",
      releasedAt: "2026-10-20T18:00:00.000Z",
      revision: 0,
    });
  });
} else {
  // Older E2E schemas predate result provenance; refresh the seeded result so
  // the fail-closed public selector keeps working across repeated runs.
  await db.updateTable("stage_result").set({
    source: JSON.stringify({
      kind: "podium_candidate",
      aggregateId: "stage-e2e",
      definitionVersion: 1,
      releaseHash: "seed-public-result",
      mode: "formal",
      sourceRevision: 3,
      inputFingerprint: "fingerprint-not-public",
      dependencyIds: [],
    }),
    stale_at: null,
    stale_reason: "",
  }).where("activity_id", "=", activityId).execute();
}

// The public result snapshot stores contestant ids; the read model resolves
// names from these registrations. Keeping names in the seed also proves the
// public page never has to fall back to an internal id.
for (const [participantId, name] of [["singer-a", "林晓"], ["singer-b", "周然"], ["singer-c", "陈默"]] as const) {
  const existingRegistration = await db
    .selectFrom("registration")
    .select("id")
    .where("activity_id", "=", activityId)
    .where("participant_id", "=", participantId)
    .executeTakeFirst();
  if (existingRegistration === undefined) {
    await db.insertInto("registration").values({
      id: `seed-public-${participantId}`,
      activity_id: activityId,
      participant_id: participantId,
      questionnaire_version: "seed-v1",
      questionnaire_hash: "seed-public",
      status: "approved",
      answers: JSON.stringify({ name }),
      revision: 1,
      reviewed_by: null,
    }).execute();
  }
}

await db.insertInto("activity_public_profile").values({
  activity_id: activityId,
  tagline: "春日声场",
  description: "2026 院十佳公开活动介绍。",
  venue: "大学生活动中心剧场",
  starts_at: new Date("2026-04-18T11:00:00.000Z"),
  ends_at: new Date("2026-04-18T13:30:00.000Z"),
  organizer: "校学生会文艺部",
  contact: "学生会办公室",
  announcement: "初赛抽签结果已公布，请选手确认曲目。",
  announcements: JSON.stringify([]),
  faq: JSON.stringify([]),
  links: JSON.stringify([]),
  participants_visible: false,
  listed_publicly: true,
  revision: 1,
  updated_by: "seed",
  updated_at: new Date("2026-04-01T10:00:00.000Z"),
}).onConflict((conflict) => conflict.column("activity_id").doUpdateSet({
  tagline: "春日声场",
  description: "2026 院十佳公开活动介绍。",
  venue: "大学生活动中心剧场",
  starts_at: new Date("2026-04-18T11:00:00.000Z"),
  ends_at: new Date("2026-04-18T13:30:00.000Z"),
  organizer: "校学生会文艺部",
  contact: "学生会办公室",
  announcement: "初赛抽签结果已公布，请选手确认曲目。",
  announcements: JSON.stringify([]),
  faq: JSON.stringify([]),
  links: JSON.stringify([]),
  participants_visible: false,
  listed_publicly: true,
  updated_by: "seed",
  updated_at: new Date("2026-04-01T10:00:00.000Z"),
})).execute();

await closeDb(db);
console.log("Seeded public results for E2E-DEMO");
