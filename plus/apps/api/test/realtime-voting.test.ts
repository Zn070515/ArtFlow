import { randomUUID } from "node:crypto";

import {
  closeDb,
  createDb,
  insertLocalAccount,
  insertRelease,
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
import { createVotingRealtimeTopic } from "../src/realtime-topics.js";

const connectionString = process.env.ARTFLOW_PLUS_DATABASE_URL;
if (process.env.REQUIRE_DB === "1" && connectionString === undefined) {
  throw new Error("REQUIRE_DB=1 but ARTFLOW_PLUS_DATABASE_URL is unset.");
}
const schema = `artflow_api_realtime_${Date.now()}_${process.pid}`;

let app: FastifyInstance;
let db: Kysely<Database>;
let admin: Client;
let opsToken = "";
let participantToken = "";

const deps: RuntimeDeps = {
  now: () => new Date().toISOString(),
  newEventId: () => randomUUID(),
};

async function seed() {
  const activityId = `act-${randomUUID()}`;
  const sessionId = `vote-${randomUUID()}`;
  await db.insertInto("activity").values({
    id: activityId,
    public_code: activityId,
    title: "投票",
    status: "active",
    revision: 1,
    enabled_capabilities: JSON.stringify(["voting", "publishing"]),
    active_definition_version: 1,
  }).execute();
  await insertRelease(db, {
    activityId,
    version: 1,
    contentHash: "realtime-release",
    capabilities: {
      publishing: {
        ok: true,
        capabilityKey: "publishing",
        contentHash: "realtime-publishing",
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
    status: "open",
    revision: 0,
    opened_at: "2026-10-27T09:00:00Z",
    closed_at: null,
  }).execute();
  await db.insertInto("vote_option").values({
    id: `${sessionId}-option-0`,
    activity_id: activityId,
    session_id: sessionId,
    candidate_id: "alice",
    ordinal: 0,
  }).execute();
  await db.insertInto("live_state").values({
    activity_id: activityId,
    aggregate_type: "vote_session",
    aggregate_id: sessionId,
    last_sequence: 5,
    state: JSON.stringify({
      activityId,
      sessionId,
      status: "open",
      optionIds: [`${sessionId}-option-0`],
      counts: { [`${sessionId}-option-0`]: 3 },
      authoritative: false,
      lastEventType: "BallotSubmitted",
    }),
    status: "running",
  }).execute();
  return { activityId, sessionId };
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

describe.skipIf(!connectionString)("realtime voting integration", () => {
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
      username: "realtime-ops",
      passwordDigest: hashPassword("realtime-password"),
      actor: {
        actorId: "realtime-ops",
        actorType: "user",
        roles: ["staff"],
        permissions: ["voting.manage", "result.manage"],
      },
      active: true,
    });
    await insertLocalAccount(db, {
      username: "realtime-participant",
      passwordDigest: hashPassword("participant-password"),
      actor: { actorId: "realtime-participant", actorType: "user", roles: [], permissions: [] },
      active: true,
    });
    opsToken = await login("realtime-ops", "realtime-password");
    participantToken = await login("realtime-participant", "participant-password");
  });

  afterAll(async () => {
    if (!connectionString) return;
    await app.close();
    await closeDb(db);
    await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
    await admin.end();
  });

  it("returns the voting snapshot over REST", async () => {
    const { activityId, sessionId } = await seed();
    const response = await app.inject({
      method: "GET",
      url: `/api/activities/${activityId}/voting/sessions`,
      headers: { authorization: `Bearer ${opsToken}` },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json() as {
      sessions: { id: string; live: { seq: number; counts: Record<string, number> } | null }[];
    };
    expect(body.sessions[0]).toMatchObject({
      id: sessionId,
      live: { seq: 5, counts: { [`${sessionId}-option-0`]: 3 } },
    });
  });

  it("authorizes the voting topic and builds a monotonic snapshot", async () => {
    const { activityId } = await seed();
    const topic = createVotingRealtimeTopic(db);
    const target = topic.parse(`voting:${activityId}`);
    expect(target).toEqual({ activityId, aggregateId: activityId });
    const realtimeTarget = { topic: `voting:${activityId}`, ...target! };
    expect(
      await topic.authorize({ actorId: "x", roles: [], permissions: [] }, realtimeTarget),
    ).toBe(false);
    expect(
      await topic.authorize(
        { actorId: "x", roles: [], permissions: ["voting.manage"] },
        realtimeTarget,
      ),
    ).toBe(true);
    const snapshot = await topic.snapshot(realtimeTarget);
    expect(snapshot?.seq).toBeGreaterThanOrEqual(5);
    expect(snapshot?.data).toMatchObject({ activityId });
  });

  it("uses the newest global event sequence across sessions", async () => {
    const { activityId } = await seed();
    const secondSession = `vote-${randomUUID()}`;
    await db.insertInto("vote_session").values({
      id: secondSession,
      activity_id: activityId,
      definition_version: 1,
      mode: "formal",
      purpose: "popularity",
      selection_type: "single",
      max_selections: 1,
      identity_policy: "browser",
      scoring_rule: JSON.stringify({ kind: "ballot_share_percent", scale: 100, decimals: 2 }),
      status: "open",
      revision: 0,
      opened_at: "2026-10-27T09:05:00Z",
      closed_at: null,
    }).execute();
    // lastSequence is the global bigserial outbox id, so a newer session's
    // events always carry a larger value than an older session's.
    await db.insertInto("live_state").values({
      activity_id: activityId,
      aggregate_type: "vote_session",
      aggregate_id: secondSession,
      last_sequence: 9,
      state: JSON.stringify({
        activityId,
        sessionId: secondSession,
        status: "open",
        optionIds: [],
        counts: {},
        authoritative: false,
        lastEventType: "VoteSessionOpened",
      }),
      status: "running",
    }).execute();

    const topic = createVotingRealtimeTopic(db);
    const target = { topic: `voting:${activityId}`, activityId, aggregateId: activityId };
    const snapshot = await topic.snapshot(target);
    expect(snapshot?.seq).toBe(9);
    expect(
      (snapshot?.data as { sessions: { id: string }[] }).sessions.map((session) => session.id),
    ).toContain(secondSession);
  });

  it("returns the declared publishing stages in the state read", async () => {
    const { activityId } = await seed();
    const response = await app.inject({
      method: "GET",
      url: `/api/activities/${activityId}/publishing/state`,
      headers: { authorization: `Bearer ${opsToken}` },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ stages: [{ key: "vote_result", label: "投票结果" }] });
  });

  it("rejects a non-voting caller on the session list", async () => {
    const { activityId } = await seed();
    const response = await app.inject({
      method: "GET",
      url: `/api/activities/${activityId}/voting/sessions`,
      headers: { authorization: `Bearer ${participantToken}` },
    });
    expect(response.statusCode).toBe(403);
  });
});
