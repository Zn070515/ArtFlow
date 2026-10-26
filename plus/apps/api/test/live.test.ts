import { randomUUID } from "node:crypto";

import {
  closeDb,
  createDb,
  insertRegistration,
  insertRelease,
  migrate,
  upsertRoster,
} from "@artflow-plus/db";
import type { Database } from "@artflow-plus/db";
import type { ActorContext } from "@artflow-plus/domain";
import { stableHash } from "@artflow-plus/runtime";
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
const schema = `artflow_api_live_${Date.now()}_${process.pid}`;

let db: Kysely<Database>;
let admin: Client;
let app: FastifyInstance;
let activityId: string;
const judgeToken = `judge-token-${randomUUID()}`;

const staff: ActorContext = {
  actorId: "live-staff",
  actorType: "user",
  roles: ["staff"],
  permissions: ["competition.manage", "judge.manage"],
};
const deps: RuntimeDeps = {
  now: () => new Date().toISOString(),
  newEventId: () => randomUUID(),
};

const competition = {
  order: ["round-1"],
  nodes: [
    { key: "roster", type: "roster" },
    { key: "round-1", type: "round" },
    { key: "result", type: "output" },
  ],
  edges: [
    { from: "roster", to: "round-1" },
    { from: "round-1", to: "result" },
  ],
  rounds: [
    {
      key: "round-1",
      judgeCount: 1,
      minimumJudges: 1,
      completion: "minimum_valid",
      advanceCount: 1,
      scoringMethod: "average",
    },
  ],
  rubric: {
    criteria: [
      { key: "演唱技巧", weight: 1, maximum: 100, minimum: 0 },
      { key: "舞台表现", weight: 1, maximum: 100, minimum: 0 },
      { key: "情感表达", weight: 1, maximum: 100, minimum: 0 },
    ],
  },
  tiePolicy: "review",
};

describe.skipIf(!connectionString)("Live and judge context", () => {
  beforeAll(async () => {
    if (!connectionString) return;
    admin = new Client({ connectionString });
    await admin.connect();
    await admin.query(`CREATE SCHEMA "${schema}"`);
    db = createDb({ connectionString, schema });
    await migrate(db);
    app = await buildApp({ db, deps, actor: staff });
    await app.ready();

    activityId = `act-${randomUUID()}`;
    const roundId = `round-${randomUUID()}`;
    const panelId = `panel-${randomUUID()}`;
    const seatId = `seat-${randomUUID()}`;
    const grantId = `grant-${randomUUID()}`;
    const judgeSessionId = `judge-session-${randomUUID()}`;
    const performanceId = `performance-${randomUUID()}`;
    await db.insertInto("activity").values({
      id: activityId,
      public_code: activityId,
      title: "Live test",
      status: "active",
      revision: 1,
      enabled_capabilities: JSON.stringify(["competition"]),
      active_definition_version: 1,
    }).execute();
    await insertRelease(db, {
      activityId,
      version: 1,
      contentHash: "live-release",
      capabilities: {
        competition: {
          ok: true,
          capabilityKey: "competition",
          contentHash: "competition",
          artifact: competition,
        },
      },
      executionPolicy: { declaredScopes: ["judging"], conflicts: {}, runtimeContractVersion: 1 },
      capabilityVersions: { competition: "1" },
      bindings: [],
      releasedAt: "2026-10-26T10:00:00Z",
      sourceDraftRevision: 1,
    });
    await insertRegistration(db, {
      id: `reg-${activityId}`,
      activityId,
      participantId: "singer-a",
      questionnaireVersion: "v1",
      questionnaireHash: "v1",
      status: "approved",
      answers: {},
      revision: 1,
    });
    await upsertRoster(db, activityId, {
      status: "final",
      revision: 1,
      approvedCount: 1,
      finalizedAt: "2026-10-26T10:00:00Z",
    }, 0);
    await db.insertInto("competition_round").values({
      id: roundId,
      activity_id: activityId,
      round_key: "round-1",
      release_version: 1,
      state: "scoring",
      revision: 0,
      score_version: 0,
      minimum_judges: 1,
      judge_count: 1,
      completion_mode: "minimum_valid",
      scoring_method: "average",
      advance_count: 1,
      current_panel_id: panelId,
      locked_at: null,
    }).execute();
    await db.insertInto("panel_snapshot").values({
      id: panelId,
      activity_id: activityId,
      round_id: roundId,
      version: 1,
      state: "active",
      expected_judges: 1,
      minimum_judges: 1,
      roster_digest: "a".repeat(64),
      context_version: 1,
      current: true,
    }).execute();
    await db.insertInto("panel_member").values({
      panel_id: panelId,
      judge_id: "judge-e2e",
      seat_key: "seat-1",
    }).execute();
    await db.insertInto("judge_seat").values({
      id: seatId,
      panel_id: panelId,
      judge_id: "judge-e2e",
      state: "assigned",
      revision: 0,
    }).execute();
    await db.insertInto("performance").values({
      id: performanceId,
      activity_id: activityId,
      round_id: roundId,
      contestant_id: "singer-a",
      sequence: 1,
      state: "open",
      context_version: 1,
    }).execute();
    await db.insertInto("performance_score_state").values({
      performance_id: performanceId,
      state: "open",
      context_version: 1,
      revision: 0,
      opened_at: "2026-10-26T10:00:00Z",
      locked_at: null,
    }).execute();
    // The claim flow creates a judge-entry seat (judge_seat_grant) that the
    // session owns; its seat key maps back to the competition seat.
    await db.insertInto("judge_seat_grant").values({
      id: grantId,
      activity_id: activityId,
      seat_key: "seat-1",
      judge_id: "judge-e2e",
      state: "claimed",
      session_id: judgeSessionId,
      revision: 1,
    }).execute();
    await db.insertInto("judge_session").values({
      id: judgeSessionId,
      activity_id: activityId,
      seat_id: grantId,
      actor_id: "judge-e2e",
      token_digest: stableHash(judgeToken),
      expires_at: "2099-01-01T00:00:00Z",
      revoked_at: null,
    }).execute();
  });

  afterAll(async () => {
    if (!connectionString) return;
    await app.close();
    await closeDb(db);
    await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
    await admin.end();
  });

  it("returns the Live state with rounds, panel, performance, and roster", async () => {
    const response = await app.inject({ method: "GET", url: `/api/activities/${activityId}/live` });
    expect(response.statusCode).toBe(200);
    const body = response.json() as {
      config: { rounds: { key: string }[] };
      rounds: {
        round: { state: string };
        panel: { id: string };
        performances: { scoreCount: number; expectedJudges: number }[];
      }[];
      participantIds: string[];
    };
    expect(body.config.rounds.map((round) => round.key)).toEqual(["round-1"]);
    expect(body.rounds[0]?.round).toMatchObject({ state: "scoring" });
    expect(body.rounds[0]?.performances[0]).toMatchObject({ scoreCount: 0, expectedJudges: 1 });
    expect(body.participantIds).toEqual(["singer-a"]);
  });

  it("requires a judge session for the judge context", async () => {
    const missing = await app.inject({ method: "GET", url: "/api/judge/context" });
    expect(missing.statusCode).toBe(401);
    const context = await app.inject({
      method: "GET",
      url: "/api/judge/context",
      headers: { cookie: `artflow_judge_session=${judgeToken}` },
    });
    expect(context.statusCode).toBe(200);
    expect(context.json()).toMatchObject({
      seat: { judgeId: "judge-e2e", seatKey: "seat-1", state: "claimed" },
      round: { roundKey: "round-1" },
      performance: { contestantId: "singer-a", state: "open" },
      scoring: {
        judgeId: "judge-e2e",
        panelSnapshotId: expect.any(String),
        roundKey: "round-1",
        contextVersion: 1,
      },
      existingScore: null,
      rubric: { criteria: expect.arrayContaining([expect.objectContaining({ key: "演唱技巧" })]) },
    });
  });
});
