import { closeDb, createDb, getActivity, insertRegistration, migrate } from "@artflow-plus/db";
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

const publishedId = "act-e2e-show";
const draftId = "act-e2e-show-draft";

async function ensureActivity(
  id: string,
  publicCode: string,
  title: string,
): Promise<void> {
  if ((await getActivity(db, id)) !== null) return;
  await db.insertInto("activity").values({
    id,
    public_code: publicCode,
    title,
    status: "active",
    revision: 1,
    enabled_capabilities: JSON.stringify(["registration", "questionnaire", "materials", "archive"]),
    active_definition_version: 1,
  }).execute();
}

await ensureActivity(publishedId, "E2E-SHOW", "2026 毕业晚会");
await ensureActivity(draftId, "E2E-SHOW-DRAFT", "未发布晚会");
await db.transaction().execute(async (trx) => {
  await trx.deleteFrom("registration").where("activity_id", "in", [publishedId, draftId]).execute();
  await trx.deleteFrom("roster").where("activity_id", "in", [publishedId, draftId]).execute();
});
await db.insertInto("roster").values({
  activity_id: publishedId,
  status: "final",
  approved_count: 2,
  revision: 1,
  finalized_at: new Date("2026-11-11T18:00:00Z"),
  updated_at: new Date("2026-11-11T18:00:00Z"),
}).execute();
await insertRegistration(db, {
  id: "e2e-show-1",
  activityId: publishedId,
  participantId: "e2e-host",
  questionnaireVersion: "stage-v1",
  questionnaireHash: "e2e-show",
  status: "approved",
  answers: { name: "主持人甲", program: "开场致辞", description: "灯光渐亮" },
  revision: 1,
});
await insertRegistration(db, {
  id: "e2e-show-2",
  activityId: publishedId,
  participantId: "e2e-choir",
  questionnaireVersion: "stage-v1",
  questionnaireHash: "e2e-show",
  status: "approved",
  answers: { name: "音乐系合唱队", program: "合唱《毕业歌》", description: "全体起立" },
  revision: 1,
});
await insertRegistration(db, {
  id: "e2e-show-draft",
  activityId: draftId,
  participantId: "e2e-secret",
  questionnaireVersion: "stage-v1",
  questionnaireHash: "e2e-show",
  status: "approved",
  answers: { name: "秘密节目", program: "不能提前看到的节目" },
  revision: 1,
});

await closeDb(db);
console.log("Seeded programme E2E activities");
