import { randomUUID } from "node:crypto";

import {
  closeDb,
  createDb,
  insertMaterial,
  insertRegistration,
  insertRelease,
  migrate,
} from "@artflow-plus/db";
import type { Database } from "@artflow-plus/db";
import type { ActorContext } from "@artflow-plus/domain";
import type { FastifyInstance } from "fastify";
import { Client } from "pg";
import type { Kysely } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { buildApp } from "../src/app.js";
import type { RuntimeDeps } from "@artflow-plus/runtime";

const connectionString = process.env.ARTFLOW_PLUS_DATABASE_URL;
if (process.env.REQUIRE_DB === "1" && connectionString === undefined) {
  throw new Error("REQUIRE_DB=1 but ARTFLOW_PLUS_DATABASE_URL is unset.");
}
const schema = `artflow_api_registration_read_${Date.now()}_${process.pid}`;

let db: Kysely<Database>;
let admin: Client;
let staffApp: FastifyInstance;
let participantApp: FastifyInstance;
let outsiderApp: FastifyInstance;
let activityId: string;

const deps: RuntimeDeps = {
  now: () => new Date().toISOString(),
  newEventId: () => randomUUID(),
};

const staff: ActorContext = {
  actorId: "read-staff",
  actorType: "user",
  roles: ["staff"],
  permissions: ["registration.review", "registration.roster.finalize"],
};
const owner: ActorContext = {
  actorId: "participant-1",
  actorType: "user",
  roles: ["participant"],
  permissions: [],
};
const outsider: ActorContext = {
  actorId: "participant-2",
  actorType: "user",
  roles: ["participant"],
  permissions: [],
};

const questionnaire = {
  schemaVersion: 1,
  version: "v1",
  schemaHash: "hash-1",
  questions: [
    { key: "name", label: "姓名", type: "text", required: true },
    {
      key: "audio",
      label: "音频材料",
      type: "file",
      required: true,
      file: { slot: "audio", purpose: "audio", accepts: [".mp3"], maxBytes: 1000 },
    },
  ],
  fileSlots: [{ key: "audio", slot: "audio", purpose: "audio", accepts: [".mp3"], maxBytes: 1000 }],
};

describe.skipIf(!connectionString)("registration read endpoints", () => {
  beforeAll(async () => {
    if (!connectionString) return;
    admin = new Client({ connectionString });
    await admin.connect();
    await admin.query(`CREATE SCHEMA "${schema}"`);
    db = createDb({ connectionString, schema });
    await migrate(db);
    staffApp = await buildApp({ db, deps, actor: staff });
    participantApp = await buildApp({ db, deps, actor: owner });
    outsiderApp = await buildApp({ db, deps, actor: outsider });
    await Promise.all([staffApp.ready(), participantApp.ready(), outsiderApp.ready()]);

    activityId = `act-${randomUUID()}`;
    await db.insertInto("activity").values({
      id: activityId,
      public_code: "READ-1",
      title: "2026 院十佳",
      status: "active",
      revision: 1,
      enabled_capabilities: JSON.stringify(["registration", "questionnaire", "materials"]),
      active_definition_version: 1,
    }).execute();
    await insertRelease(db, {
      activityId,
      version: 1,
      contentHash: "release-hash",
      capabilities: {
        questionnaire: {
          ok: true,
          capabilityKey: "questionnaire",
          contentHash: "q",
          artifact: questionnaire,
        },
        materials: {
          ok: true,
          capabilityKey: "materials",
          contentHash: "m",
          artifact: { schemaVersion: 1, maxBytes: 1000, allowedPurposes: ["audio"] },
        },
      },
      executionPolicy: { declaredScopes: [], conflicts: {}, runtimeContractVersion: 1 },
      capabilityVersions: {},
      bindings: [],
      releasedAt: "2026-10-26T10:00:00Z",
      sourceDraftRevision: 1,
    });
    await insertRegistration(db, {
      id: "reg-1",
      activityId,
      participantId: owner.actorId,
      questionnaireVersion: "v1",
      questionnaireHash: "hash-1",
      status: "draft",
      answers: { name: "Alice" },
      revision: 1,
    });
    await insertMaterial(db, {
      id: "material-1",
      activityId,
      registrationId: "reg-1",
      questionKey: "audio",
      storageKey: "private/storage/key",
      originalName: "demo.mp3",
      contentType: "audio/mpeg",
      byteLength: 128,
      ownerActorId: owner.actorId,
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
    await Promise.all([staffApp.close(), participantApp.close(), outsiderApp.close()]);
    await closeDb(db);
    await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
    await admin.end();
  });

  it("serves the public activity by code", async () => {
    const response = await participantApp.inject({ method: "GET", url: "/api/public/activities/READ-1" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      id: activityId,
      publicCode: "READ-1",
      title: "2026 院十佳",
      status: "active",
      registrationOpen: true,
    });
    const missing = await participantApp.inject({ method: "GET", url: "/api/public/activities/NOPE" });
    expect(missing.statusCode).toBe(404);
  });

  it("reports registration closed when the activity has no released questionnaire", async () => {
    const liveOnlyId = `act-${randomUUID()}`;
    await db.insertInto("activity").values({
      id: liveOnlyId,
      public_code: "LIVE-ONLY",
      title: "仅现场",
      status: "active",
      revision: 1,
      enabled_capabilities: JSON.stringify(["competition"]),
      active_definition_version: 1,
    }).execute();
    await insertRelease(db, {
      activityId: liveOnlyId,
      version: 1,
      contentHash: "live-only-release",
      capabilities: {},
      executionPolicy: { declaredScopes: ["judging"], conflicts: {}, runtimeContractVersion: 1 },
      capabilityVersions: {},
      bindings: [],
      releasedAt: "2026-10-26T10:00:00Z",
      sourceDraftRevision: 1,
    });
    const response = await participantApp.inject({
      method: "GET",
      url: "/api/public/activities/LIVE-ONLY",
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ status: "active", registrationOpen: false });
  });

  it("lists activities only for reviewers", async () => {
    const staffResponse = await staffApp.inject({ method: "GET", url: "/api/activities" });
    expect(staffResponse.statusCode).toBe(200);
    expect(staffResponse.json().activities.map((item: { id: string }) => item.id)).toContain(activityId);
    const participantResponse = await participantApp.inject({ method: "GET", url: "/api/activities" });
    expect(participantResponse.statusCode).toBe(403);
  });

  it("reads mine and the frozen form with owner/staff permissions only", async () => {
    const mine = await participantApp.inject({ method: "GET", url: `/api/activities/${activityId}/registrations/mine` });
    expect(mine.statusCode).toBe(200);
    expect(mine.json()).toMatchObject({ id: "reg-1", participantId: owner.actorId });
    const other = await outsiderApp.inject({ method: "GET", url: `/api/activities/${activityId}/registrations/mine` });
    expect(other.statusCode).toBe(404);

    const ownerDetail = await participantApp.inject({
      method: "GET",
      url: `/api/activities/${activityId}/registrations/reg-1`,
    });
    expect(ownerDetail.statusCode).toBe(200);
    expect(ownerDetail.json()).toMatchObject({
      activity: { id: activityId, publicCode: "READ-1" },
      registration: { id: "reg-1", answers: { name: "Alice" } },
      questionnaire: {
        version: "v1",
        questions: expect.arrayContaining([
          expect.objectContaining({ key: "name", label: "姓名" }),
        ]),
      },
      materials: [{ id: "material-1", questionKey: "audio", originalName: "demo.mp3" }],
    });
    const body = JSON.stringify(ownerDetail.json());
    expect(body).not.toContain("schemaHash");
    expect(body).not.toContain("storageKey");
    expect(body).not.toContain("private/storage/key");
    expect(body).not.toContain("ownerActorId");

    const staffDetail = await staffApp.inject({
      method: "GET",
      url: `/api/activities/${activityId}/registrations/reg-1`,
    });
    expect(staffDetail.statusCode).toBe(200);
    const forbidden = await outsiderApp.inject({
      method: "GET",
      url: `/api/activities/${activityId}/registrations/reg-1`,
    });
    expect(forbidden.statusCode).toBe(403);
  });

  it("lists registrations and roster for reviewers", async () => {
    const list = await staffApp.inject({ method: "GET", url: `/api/activities/${activityId}/registrations` });
    expect(list.statusCode).toBe(200);
    expect(list.json().registrations).toHaveLength(1);
    const roster = await staffApp.inject({ method: "GET", url: `/api/activities/${activityId}/roster` });
    expect(roster.statusCode).toBe(200);
    expect(roster.json().roster).toMatchObject({ status: "unknown", revision: 0 });
    const forbiddenList = await participantApp.inject({
      method: "GET",
      url: `/api/activities/${activityId}/registrations`,
    });
    expect(forbiddenList.statusCode).toBe(403);
    const forbiddenRoster = await participantApp.inject({
      method: "GET",
      url: `/api/activities/${activityId}/roster`,
    });
    expect(forbiddenRoster.statusCode).toBe(403);
  });
});
