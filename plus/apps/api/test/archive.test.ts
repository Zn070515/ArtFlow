import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  closeDb,
  createDb,
  insertResultPublication,
  insertResultRelease,
  insertStageResult,
  migrate,
} from "@artflow-plus/db";
import type { Database } from "@artflow-plus/db";
import type { ActorContext } from "@artflow-plus/domain";
import type { RuntimeDeps } from "@artflow-plus/runtime";
import { createLocalArchiveStorage } from "@artflow-plus/runtime";
import type { FastifyInstance } from "fastify";
import { Client } from "pg";
import type { Kysely } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { buildApp } from "../src/app.js";

const connectionString = process.env.ARTFLOW_PLUS_DATABASE_URL;
if (process.env.REQUIRE_DB === "1" && connectionString === undefined) {
  throw new Error("REQUIRE_DB=1 but ARTFLOW_PLUS_DATABASE_URL is unset.");
}
const schema = `artflow_api_archive_${Date.now()}_${process.pid}`;

let db: Kysely<Database>;
let admin: Client;
let root: string;
let app: FastifyInstance;
let participantApp: FastifyInstance;
let unauthenticatedApp: FastifyInstance;
let clock = 0;

const staff: ActorContext = {
  actorId: "api-archive-staff",
  actorType: "user",
  roles: ["staff"],
  permissions: ["archive.manage", "studio.manage"],
};
const participant: ActorContext = {
  actorId: "api-archive-participant",
  actorType: "user",
  roles: ["participant"],
  permissions: [],
};

const snapshot = {
  activityTitle: "2026 院十佳",
  publicTitle: "2026 院十佳 · 正式赛果",
  stageKey: "final_podium",
  decisions: [{ rank: 1, contestantId: "singer-a", score: "98.30" }],
  awards: [{ award: "冠军", contestantId: "singer-a" }],
};

function deps(): RuntimeDeps {
  return {
    now: () => new Date(Date.UTC(2026, 9, 20, 12, 0, clock++)).toISOString(),
    newEventId: () => randomUUID(),
    archiveStorage: createLocalArchiveStorage(root),
  };
}

function headers(id = `cmd-${randomUUID()}`) {
  return { "idempotency-key": id, "content-type": "application/json" };
}

async function seed(options: {
  readonly status?: "active" | "closed";
  readonly withRelease?: boolean;
  readonly capabilities?: readonly string[];
} = {}): Promise<string> {
  const activityId = `act-${randomUUID()}`;
  await db.insertInto("activity").values({
    id: activityId,
    public_code: activityId,
    title: "2026 院十佳",
    status: options.status ?? "closed",
    revision: 1,
    enabled_capabilities: JSON.stringify(options.capabilities ?? ["publishing", "archive"]),
    active_definition_version: 1,
  }).execute();
  if (options.withRelease ?? true) {
    await insertStageResult(db, {
      id: `stage-${activityId}`,
      activityId,
      stageKey: "final_podium",
      status: "confirmed",
      candidateRevision: 3,
      sourceCandidateRevision: 3,
      inputFingerprint: "fp-1",
      decisions: snapshot.decisions,
      awards: snapshot.awards,
      revision: 1,
      confirmedAt: "2026-10-20T11:00:00.000Z",
    });
    await insertResultPublication(db, {
      id: `publication-${activityId}`,
      activityId,
      stageKey: "final_podium",
      title: "正式赛果",
      content: "",
      version: 1,
      revision: 0,
    });
    await insertResultRelease(db, {
      id: `release-${activityId}`,
      activityId,
      publicationId: `publication-${activityId}`,
      stageResultId: `stage-${activityId}`,
      stageKey: "final_podium",
      status: "active",
      snapshot,
      snapshotCandidateRevision: 3,
      resultVersion: 3,
      postVersion: 1,
      inputFingerprint: "fp-1",
      note: "release",
      releasedAt: "2026-10-20T11:30:00.000Z",
      revision: 0,
    });
  }
  return activityId;
}

describe.skipIf(!connectionString)("archive HTTP", () => {
  beforeAll(async () => {
    if (!connectionString) return;
    root = await mkdtemp(join(tmpdir(), "artflow-api-archive-"));
    admin = new Client({ connectionString });
    await admin.connect();
    await admin.query(`CREATE SCHEMA "${schema}"`);
    db = createDb({ connectionString, schema });
    await migrate(db);
    const runtimeDeps = deps();
    app = await buildApp({ db, deps: runtimeDeps, actor: staff });
    participantApp = await buildApp({ db, deps: runtimeDeps, actor: participant });
    unauthenticatedApp = await buildApp({ db, deps: runtimeDeps });
    await Promise.all([app.ready(), participantApp.ready(), unauthenticatedApp.ready()]);
  });

  afterAll(async () => {
    if (!connectionString) return;
    await Promise.all([app.close(), participantApp.close(), unauthenticatedApp.close()]);
    await closeDb(db);
    await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
    await admin.end();
    await rm(root, { recursive: true, force: true });
  });

  it("closes and renames an activity", async () => {
    const activityId = await seed({ status: "active", withRelease: false, capabilities: [] });
    const closed = await app.inject({
      method: "POST",
      url: `/api/activities/${activityId}/close`,
      headers: headers(`close-${activityId}`),
      payload: { expectedRevision: 1 },
    });
    expect(closed.statusCode).toBe(200);
    expect(closed.json()).toMatchObject({ status: "closed", revision: 2 });
    const renamed = await app.inject({
      method: "PATCH",
      url: `/api/activities/${activityId}/title`,
      headers: headers(`rename-${activityId}`),
      payload: { title: "渡梦十佳", expectedRevision: 2 },
    });
    expect(renamed.statusCode).toBe(200);
    expect(renamed.json()).toMatchObject({ title: "渡梦十佳", revision: 3 });
  });

  it("archives, reports state, and downloads a verified ZIP", async () => {
    const activityId = await seed();
    const archived = await app.inject({
      method: "POST",
      url: `/api/activities/${activityId}/archive`,
      headers: headers(`archive-${activityId}`),
      payload: { expectedRevision: 1, note: "活动结束归档" },
    });
    expect(archived.statusCode).toBe(201);
    expect(archived.json().summary).toMatchObject({
      activityPhase: "archived",
      activityInfoTitle: "2026 院十佳",
    });
    const state = await app.inject({
      method: "GET",
      url: `/api/activities/${activityId}/archive`,
    });
    expect(state.statusCode).toBe(200);
    expect(state.json()).toMatchObject({ activity: { status: "archived" } });
    expect(state.json().packages).toHaveLength(1);
    expect(JSON.stringify(state.json())).not.toContain("/v1.zip");

    const file = await app.inject({
      method: "GET",
      url: `/api/activities/${activityId}/archive/file`,
    });
    expect(file.statusCode).toBe(200);
    expect(file.headers["content-type"]).toBe("application/zip");
    expect(file.headers["cache-control"]).toBe("no-store");
    expect(file.headers["content-disposition"]).toContain("attachment");
    expect(file.rawPayload.subarray(0, 2).toString()).toBe("PK");
  });

  it("returns 404 for an unknown package version", async () => {
    const activityId = await seed();
    await app.inject({
      method: "POST",
      url: `/api/activities/${activityId}/archive`,
      headers: headers(`archive-version-${activityId}`),
      payload: { expectedRevision: 1, note: "archive" },
    });
    const missing = await app.inject({
      method: "GET",
      url: `/api/activities/${activityId}/archive/file?version=9`,
    });
    expect(missing.statusCode).toBe(404);
    expect(missing.json().code).toBe("ARCHIVE_NOT_FOUND");
  });

  it("requires authentication and archive.manage", async () => {
    const activityId = await seed();
    const unauthenticated = await unauthenticatedApp.inject({
      method: "POST",
      url: `/api/activities/${activityId}/archive`,
      headers: headers(`archive-unauth-${activityId}`),
      payload: { expectedRevision: 1, note: "archive" },
    });
    expect(unauthenticated.statusCode).toBe(401);
    const forbidden = await participantApp.inject({
      method: "POST",
      url: `/api/activities/${activityId}/archive`,
      headers: headers(`archive-forbidden-${activityId}`),
      payload: { expectedRevision: 1, note: "archive" },
    });
    expect(forbidden.statusCode).toBe(403);
  });

  it("returns 409 when the package file was tampered with", async () => {
    const activityId = await seed();
    await app.inject({
      method: "POST",
      url: `/api/activities/${activityId}/archive`,
      headers: headers(`archive-tamper-${activityId}`),
      payload: { expectedRevision: 1, note: "archive" },
    });
    const storage = createLocalArchiveStorage(root);
    await storage.put(`${activityId}/v1.zip`, new Uint8Array([1, 2, 3]));
    const tampered = await app.inject({
      method: "GET",
      url: `/api/activities/${activityId}/archive/file`,
    });
    expect(tampered.statusCode).toBe(409);
    expect(tampered.json().code).toBe("ARCHIVE_INTEGRITY_FAILED");
  });
});
