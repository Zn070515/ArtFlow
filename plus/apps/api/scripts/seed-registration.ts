import {
  closeDb,
  createDb,
  getActivity,
  getLocalAccount,
  insertRelease,
  migrate,
} from "@artflow-plus/db";
import { createLocalAccount } from "@artflow-plus/runtime";
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

const adminUsername = "e2e-ops";
const adminPermissions = [
  "registration.review",
  "registration.manage",
  "registration.roster.finalize",
  "studio.manage",
  "competition.manage",
  "competition.round.prepare",
  "competition.score.write",
  "judge.manage",
  "ticket.manage",
  "grouping.manage",
  "voting.manage",
  "result.manage",
];
if ((await getLocalAccount(db, adminUsername)) === null) {
  await createLocalAccount(db, {
    username: adminUsername,
    password: "e2e-ops-password",
    actor: {
      actorId: "e2e-ops",
      actorType: "user",
      roles: ["admin"],
      permissions: adminPermissions,
    },
  });
} else {
  await db
    .updateTable("local_account")
    .set({ permissions: JSON.stringify(adminPermissions) })
    .where("username", "=", adminUsername)
    .execute();
}

const activityId = "act-e2e-registration";
await db.transaction().execute(async (trx) => {
  // The E2E schema is disposable; reset only the command-owned registration data.
  await trx.deleteFrom("material").where("activity_id", "=", activityId).execute();
  await trx.deleteFrom("registration").where("activity_id", "=", activityId).execute();
  await trx.deleteFrom("roster").where("activity_id", "=", activityId).execute();
});
if ((await getActivity(db, activityId)) === null) {
  const questionnaire = {
    schemaVersion: 1,
    version: "e2e-v1",
    schemaHash: "e2e-reg-hash",
    questions: [
      { key: "name", label: "姓名", type: "text", required: true },
      { key: "song", label: "演唱曲目", type: "text", required: true },
      { key: "intro", label: "自我介绍", type: "text", required: false },
      { key: "notice", label: "请确认以上信息真实有效。", type: "notice", required: false },
      {
        key: "audio",
        label: "音频材料",
        type: "file",
        required: true,
        file: { slot: "audio", purpose: "audio", accepts: [".mp3"], maxBytes: 1048576 },
      },
    ],
    fileSlots: [
      { key: "audio", slot: "audio", purpose: "audio", accepts: [".mp3"], maxBytes: 1048576 },
    ],
  };
  const materials = { schemaVersion: 1, maxBytes: 1048576, allowedPurposes: ["audio"] };
  await db.transaction().execute(async (trx) => {
    await trx.insertInto("activity").values({
      id: activityId,
      public_code: "E2E-REG",
      title: "2026 院十佳报名",
      status: "active",
      revision: 1,
      enabled_capabilities: JSON.stringify(["registration", "questionnaire", "materials"]),
      active_definition_version: 1,
    }).execute();
    await insertRelease(trx, {
      activityId,
      version: 1,
      contentHash: "e2e-registration-release",
      capabilities: {
        questionnaire: {
          ok: true,
          capabilityKey: "questionnaire",
          contentHash: "e2e-questionnaire",
          artifact: questionnaire,
        },
        materials: {
          ok: true,
          capabilityKey: "materials",
          contentHash: "e2e-materials",
          artifact: materials,
        },
      },
      executionPolicy: { declaredScopes: [], conflicts: {}, runtimeContractVersion: 2, commandScopes: {} },
      capabilityVersions: { questionnaire: "1", materials: "1" },
      bindings: [],
      releasedAt: "2026-10-26T10:00:00Z",
      sourceDraftRevision: 1,
    });
  });
}

await closeDb(db);
console.log("Seeded registration E2E activity and Ops account");
