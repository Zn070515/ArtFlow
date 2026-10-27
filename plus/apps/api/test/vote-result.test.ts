import { randomUUID } from "node:crypto";

import {
  closeDb,
  createDb,
  insertLocalAccount,
  insertRelease,
  insertSession,
  migrate,
} from "@artflow-plus/db";
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
const schema = `artflow_api_vote_result_${Date.now()}_${process.pid}`;

let app: FastifyInstance;
let db: Kysely<Database>;
let admin: Client;
let resultToken = "";
let participantToken = "";

const deps: RuntimeDeps = {
  now: () => new Date().toISOString(),
  newEventId: () => randomUUID(),
};

async function seed(): Promise<{ activityId: string; sessionId: string; publicCode: string }> {
  const activityId = `act-${randomUUID()}`;
  const publicCode = `VOTE-${randomUUID().slice(0, 8)}`;
  const sessionId = `vote-${randomUUID()}`;
  await db.insertInto("activity").values({
    id: activityId,
    public_code: publicCode,
    title: "人气投票",
    status: "active",
    revision: 1,
    enabled_capabilities: JSON.stringify(["voting", "publishing"]),
    active_definition_version: 1,
  }).execute();
  await insertRelease(db, {
    activityId,
    version: 1,
    contentHash: "api-vote-release",
    capabilities: {
      publishing: {
        ok: true,
        capabilityKey: "publishing",
        contentHash: "api-vote-publishing",
        artifact: {
          version: 1,
          schemaVersion: 1,
          stages: [{ key: "vote_result", label: "投票结果" }],
        },
      },
    },
    executionPolicy: { declaredScopes: ["publishing"], conflicts: {}, runtimeContractVersion: 1 },
    capabilityVersions: { publishing: "1" },
    bindings: [],
    releasedAt: "2026-10-27T09:00:00Z",
    sourceDraftRevision: 1,
  });
  await insertSession(db, {
    id: `publishing-${activityId}`,
    activityId,
    definitionVersion: 1,
    contentHash: "api-vote-release",
    scope: "publishing",
    mode: "formal",
    status: "running",
    revision: 0,
  }, "2026-10-27T09:00:00Z");
  await db.insertInto("vote_session").values({
    id: sessionId,
    activity_id: activityId,
    definition_version: 1,
    mode: "formal",
    purpose: "popularity",
    selection_type: "single",
    max_selections: 1,
    identity_policy: "browser",
    scoring_rule: JSON.stringify({ kind: "ballot_share_percent", scale: 100, decimals: 2 }),
    status: "closed",
    revision: 1,
    opened_at: "2026-10-27T09:00:00Z",
    closed_at: "2026-10-27T09:30:00Z",
  }).execute();
  for (const [index, count] of [2, 1].entries()) {
    const optionId = `${sessionId}-option-${index}`;
    await db.insertInto("vote_option").values({
      id: optionId,
      activity_id: activityId,
      session_id: sessionId,
      candidate_id: `candidate-${index}`,
      ordinal: index,
    }).execute();
    for (let ballot = 0; ballot < count; ballot += 1) {
      const ballotId = `${sessionId}-ballot-${index}-${ballot}`;
      await db.insertInto("ballot").values({
        id: ballotId,
        activity_id: activityId,
        session_id: sessionId,
        identity_type: "browser",
        identity_digest: `digest-${index}-${ballot}`,
        ticket_id: null,
        submitted_at: "2026-10-27T09:10:00Z",
      }).execute();
      await db.insertInto("vote_record").values({
        id: `${sessionId}-record-${index}-${ballot}`,
        activity_id: activityId,
        session_id: sessionId,
        ballot_id: ballotId,
        option_id: optionId,
      }).execute();
    }
  }
  return { activityId, sessionId, publicCode };
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

describe.skipIf(!connectionString)("vote-result routes", () => {
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
      username: "vote-result-ops",
      passwordDigest: hashPassword("vote-result-password"),
      actor: {
        actorId: "vote-result-ops",
        actorType: "user",
        roles: ["staff"],
        permissions: ["result.manage"],
      },
      active: true,
    });
    await insertLocalAccount(db, {
      username: "vote-result-participant",
      passwordDigest: hashPassword("participant-password"),
      actor: { actorId: "vote-result-participant", actorType: "user", roles: [], permissions: [] },
      active: true,
    });
    resultToken = await login("vote-result-ops", "vote-result-password");
    participantToken = await login("vote-result-participant", "participant-password");
  });

  afterAll(async () => {
    if (!connectionString) return;
    await closeDb(db);
    await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
    await admin.end();
  });

  it("previews, confirms, releases, and serves the vote result", async () => {
    const { activityId, sessionId, publicCode } = await seed();
    const headers = {
      "content-type": "application/json",
      authorization: `Bearer ${resultToken}`,
    };
    const preview = await app.inject({
      method: "GET",
      url: `/api/activities/${activityId}/publishing/vote-results/${sessionId}`,
      headers,
    });
    expect(preview.statusCode).toBe(200);
    const candidate = preview.json() as {
      sessionRevision: number;
      inputFingerprint: string;
      decisions: { rank: number; score: string }[];
    };
    expect(candidate.decisions.map((item) => item.score)).toEqual(["66.67", "33.33"]);

    const confirmed = await app.inject({
      method: "POST",
      url: `/api/activities/${activityId}/publishing/stage-results/vote_result/confirm-vote`,
      headers: { ...headers, "idempotency-key": "vote-confirm-api" },
      payload: {
        scope: "publishing",
        voteSessionId: sessionId,
        expectedSessionRevision: candidate.sessionRevision,
        expectedInputFingerprint: candidate.inputFingerprint,
        awards: [],
      },
    });
    expect(confirmed.statusCode).toBe(201);
    const stage = confirmed.json() as { candidateRevision: number };

    const released = await app.inject({
      method: "POST",
      url: `/api/activities/${activityId}/publishing/releases`,
      headers: { ...headers, "idempotency-key": "vote-release-api" },
      payload: {
        stageKey: "vote_result",
        scope: "publishing",
        expectedCandidateRevision: stage.candidateRevision,
        note: "公示",
      },
    });
    expect(released.statusCode).toBe(201);

    const publicRead = await app.inject({
      method: "GET",
      url: `/api/public/results/${publicCode}`,
    });
    expect(publicRead.statusCode).toBe(200);
    const body = publicRead.json() as {
      results: { decisions: { rank: number; unit?: string }[] }[];
    };
    expect(body.results[0]?.decisions[0]).toMatchObject({ rank: 1, unit: "percent" });
  });

  it("rejects a caller without result.manage", async () => {
    const { activityId, sessionId } = await seed();
    const response = await app.inject({
      method: "GET",
      url: `/api/activities/${activityId}/publishing/vote-results/${sessionId}`,
      headers: { authorization: `Bearer ${participantToken}` },
    });
    expect(response.statusCode).toBe(403);
  });
});
