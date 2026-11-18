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
const schema = `artflow_api_me_${Date.now()}_${process.pid}`;

let db: Kysely<Database>;
let admin: Client;
let appA: FastifyInstance;
let appB: FastifyInstance;
let appAnonymous: FastifyInstance;

const deps: RuntimeDeps = {
  now: () => new Date().toISOString(),
  newEventId: () => randomUUID(),
};
const actorA: ActorContext = {
  actorId: "participant-a",
  actorType: "user",
  roles: ["participant"],
  permissions: [],
};
const actorB: ActorContext = {
  actorId: "participant-b",
  actorType: "user",
  roles: ["participant"],
  permissions: [],
};

async function seed(activityId: string, publicCode: string, participantId: string): Promise<void> {
  await db.insertInto("activity").values({
    id: activityId,
    public_code: publicCode,
    title: `活动 ${publicCode}`,
    status: "active",
    revision: 1,
    enabled_capabilities: JSON.stringify(["registration", "questionnaire", "materials"]),
    active_definition_version: 1,
  }).execute();
  await insertRegistration(db, {
    id: `reg-${participantId}`,
    activityId,
    participantId,
    questionnaireVersion: "v1",
    questionnaireHash: "hash",
    status: "approved",
    answers: {},
    supplementKeys: [],
    revision: 2,
    reviewNote: "欢迎",
    reviewedBy: "staff",
  });
  await insertMaterial(db, {
    id: `mat-${participantId}`,
    activityId,
    registrationId: `reg-${participantId}`,
    questionKey: "audio",
    storageKey: "k",
    originalName: "demo.mp3",
    contentType: "audio/mpeg",
    byteLength: 3,
    ownerActorId: participantId,
    status: "uploaded",
    reviewNote: "",
    reviewedBy: null,
    reviewedAt: null,
    revision: 1,
    current: true,
    contentReady: true,
  });
}

describe.skipIf(!connectionString)("participant center API", () => {
  beforeAll(async () => {
    if (!connectionString) return;
    admin = new Client({ connectionString });
    await admin.connect();
    await admin.query(`CREATE SCHEMA "${schema}"`);
    db = createDb({ connectionString, schema });
    await migrate(db);
    await seed("act-a", "ME-A", "participant-a");
    await seed("act-b", "ME-B", "participant-b");
    appA = await buildApp({ db, deps, actor: actorA });
    appB = await buildApp({ db, deps, actor: actorB });
    appAnonymous = await buildApp({ db, deps });
    await Promise.all([appA.ready(), appB.ready(), appAnonymous.ready()]);
  });

  afterAll(async () => {
    if (!connectionString) return;
    await Promise.all([appA.close(), appB.close(), appAnonymous.close()]);
    await closeDb(db);
    await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
    await admin.end();
  });

  it("returns only the actor's events", async () => {
    const response = await appA.inject({ method: "GET", url: "/api/me" });
    expect(response.statusCode).toBe(200);
    expect(response.json().events).toHaveLength(1);
    expect(response.body).toContain("ME-A");
    expect(response.body).not.toContain("ME-B");
    const other = await appB.inject({ method: "GET", url: "/api/me" });
    expect(other.body).toContain("ME-B");
    expect(other.body).not.toContain("ME-A");
  });

  it("requires a session", async () => {
    const response = await appAnonymous.inject({ method: "GET", url: "/api/me" });
    expect(response.statusCode).toBe(401);
  });

  it("marks notifications read idempotently", async () => {
    const first = await appA.inject({ method: "GET", url: "/api/me" });
    const keys = (first.json().notifications.items as { key: string }[]).map((item) => item.key);
    expect(keys.length).toBeGreaterThan(0);
    const marked = await appA.inject({
      method: "POST",
      url: "/api/me/notifications/read",
      headers: { "content-type": "application/json" },
      payload: { keys },
    });
    expect(marked.statusCode).toBe(200);
    expect(marked.json().unreadCount).toBe(0);
    const again = await appA.inject({
      method: "POST",
      url: "/api/me/notifications/read",
      headers: { "content-type": "application/json" },
      payload: { keys },
    });
    expect(again.json().unreadCount).toBe(0);
  });
});
