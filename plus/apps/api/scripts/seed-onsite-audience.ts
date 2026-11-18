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

const db = createDb({ connectionString, ...(schema === undefined ? {} : { schema }) });
await migrate(db);

const participants = [
  ["onsite-p1", "林晓", "《后来》"],
  ["onsite-p2", "周然", "《起风了》"],
  ["onsite-p3", "陈默", "《晴天》"],
] as const;

async function clearActivity(activityId: string): Promise<void> {
  await db.deleteFrom("schedule_current").where("activity_id", "=", activityId).execute();
  await db.deleteFrom("schedule_release").where("activity_id", "=", activityId).execute();
  await db.deleteFrom("schedule_entry").where("activity_id", "=", activityId).execute();
  await db.deleteFrom("schedule_state").where("activity_id", "=", activityId).execute();
  await db.deleteFrom("result_release").where("activity_id", "=", activityId).execute();
  await db.deleteFrom("result_publication").where("activity_id", "=", activityId).execute();
  await db.deleteFrom("stage_result").where("activity_id", "=", activityId).execute();
  await db.deleteFrom("ballot").where("activity_id", "=", activityId).execute();
  await db.deleteFrom("vote_option").where("activity_id", "=", activityId).execute();
  await db.deleteFrom("vote_session").where("activity_id", "=", activityId).execute();
  await db.deleteFrom("activity_feedback").where("activity_id", "=", activityId).execute();
  await db.deleteFrom("registration").where("activity_id", "=", activityId).execute();
}

async function seedActivity(
  activityId: string,
  publicCode: string,
  title: string,
  status: "active" | "closed",
  voteStatus: "open" | null,
): Promise<void> {
  await clearActivity(activityId);
  if ((await getActivity(db, activityId)) === null) {
    await db.insertInto("activity").values({
      id: activityId,
      public_code: publicCode,
      title,
      status,
      revision: 1,
      enabled_capabilities: JSON.stringify(["voting", "publishing"]),
      active_definition_version: 1,
    }).execute();
  } else {
    await db.updateTable("activity").set({ title, status }).where("id", "=", activityId).execute();
  }

  for (const [participantId, name] of participants) {
    await db.insertInto("registration").values({
      id: `${activityId}-reg-${participantId}`,
      activity_id: activityId,
      participant_id: participantId,
      questionnaire_version: "onsite-v1",
      questionnaire_hash: "onsite-seed",
      status: "approved",
      answers: JSON.stringify({ name }),
      revision: 1,
      reviewed_by: null,
    }).execute();
  }

  await db.insertInto("schedule_entry").values(
    participants.map(([participantId, name], index) => ({
      id: `${activityId}-e${index + 1}`,
      activity_id: activityId,
      mode: "formal",
      position: index,
      slot_key: `slot-${index + 1}`,
      participant_id: participantId,
      title: name,
      note: "",
      revision: 1,
    })),
  ).execute();
  await db.insertInto("schedule_release").values({
    id: `${activityId}-schedule`,
    activity_id: activityId,
    mode: "formal",
    version: 1,
    snapshot: JSON.stringify({
      version: 1,
      schemaVersion: 1,
      entries: participants.map(([participantId, name, song], index) => ({
        entryId: `${activityId}-e${index + 1}`,
        order: index + 1,
        slotKey: `slot-${index + 1}`,
        slotLabel: song,
        participantId,
        title: name,
        note: "",
        startsAt: null,
      })),
      releasedAt: "2026-11-18T10:00:00.000Z",
    }),
    note: "onsite seed",
    released_at: "2026-11-18T10:00:00.000Z",
    revoked_at: null,
  }).execute();
  await db.insertInto("schedule_current").values({
    activity_id: activityId,
    mode: "formal",
    entry_id: `${activityId}-e2`,
  }).execute();

  const announcement = status === "closed" ? "赛果已公布。" : "第 8 位选手请到后台候场";
  await db.insertInto("activity_public_profile").values({
    activity_id: activityId,
    tagline: status === "closed" ? "已结束" : "正在演出",
    description: `${title} 公开活动介绍。`,
    venue: "大学生活动中心剧场",
    starts_at: new Date("2026-11-18T10:00:00.000Z"),
    ends_at: new Date("2026-11-18T13:00:00.000Z"),
    organizer: "校学生会文艺部",
    contact: "学生会办公室",
    announcement,
    announcements: JSON.stringify([{
      id: "onsite-a1",
      title: "开场提醒",
      body: "请提前 30 分钟入场。",
      publishedAt: "2026-11-18T09:00:00.000Z",
    }]),
    faq: JSON.stringify([{
      question: "在哪里入场？",
      answer: "大学生活动中心东门。",
    }]),
    links: JSON.stringify([{
      label: "节目册",
      url: "https://example.com/program",
    }]),
    participants_visible: true,
    listed_publicly: true,
    revision: 1,
    updated_by: "seed",
    updated_at: new Date("2026-11-18T09:30:00.000Z"),
  }).onConflict((conflict) => conflict.column("activity_id").doUpdateSet({
    tagline: status === "closed" ? "已结束" : "正在演出",
    description: `${title} 公开活动介绍。`,
    venue: "大学生活动中心剧场",
    starts_at: new Date("2026-11-18T10:00:00.000Z"),
    ends_at: new Date("2026-11-18T13:00:00.000Z"),
    organizer: "校学生会文艺部",
    contact: "学生会办公室",
    announcement,
    announcements: JSON.stringify([{
      id: "onsite-a1",
      title: "开场提醒",
      body: "请提前 30 分钟入场。",
      publishedAt: "2026-11-18T09:00:00.000Z",
    }]),
    faq: JSON.stringify([{
      question: "在哪里入场？",
      answer: "大学生活动中心东门。",
    }]),
    links: JSON.stringify([{
      label: "节目册",
      url: "https://example.com/program",
    }]),
    participants_visible: true,
    listed_publicly: true,
    updated_by: "seed",
    updated_at: new Date("2026-11-18T09:30:00.000Z"),
  })).execute();

  if (voteStatus !== null) {
    const sessionId = `${activityId}-vote`;
    await db.insertInto("vote_session").values({
      id: sessionId,
      activity_id: activityId,
      definition_version: 1,
      mode: "formal",
      purpose: "popularity",
      selection_type: "single",
      max_selections: 1,
      identity_policy: "anonymous",
      scoring_rule: JSON.stringify({ kind: "ballot_share_percent", scale: 100, decimals: 2 }),
      status: voteStatus,
      revision: 0,
      opened_at: "2026-11-18T10:05:00.000Z",
      closed_at: null,
    }).execute();
    await db.insertInto("vote_option").values(
      participants.map(([participantId], index) => ({
        id: `${sessionId}-option-${index}`,
        activity_id: activityId,
        session_id: sessionId,
        candidate_id: participantId,
        ordinal: index,
      })),
    ).execute();
  }

  if (status === "closed") {
    const scores = ["98.30", "97.80", "96.40"] as const;
    const decisions = participants.map(([participantId], index) => ({
      rank: index + 1,
      contestantId: participantId,
      score: scores[index] ?? "0",
    }));
    const awards = [{ award: "冠军", contestantId: "onsite-p1" }];
    await db.transaction().execute(async (trx) => {
      await insertStageResult(trx, {
        id: `${activityId}-stage`,
        activityId,
        stageKey: "final",
        status: "confirmed",
        candidateRevision: 1,
        sourceCandidateRevision: 1,
        inputFingerprint: "onsite-seed",
        source: {
          kind: "podium_candidate",
          aggregateId: `${activityId}-stage`,
          definitionVersion: 1,
          releaseHash: "onsite-seed",
          mode: "formal",
          sourceRevision: 1,
          inputFingerprint: "onsite-seed",
        },
        decisions,
        awards,
        note: "",
        revision: 1,
        confirmedAt: "2026-11-18T12:00:00.000Z",
        staleReason: "",
      });
      await insertResultPublication(trx, {
        id: `${activityId}-publication`,
        activityId,
        stageKey: "final",
        title: "正式赛果",
        content: "",
        version: 1,
        revision: 0,
      });
      await insertResultRelease(trx, {
        id: `${activityId}-release`,
        activityId,
        publicationId: `${activityId}-publication`,
        stageResultId: `${activityId}-stage`,
        stageKey: "final",
        status: "active",
        snapshot: {
          activityTitle: title,
          publicTitle: `${title} · 正式赛果`,
          stageKey: "final",
          decisions,
          awards,
        },
        snapshotCandidateRevision: 1,
        resultVersion: 1,
        postVersion: 1,
        inputFingerprint: "onsite-seed",
        note: "e2e seed",
        releasedAt: "2026-11-18T12:10:00.000Z",
        revision: 0,
      });
    });
  }
}

await seedActivity("act_e2e_onsite", "E2E-ONSITE", "E2E 现场十佳", "active", "open");
await seedActivity("act_e2e_onsite_closed", "E2E-ONSITE-CLOSED", "E2E 现场十佳（已结束）", "closed", null);

await closeDb(db);
console.log("Seeded on-site audience activities act_e2e_onsite and act_e2e_onsite_closed.");
