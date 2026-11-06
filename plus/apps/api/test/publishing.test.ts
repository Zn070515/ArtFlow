import { PUBLISHING_COMMAND_SCOPES } from "@artflow-plus/domain";
import { randomUUID } from "node:crypto";

import { closeDb, createDb, insertPodiumCandidate, insertRelease, insertSession, migrate } from "@artflow-plus/db";
import type { Database } from "@artflow-plus/db";
import type { ActorContext, ExecutionSession } from "@artflow-plus/domain";
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
const schema = `artflow_api_publishing_${Date.now()}_${process.pid}`;

let db: Kysely<Database>;
let admin: Client;
let app: FastifyInstance;
let forbiddenApp: FastifyInstance;
let unauthenticatedApp: FastifyInstance;
let clock = 0;

const staff: ActorContext = {
  actorId: "api-staff",
  actorType: "user",
  roles: ["staff"],
  permissions: ["result.manage"],
};
const outsider: ActorContext = {
  actorId: "api-outsider",
  actorType: "user",
  roles: ["participant"],
  permissions: [],
};
const deps: RuntimeDeps = {
  now: () => new Date(Date.UTC(2026, 9, 19, 18, 0, clock++)).toISOString(),
  newEventId: () => randomUUID(),
};

function headers(id = `cmd-${randomUUID()}`) {
  return { "idempotency-key": id, "content-type": "application/json" };
}

async function seed(activityId: string, publicCode: string): Promise<void> {
  await db.insertInto("activity").values({
    id: activityId,
    public_code: publicCode,
    title: "2026 院十佳",
    status: "active",
    revision: 1,
    enabled_capabilities: JSON.stringify(["competition", "publishing"]),
    active_definition_version: 1,
  }).execute();
  await db.insertInto("competition_round").values({
    id: `round-${activityId}`,
    activity_id: activityId,
    round_key: "final",
    release_version: 1,
    state: "locked",
    revision: 1,
    score_version: 1,
    minimum_judges: 1,
    judge_count: 1,
    completion_mode: "full_matrix",
    scoring_method: "average",
    advance_count: 0,
  }).execute();
  await insertRelease(db, {
    activityId,
    version: 1,
    contentHash: "api-release",
    capabilities: {
      publishing: {
        ok: true,
        capabilityKey: "publishing",
        contentHash: "publishing",
        artifact: {
          version: 1,
          schemaVersion: 1,
          stages: [{ key: "final_podium", label: "正式赛果" }],
        },
      },
    },
    executionPolicy: { declaredScopes: ["publishing"], conflicts: {}, runtimeContractVersion: 2, commandScopes: PUBLISHING_COMMAND_SCOPES },
    capabilityVersions: { publishing: "1" },
    bindings: [],
    releasedAt: "2026-10-19T17:00:00Z",
    sourceDraftRevision: 1,
  });
  const session: ExecutionSession = {
    id: `publishing-${activityId}`,
    activityId,
    definitionVersion: 1,
    contentHash: "api-release",
    scope: "publishing",
    mode: "formal",
    status: "running",
    revision: 0,
  };
  await insertSession(db, session, "2026-10-19T17:00:00Z");
  await insertPodiumCandidate(db, {
    id: `podium-${activityId}`,
    activityId,
    inputFingerprint: "fp-api",
    status: "candidate",
    placements: [
      { place: 1, contestantId: "singer-a", total: "98.30" },
      { place: 2, contestantId: "singer-b", total: "97.80" },
    ],
    sourceRoundIds: [`round-${activityId}`],
    sourceScoreVersions: [{ roundId: `round-${activityId}`, sourceScoreVersion: 1 }],
    revision: 3,
  });
}

async function confirm(activityId: string): Promise<void> {
  const response = await app.inject({
    method: "POST",
    url: `/api/activities/${activityId}/publishing/stage-results/final_podium/confirm`,
    headers: headers(`api-confirm-${activityId}`),
    payload: {
      scope: "publishing",
      expectedSourceRevision: 3,
      expectedInputFingerprint: "fp-api",
      awards: [{ award: "冠军", contestantId: "singer-a" }],
      note: "confirm",
    },
  });
  expect(response.statusCode).toBe(201);
}

describe.skipIf(!connectionString)("publishing HTTP", () => {
  beforeAll(async () => {
    if (!connectionString) return;
    admin = new Client({ connectionString });
    await admin.connect();
    await admin.query(`CREATE SCHEMA "${schema}"`);
    db = createDb({ connectionString, schema });
    await migrate(db);
    app = await buildApp({ db, deps, actor: staff });
    forbiddenApp = await buildApp({ db, deps, actor: outsider });
    unauthenticatedApp = await buildApp({ db, deps });
    await Promise.all([app.ready(), forbiddenApp.ready(), unauthenticatedApp.ready()]);
  });

  afterAll(async () => {
    if (!connectionString) return;
    await Promise.all([app.close(), forbiddenApp.close(), unauthenticatedApp.close()]);
    await closeDb(db);
    await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
    await admin.end();
  });

  it("releases and serves the anonymous selector without internal fields", async () => {
    const activityId = `act-${randomUUID()}`;
    await seed(activityId, "APICODE");
    await confirm(activityId);
    const released = await app.inject({
      method: "POST",
      url: `/api/activities/${activityId}/publishing/releases`,
      headers: headers(`api-release-${activityId}`),
      payload: {
        stageKey: "final_podium",
        scope: "publishing",
        expectedCandidateRevision: 3,
        note: "release",
      },
    });
    expect(released.statusCode).toBe(201);
    const publicResponse = await unauthenticatedApp.inject({
      method: "GET",
      url: "/api/public/results/APICODE",
    });
    expect(publicResponse.statusCode).toBe(200);
    expect(publicResponse.headers["cache-control"]).toBe("no-store");
    expect(publicResponse.json()).toMatchObject({
      activity: { publicCode: "APICODE" },
      activityTitle: "2026 院十佳",
      results: [
        {
          stageKey: "final_podium",
          publicTitle: "2026 院十佳 · 正式赛果",
          decisions: [
            { rank: 1, contestantId: "singer-a", score: "98.30" },
            { rank: 2, contestantId: "singer-b", score: "97.80" },
          ],
          awards: [{ award: "冠军", contestantId: "singer-a" }],
        },
      ],
    });
    expect(publicResponse.body).not.toContain("fp-api");
    expect(publicResponse.body).not.toContain("input_fingerprint");
  });

  it("returns 404 for an unknown public code and 200 with an empty list for a missing stage", async () => {
    const missing = await unauthenticatedApp.inject({ method: "GET", url: "/api/public/results/NOPE" });
    expect(missing.statusCode).toBe(404);
    const activityId = `act-${randomUUID()}`;
    await seed(activityId, "EMPTYCODE");
    const empty = await unauthenticatedApp.inject({
      method: "GET",
      url: "/api/public/results/EMPTYCODE?stage=final_podium",
    });
    expect(empty.statusCode).toBe(200);
    expect(empty.json().results).toEqual([]);
  });

  it("requires authentication and result.manage", async () => {
    const activityId = `act-${randomUUID()}`;
    await seed(activityId, "AUTHCODE");
    const unauthorized = await unauthenticatedApp.inject({
      method: "POST",
      url: `/api/activities/${activityId}/publishing/stage-results/final_podium/confirm`,
      headers: headers("api-unauth"),
      payload: {
        scope: "publishing",
        expectedSourceRevision: 3,
        expectedInputFingerprint: "fp-api",
        awards: [],
      },
    });
    expect(unauthorized.statusCode).toBe(401);
    const forbidden = await forbiddenApp.inject({
      method: "POST",
      url: `/api/activities/${activityId}/publishing/stage-results/final_podium/confirm`,
      headers: headers("api-forbidden"),
      payload: {
        scope: "publishing",
        expectedSourceRevision: 3,
        expectedInputFingerprint: "fp-api",
        awards: [],
      },
    });
    expect(forbidden.statusCode).toBe(403);
  });

  it("returns 409 for a stale candidate revision", async () => {
    const activityId = `act-${randomUUID()}`;
    await seed(activityId, "STALECODE");
    const stale = await app.inject({
      method: "POST",
      url: `/api/activities/${activityId}/publishing/stage-results/final_podium/confirm`,
      headers: headers("api-stale"),
      payload: {
        scope: "publishing",
        expectedSourceRevision: 2,
        expectedInputFingerprint: "fp-api",
        awards: [],
      },
    });
    expect(stale.statusCode).toBe(409);
    expect(stale.json().code).toBe("STALE_RESOLUTION_INPUT");
  });
});
