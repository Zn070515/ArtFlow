import { randomUUID } from "node:crypto";

import { closeDb, createDb, insertRelease, migrate } from "@artflow-plus/db";
import type { Database } from "@artflow-plus/db";
import { compileTasksDefinition, createTasksDefinition } from "@artflow-plus/domain";
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
const schema = `artflow_api_tasks_${Date.now()}_${process.pid}`;

let db: Kysely<Database>;
let admin: Client;
let managerApp: FastifyInstance;
let readerApp: FastifyInstance;
let forbiddenApp: FastifyInstance;

const deps: RuntimeDeps = {
  now: () => "2026-10-20T10:00:00.000Z",
  newEventId: () => `api-tasks-event-${randomUUID()}`,
};
const manager: ActorContext = {
  actorId: "api-tasks-manager",
  actorType: "user",
  roles: ["staff"],
  permissions: ["tasks.manage"],
};
const reader: ActorContext = {
  actorId: "api-tasks-reader",
  actorType: "user",
  roles: ["staff"],
  permissions: ["registration.review"],
};
const forbidden: ActorContext = {
  actorId: "api-tasks-forbidden",
  actorType: "user",
  roles: ["participant"],
  permissions: [],
};

function taskCapability() {
  const compiled = compileTasksDefinition(createTasksDefinition([
    { key: "registration.review", title: "审核报名", sourceCapability: "registration", sourceKey: "review", required: true },
    { key: "materials.audio", title: "确认音频", sourceCapability: "materials", sourceKey: "audio", required: true },
  ]));
  if (!compiled.ok) throw new Error(JSON.stringify(compiled));
  return compiled;
}

async function seedActivity(): Promise<string> {
  const activityId = `api-task-activity-${randomUUID()}`;
  await db.insertInto("activity").values({
    id: activityId,
    public_code: activityId,
    title: "API tasks",
    status: "active",
    revision: 1,
    enabled_capabilities: JSON.stringify(["tasks", "registration", "materials"]),
    active_definition_version: 1,
  }).execute();
  await insertRelease(db, {
    activityId,
    version: 1,
    contentHash: "api-tasks-release",
    capabilities: { tasks: taskCapability() },
    executionPolicy: { declaredScopes: [], conflicts: {}, runtimeContractVersion: 2, commandScopes: {} },
    capabilityVersions: { tasks: "1.0.0" },
    bindings: [],
    releasedAt: "2026-10-20T09:00:00Z",
    sourceDraftRevision: 1,
  });
  return activityId;
}

function headers(commandId: string) {
  return { "content-type": "application/json", "idempotency-key": commandId };
}

describe.skipIf(!connectionString)("tasks API", () => {
  beforeAll(async () => {
    if (!connectionString) return;
    admin = new Client({ connectionString });
    await admin.connect();
    await admin.query(`CREATE SCHEMA "${schema}"`);
    db = createDb({ connectionString, schema });
    await migrate(db);
    managerApp = await buildApp({ db, deps, actor: manager });
    readerApp = await buildApp({ db, deps, actor: reader });
    forbiddenApp = await buildApp({ db, deps, actor: forbidden });
    await Promise.all([managerApp.ready(), readerApp.ready(), forbiddenApp.ready()]);
  });

  afterAll(async () => {
    if (!connectionString) return;
    await Promise.all([managerApp.close(), readerApp.close(), forbiddenApp.close()]);
    await closeDb(db);
    await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
    await admin.end();
  });

  it("declares the tasks read surface and returns an aggregate task list", async () => {
    const activityId = await seedActivity();
    const synced = await managerApp.inject({
      method: "POST",
      url: `/api/activities/${activityId}/tasks/sync`,
      headers: headers("api-task-sync-list"),
      payload: { definitionVersion: 1 },
    });
    expect(synced.statusCode, synced.body).toBe(200);

    const response = await readerApp.inject({ method: "GET", url: `/api/activities/${activityId}/tasks` });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toMatchObject({
      activityId,
      definitionVersion: 1,
      tasks: [{ templateKey: "materials.audio" }, { templateKey: "registration.review" }],
    });
  });

  it("returns readiness counts without source capability private fields", async () => {
    const activityId = await seedActivity();
    await managerApp.inject({
      method: "POST",
      url: `/api/activities/${activityId}/tasks/sync`,
      headers: headers("api-task-sync-readiness"),
      payload: { definitionVersion: 1 },
    });

    const response = await readerApp.inject({ method: "GET", url: `/api/activities/${activityId}/readiness` });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toMatchObject({ summary: { total: 2, required: 2, done: 0, open: 2 } });
    expect(response.body).not.toContain("answer");
    expect(response.body).not.toContain("review_note");
    expect(response.body).not.toContain("token");
    expect(response.body).not.toContain("storage_key");
    expect(response.body).not.toContain("participantId");
  });

  it("rejects task reads without an allowed task/operations permission", async () => {
    const activityId = await seedActivity();
    const response = await forbiddenApp.inject({ method: "GET", url: `/api/activities/${activityId}/tasks` });
    expect(response.statusCode).toBe(403);
  });

  it("returns 404 for a missing activity and 409 for a stale task revision", async () => {
    const missing = await managerApp.inject({ method: "GET", url: "/api/activities/task-missing/readiness" });
    expect(missing.statusCode).toBe(404);

    const activityId = await seedActivity();
    await managerApp.inject({
      method: "POST",
      url: `/api/activities/${activityId}/tasks/sync`,
      headers: headers("api-task-sync-stale"),
      payload: { definitionVersion: 1 },
    });
    const listed = await managerApp.inject({ method: "GET", url: `/api/activities/${activityId}/tasks` });
    const taskId = listed.json().tasks[0].id as string;
    const first = await managerApp.inject({
      method: "POST",
      url: `/api/activities/${activityId}/tasks/${taskId}/start`,
      headers: headers("api-task-start-first"),
      payload: { expectedRevision: 0 },
    });
    expect(first.statusCode).toBe(200);
    const stale = await managerApp.inject({
      method: "POST",
      url: `/api/activities/${activityId}/tasks/${taskId}/start`,
      headers: headers("api-task-start-stale"),
      payload: { expectedRevision: 0 },
    });
    expect(stale.statusCode).toBe(409);
    expect(stale.json().code).toBe("STALE_REVISION");
  });

  it("accepts an idempotent task command and replays the same response", async () => {
    const activityId = await seedActivity();
    const first = await managerApp.inject({
      method: "POST",
      url: `/api/activities/${activityId}/tasks/sync`,
      headers: headers("api-task-sync-replay"),
      payload: { definitionVersion: 1 },
    });
    const replay = await managerApp.inject({
      method: "POST",
      url: `/api/activities/${activityId}/tasks/sync`,
      headers: headers("api-task-sync-replay"),
      payload: { definitionVersion: 1 },
    });
    expect(first.statusCode).toBe(200);
    expect(replay.statusCode).toBe(200);
    expect(replay.json()).toEqual(first.json());
  });

  it("rejects invalid command bodies before runtime mutation", async () => {
    const activityId = await seedActivity();
    const response = await managerApp.inject({
      method: "POST",
      url: `/api/activities/${activityId}/tasks/fake-task/start`,
      headers: headers("api-task-invalid-body"),
      payload: { expectedRevision: 0, extra: "must-refuse" },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().code).toBe("VALIDATION_FAILED");
    expect(await db.selectFrom("command_receipt").selectAll().where("command_id", "=", "api-task-invalid-body").execute()).toEqual([]);
  });
});
