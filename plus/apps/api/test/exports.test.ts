import { randomUUID } from "node:crypto";

import { closeDb, createDb, insertMaterial, insertRegistration, migrate } from "@artflow-plus/db";
import type { Database } from "@artflow-plus/db";
import type { ActorContext } from "@artflow-plus/domain";
import type { RuntimeDeps } from "@artflow-plus/runtime";
import type { FastifyInstance } from "fastify";
import { Client } from "pg";
import type { Kysely } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { buildApp } from "../src/app.js";

const connectionString = process.env.ARTFLOW_PLUS_DATABASE_URL;
if (process.env.REQUIRE_DB === "1" && connectionString === undefined) {
  throw new Error("REQUIRE_DB=1 but ARTFLOW_PLUS_DATABASE_URL is unset.");
}
const schema = `artflow_api_exports_${Date.now()}_${process.pid}`;

let db: Kysely<Database>;
let admin: Client;
let reviewerApp: FastifyInstance;
let scorerApp: FastifyInstance;
let outsiderApp: FastifyInstance;
let emptyActivityId: string;
let filledActivityId: string;

const deps: RuntimeDeps = {
  now: () => "2026-11-11T12:00:00.000Z",
  newEventId: () => randomUUID(),
};

const reviewer: ActorContext = {
  actorId: "export-reviewer",
  actorType: "user",
  roles: ["staff"],
  permissions: ["registration.review"],
};
const scorer: ActorContext = {
  actorId: "export-scorer",
  actorType: "user",
  roles: ["staff"],
  permissions: ["competition.manage"],
};
const outsider: ActorContext = {
  actorId: "export-outsider",
  actorType: "user",
  roles: ["participant"],
  permissions: [],
};

async function auditCount(activityId: string): Promise<number> {
  const row = await db.selectFrom("audit_entry")
    .select(({ fn }) => fn.countAll<string>().as("count"))
    .where("activity_id", "=", activityId)
    .executeTakeFirstOrThrow();
  return Number(row.count);
}

describe.skipIf(!connectionString)("staff sheet exports", () => {
  beforeAll(async () => {
    if (!connectionString) return;
    admin = new Client({ connectionString });
    await admin.connect();
    await admin.query(`CREATE SCHEMA "${schema}"`);
    db = createDb({ connectionString, schema });
    await migrate(db);
    reviewerApp = await buildApp({ db, deps, actor: reviewer });
    scorerApp = await buildApp({ db, deps, actor: scorer });
    outsiderApp = await buildApp({ db, deps, actor: outsider });
    await Promise.all([reviewerApp.ready(), scorerApp.ready(), outsiderApp.ready()]);

    emptyActivityId = `act-${randomUUID()}`;
    filledActivityId = `act-${randomUUID()}`;
    await db.insertInto("activity").values([
      {
        id: emptyActivityId,
        public_code: "EXPORT-EMPTY",
        title: "空名单",
        status: "active",
        revision: 1,
        enabled_capabilities: JSON.stringify(["registration", "materials", "competition", "voting"]),
        active_definition_version: 1,
      },
      {
        id: filledActivityId,
        public_code: "EXPORT-FULL",
        title: "2026 院十佳",
        status: "active",
        revision: 1,
        enabled_capabilities: JSON.stringify(["registration", "materials"]),
        active_definition_version: 1,
      },
    ]).execute();
    await insertRegistration(db, {
      id: "export-reg-1",
      activityId: filledActivityId,
      participantId: "participant-1",
      questionnaireVersion: "v1",
      questionnaireHash: "hash-1",
      status: "approved",
      answers: { name: "李明", student_id: "20260001", song: "夜空中最亮的星" },
      revision: 2,
      reviewNote: "通过",
    });
    await insertMaterial(db, {
      id: "export-material-1",
      activityId: filledActivityId,
      registrationId: "export-reg-1",
      questionKey: "audio",
      storageKey: "private/do-not-leak-key",
      originalName: "demo.mp3",
      contentType: "audio/mpeg",
      byteLength: 128,
      ownerActorId: "participant-1",
      status: "uploaded",
      reviewNote: "",
      reviewedBy: null,
      reviewedAt: null,
      revision: 0,
      current: true,
    });
  });

  afterAll(async () => {
    if (!connectionString) return;
    await Promise.all([reviewerApp.close(), scorerApp.close(), outsiderApp.close()]);
    await closeDb(db);
    await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
    await admin.end();
  });

  it("returns an explicit registration file for an empty unfinalized roster and audits it", async () => {
    const before = await auditCount(emptyActivityId);
    const response = await reviewerApp.inject({
      method: "GET",
      url: `/api/activities/${emptyActivityId}/exports/registrations`,
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("text/csv");
    expect(response.headers["content-disposition"]).toBe('attachment; filename="registrations.csv"');
    expect(response.body).toContain("未定稿,（暂无报名）");
    expect(await auditCount(emptyActivityId)).toBe(before + 1);
    const audit = await db.selectFrom("audit_entry").selectAll()
      .where("activity_id", "=", emptyActivityId)
      .orderBy("id", "desc")
      .executeTakeFirstOrThrow();
    expect(audit.command_type).toBe("staff.export.registrations");
    expect(audit.actor_id).toBe(reviewer.actorId);
    const detail = typeof audit.detail === "string" ? JSON.parse(audit.detail) : audit.detail;
    expect(detail).toMatchObject({ kind: "registrations", rowCount: 0, includesPrivateMedia: false });
  });

  it("rejects a reader who lacks the sheet permission and writes no audit", async () => {
    const before = await auditCount(emptyActivityId);
    const outsiderResponse = await outsiderApp.inject({
      method: "GET",
      url: `/api/activities/${emptyActivityId}/exports/registrations`,
    });
    const scorerResponse = await scorerApp.inject({
      method: "GET",
      url: `/api/activities/${emptyActivityId}/exports/registrations`,
    });
    const reviewerScores = await reviewerApp.inject({
      method: "GET",
      url: `/api/activities/${emptyActivityId}/exports/scores`,
    });
    expect(outsiderResponse.statusCode).toBe(403);
    expect(scorerResponse.statusCode).toBe(403);
    expect(reviewerScores.statusCode).toBe(403);
    expect(await auditCount(emptyActivityId)).toBe(before);
  });

  it("lets competition staff download empty score and vote files", async () => {
    const scores = await scorerApp.inject({
      method: "GET",
      url: `/api/activities/${emptyActivityId}/exports/scores`,
    });
    const votes = await scorerApp.inject({
      method: "GET",
      url: `/api/activities/${emptyActivityId}/exports/votes`,
    });
    expect(scores.statusCode).toBe(200);
    expect(scores.body).toContain("（暂无评分）");
    expect(votes.statusCode).toBe(200);
    expect(votes.body).toContain("（暂无投票场次）");
  });

  it("exports registration columns and material metadata without the storage key", async () => {
    const registrations = await reviewerApp.inject({
      method: "GET",
      url: `/api/activities/${filledActivityId}/exports/registrations`,
    });
    const materials = await reviewerApp.inject({
      method: "GET",
      url: `/api/activities/${filledActivityId}/exports/materials`,
    });
    expect(registrations.statusCode).toBe(200);
    expect(registrations.body).toContain("姓名,学号,曲目,状态");
    expect(registrations.body).toContain("未定稿,李明,20260001,夜空中最亮的星,已通过,participant-1,通过");
    expect(materials.statusCode).toBe(200);
    expect(materials.body).toContain("demo.mp3");
    expect(materials.body).not.toContain("private/do-not-leak-key");
    const missing = await reviewerApp.inject({
      method: "GET",
      url: "/api/activities/missing-activity/exports/registrations",
    });
    expect(missing.statusCode).toBe(404);
  });
});
