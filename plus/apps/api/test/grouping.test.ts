import { randomUUID } from "node:crypto";

import { closeDb, createDb, insertLocalAccount, insertRelease, migrate } from "@artflow-plus/db";
import type { Database } from "@artflow-plus/db";
import { hashPassword } from "@artflow-plus/runtime";
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
const schema = `artflow_api_grouping_${Date.now()}_${process.pid}`;

let app: FastifyInstance;
let db: Kysely<Database>;
let admin: Client;
let opsToken = "";
let participantToken = "";

const deps: RuntimeDeps = {
  now: () => new Date().toISOString(),
  newEventId: () => randomUUID(),
};

async function seedGroupingActivity(participants: readonly string[]): Promise<string> {
  const activityId = `act-grouping-${randomUUID()}`;
  await db.insertInto("activity").values({
    id: activityId,
    public_code: activityId,
    title: "分组 API 测试",
    status: "active",
    revision: 1,
    enabled_capabilities: JSON.stringify(["registration", "grouping"]),
    active_definition_version: 1,
  }).execute();
  await insertRelease(db, {
    activityId,
    version: 1,
    contentHash: "api-grouping-release",
    capabilities: {
      grouping: {
        ok: true,
        capabilityKey: "grouping",
        contentHash: "api-grouping",
        artifact: { schemaVersion: 1, groupCount: 2 },
      },
    },
    executionPolicy: { declaredScopes: [], conflicts: {}, runtimeContractVersion: 1 },
    capabilityVersions: { grouping: "1" },
    bindings: [],
    releasedAt: "2026-10-27T09:00:00Z",
    sourceDraftRevision: 1,
  });
  await db.insertInto("roster").values({
    activity_id: activityId,
    status: "final",
    approved_count: participants.length,
    revision: 1,
    finalized_at: "2026-10-27T09:30:00Z",
    updated_at: new Date(),
  }).execute();
  for (const participantId of participants) {
    await db.insertInto("registration").values({
      id: `registration-${activityId}-${participantId}`,
      activity_id: activityId,
      participant_id: participantId,
      questionnaire_version: "v1",
      questionnaire_hash: "hash",
      status: "approved",
      answers: JSON.stringify({ name: participantId.toUpperCase() }),
      revision: 1,
      review_note: "",
      reviewed_by: "staff",
      created_at: new Date(),
      updated_at: new Date(),
    }).execute();
  }
  return activityId;
}

async function login(username: string, password: string): Promise<string> {
  const response = await app.inject({
    method: "POST",
    url: "/api/auth/login",
    headers: { "content-type": "application/json" },
    payload: { username, password },
  });
  expect(response.statusCode).toBe(200);
  return response.json().token as string;
}

describe.skipIf(!connectionString)("grouping routes", () => {
  beforeAll(async () => {
    if (!connectionString) return;
    admin = new Client({ connectionString });
    await admin.connect();
    await admin.query(`CREATE SCHEMA "${schema}"`);
    db = createDb({ connectionString, schema });
    await migrate(db);
    app = await buildApp({ db, deps, enableRuntimeFacts: true });
    await app.ready();
    await insertLocalAccount(db, {
      username: "grouping-ops",
      passwordDigest: hashPassword("grouping-password"),
      actor: {
        actorId: "grouping-ops",
        actorType: "user",
        roles: ["staff"],
        permissions: ["grouping.manage"],
      },
      active: true,
    });
    await insertLocalAccount(db, {
      username: "grouping-participant",
      passwordDigest: hashPassword("participant-password"),
      actor: { actorId: "grouping-participant", actorType: "user", roles: [], permissions: [] },
      active: true,
    });
    opsToken = await login("grouping-ops", "grouping-password");
    participantToken = await login("grouping-participant", "participant-password");
  });

  afterAll(async () => {
    if (!connectionString) return;
    await closeDb(db);
    await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
    await admin.end();
  });

  it("creates, records, confirms, and reads a grouping stage", async () => {
    const activityId = await seedGroupingActivity(["p1", "p2"]);
    const headers = {
      "content-type": "application/json",
      authorization: `Bearer ${opsToken}`,
    };

    const created = await app.inject({
      method: "POST",
      url: `/api/activities/${activityId}/grouping/stages`,
      headers: { ...headers, "idempotency-key": "api-group-create" },
      payload: { stageKey: "chorus", name: "分组合唱", rosterSource: "all_approved" },
    });
    expect(created.statusCode).toBe(201);
    const stage = created.json() as { id: string; revision: number };

    const recorded = await app.inject({
      method: "PATCH",
      url: `/api/activities/${activityId}/grouping/stages/${stage.id}/groups`,
      headers: { ...headers, "idempotency-key": "api-group-record" },
      payload: {
        expectedRevision: stage.revision,
        groups: [
          { name: "A", participantIds: ["p1"] },
          { name: "B", participantIds: ["p2"] },
        ],
      },
    });
    expect(recorded.statusCode).toBe(200);
    const recordedStage = recorded.json() as { revision: number };

    const confirmed = await app.inject({
      method: "POST",
      url: `/api/activities/${activityId}/grouping/stages/${stage.id}/confirm`,
      headers: { ...headers, "idempotency-key": "api-group-confirm" },
      payload: { expectedRevision: recordedStage.revision },
    });
    expect(confirmed.statusCode).toBe(200);

    const read = await app.inject({
      method: "GET",
      url: `/api/activities/${activityId}/grouping`,
      headers,
    });
    expect(read.statusCode).toBe(200);
    const state = read.json() as {
      stages: { status: string; groups: { members: { participantId: string }[] }[] }[];
    };
    expect(state.stages[0]?.status).toBe("confirmed");
    expect(state.stages[0]?.groups).toHaveLength(2);
  });

  it("rejects grouping writes without the permission", async () => {
    const activityId = await seedGroupingActivity(["p1", "p2"]);
    const response = await app.inject({
      method: "POST",
      url: `/api/activities/${activityId}/grouping/stages`,
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${participantToken}`,
        "idempotency-key": "api-group-denied",
      },
      payload: { stageKey: "chorus", name: "分组合唱", rosterSource: "all_approved" },
    });
    expect(response.statusCode).toBe(403);
  });
});
