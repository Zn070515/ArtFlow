import { randomUUID } from "node:crypto";

import { closeDb, createDb, insertRegistration, migrate } from "@artflow-plus/db";
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
const schema = `artflow_api_programme_${Date.now()}_${process.pid}`;

let db: Kysely<Database>;
let admin: Client;
let publicApp: FastifyInstance;
let hostApp: FastifyInstance;
let outsiderApp: FastifyInstance;
let publishedId: string;

const deps: RuntimeDeps = {
  now: () => "2026-11-11T12:00:00.000Z",
  newEventId: () => randomUUID(),
};
const host: ActorContext = {
  actorId: "programme-host",
  actorType: "user",
  roles: ["staff"],
  permissions: ["registration.review"],
};
const outsider: ActorContext = {
  actorId: "programme-guest",
  actorType: "user",
  roles: ["participant"],
  permissions: [],
};

describe.skipIf(!connectionString)("programme projection", () => {
  beforeAll(async () => {
    if (!connectionString) return;
    admin = new Client({ connectionString });
    await admin.connect();
    await admin.query(`CREATE SCHEMA "${schema}"`);
    db = createDb({ connectionString, schema });
    await migrate(db);
    publicApp = await buildApp({ db, deps, actor: outsider });
    hostApp = await buildApp({ db, deps, actor: host });
    outsiderApp = await buildApp({ db, deps, actor: outsider });
    await Promise.all([publicApp.ready(), hostApp.ready(), outsiderApp.ready()]);

    publishedId = `act-${randomUUID()}`;
    const draftId = `act-${randomUUID()}`;
    await db.insertInto("activity").values([
      {
        id: publishedId,
        public_code: "SHOW-PUB",
        title: "2026 毕业晚会",
        status: "active",
        revision: 1,
        enabled_capabilities: JSON.stringify(["registration", "questionnaire"]),
        active_definition_version: 1,
      },
      {
        id: draftId,
        public_code: "SHOW-DRAFT",
        title: "未发布晚会",
        status: "active",
        revision: 1,
        enabled_capabilities: JSON.stringify(["registration"]),
        active_definition_version: 1,
      },
    ]).execute();
    await db.insertInto("roster").values({
      activity_id: publishedId,
      status: "final",
      approved_count: 1,
      revision: 1,
      finalized_at: new Date("2026-11-11T12:00:00Z"),
      updated_at: new Date("2026-11-11T12:00:00Z"),
    }).execute();
    await insertRegistration(db, {
      id: "show-b",
      activityId: publishedId,
      participantId: "choir",
      questionnaireVersion: "v1",
      questionnaireHash: "hash",
      status: "approved",
      answers: { name: "音乐系合唱队", program: "合唱《毕业歌》", description: "全体起立" },
      revision: 1,
    });
    await insertRegistration(db, {
      id: "show-a",
      activityId: publishedId,
      participantId: "host-1",
      questionnaireVersion: "v1",
      questionnaireHash: "hash",
      status: "approved",
      answers: { name: "主持人甲", program: "开场致辞" },
      revision: 1,
    });
    await insertRegistration(db, {
      id: "show-hidden",
      activityId: publishedId,
      participantId: "wait",
      questionnaireVersion: "v1",
      questionnaireHash: "hash",
      status: "submitted",
      answers: { program: "不能提前看到的节目" },
      revision: 1,
    });
    await insertRegistration(db, {
      id: "draft-reg",
      activityId: draftId,
      participantId: "secret",
      questionnaireVersion: "v1",
      questionnaireHash: "hash",
      status: "approved",
      answers: { program: "不能提前看到的节目" },
      revision: 1,
    });
  });

  afterAll(async () => {
    if (!connectionString) return;
    await Promise.all([publicApp.close(), hostApp.close(), outsiderApp.close()]);
    await closeDb(db);
    await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
    await admin.end();
  });

  it("publishes the finalized order and hides unpublished titles", async () => {
    const published = await publicApp.inject({ method: "GET", url: "/api/public/programme/SHOW-PUB" });
    expect(published.statusCode).toBe(200);
    expect(published.json()).toMatchObject({
      activityTitle: "2026 毕业晚会",
      published: true,
      items: [
        { order: 1, title: "开场致辞", performers: "主持人甲" },
        { order: 2, title: "合唱《毕业歌》", performers: "音乐系合唱队", notes: "全体起立" },
      ],
    });
    expect(published.body).not.toContain("不能提前看到的节目");

    const draft = await publicApp.inject({ method: "GET", url: "/api/public/programme/SHOW-DRAFT" });
    expect(draft.statusCode).toBe(200);
    expect(draft.json()).toMatchObject({ published: false, emptyReason: "roster_not_final", items: [] });
    expect(draft.body).not.toContain("不能提前看到的节目");

    const missing = await publicApp.inject({ method: "GET", url: "/api/public/programme/NO-SUCH" });
    expect(missing.statusCode).toBe(404);
  });

  it("gives the host the same projection and refuses a participant", async () => {
    const hostView = await hostApp.inject({
      method: "GET",
      url: `/api/activities/${publishedId}/programme`,
    });
    expect(hostView.statusCode).toBe(200);
    expect(hostView.json().items.map((item: { title: string }) => item.title)).toEqual([
      "开场致辞",
      "合唱《毕业歌》",
    ]);
    const denied = await outsiderApp.inject({
      method: "GET",
      url: `/api/activities/${publishedId}/programme`,
    });
    expect(denied.statusCode).toBe(403);
  });
});
