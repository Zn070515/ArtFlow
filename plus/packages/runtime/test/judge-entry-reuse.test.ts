import { randomUUID } from "node:crypto";

import {
  closeDb,
  createDb,
  insertRelease,
  insertSession,
  migrate,
} from "@artflow-plus/db";
import type { Database } from "@artflow-plus/db";
import { SYSTEM_ACTOR } from "@artflow-plus/domain";
import type { ActorContext } from "@artflow-plus/domain";
import type { Kysely } from "kysely";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  activateCompetitionPanel,
  authenticateJudgeSession,
  capabilityCredential,
  claimJudgeSeat,
  prepareCompetitionRound,
} from "../src/index.js";
import type { RuntimeDeps } from "../src/index.js";

const connectionString = process.env.ARTFLOW_PLUS_DATABASE_URL;
if (process.env.REQUIRE_DB === "1" && connectionString === undefined) {
  throw new Error("REQUIRE_DB=1 but ARTFLOW_PLUS_DATABASE_URL is unset.");
}
const schema = `artflow_judge_entry_reuse_${Date.now()}_${process.pid}`;

let db: Kysely<Database>;
let admin: Client;
let tick = 0;
const credentialSecret = "judge-entry-reuse-secret";

const staff: ActorContext = {
  actorId: "judge-entry-staff",
  actorType: "user",
  roles: ["staff"],
  permissions: ["competition.manage", "competition.round.prepare"],
};

function deps(): RuntimeDeps {
  return {
    actor: staff,
    credentialSecret,
    now: () => new Date(Date.UTC(2026, 9, 26, 14, 0, tick++)).toISOString(),
    newEventId: () => `judge-entry-${randomUUID()}`,
  };
}

function publicDeps(): RuntimeDeps {
  return { ...deps(), actor: SYSTEM_ACTOR };
}

const competitionArtifact = {
  order: ["roster", "semi", "final", "result"],
  nodes: [
    { key: "roster", type: "roster" },
    { key: "semi", type: "round" },
    { key: "final", type: "round" },
    { key: "result", type: "output" },
  ],
  edges: [
    { from: "roster", to: "semi" },
    { from: "semi", to: "final" },
    { from: "final", to: "result" },
  ],
  rounds: [
    { key: "semi", judgeCount: 1, minimumJudges: 1, completion: "minimum_valid", advanceCount: 1, scoringMethod: "average" },
    { key: "final", judgeCount: 1, minimumJudges: 1, completion: "minimum_valid", advanceCount: 1, scoringMethod: "average" },
  ],
  rubric: { criteria: [{ key: "total", weight: 1, maximum: 100, minimum: 0 }] },
  tiePolicy: "review",
};

async function seedActivity(): Promise<string> {
  const activityId = `judge-entry-${randomUUID()}`;
  await db.insertInto("activity").values({
    id: activityId,
    public_code: activityId,
    title: "Judge entry reuse",
    status: "active",
    revision: 1,
    enabled_capabilities: JSON.stringify(["competition", "ticketing"]),
    active_definition_version: 1,
  }).execute();
  await insertRelease(db, {
    activityId,
    version: 1,
    contentHash: "judge-entry-release",
    capabilities: {
      competition: {
        ok: true,
        capabilityKey: "competition",
        contentHash: "judge-entry-competition",
        artifact: competitionArtifact,
      },
      ticketing: {
        ok: true,
        capabilityKey: "ticketing",
        contentHash: "judge-entry-ticketing",
        artifact: { schemaVersion: 1 },
      },
    },
    executionPolicy: { declaredScopes: ["judging"], conflicts: {}, runtimeContractVersion: 1 },
    capabilityVersions: { competition: "1", ticketing: "1" },
    bindings: [],
    releasedAt: "2026-10-26T13:00:00Z",
    sourceDraftRevision: 1,
  });
  await insertSession(db, {
    id: `session-${activityId}`,
    activityId,
    definitionVersion: 1,
    contentHash: "judge-entry-release",
    scope: "judging",
    mode: "formal",
    status: "running",
    revision: 0,
  }, "2026-10-26T13:30:00Z");
  await db.insertInto("roster").values({
    activity_id: activityId,
    status: "final",
    approved_count: 1,
    revision: 1,
    finalized_at: "2026-10-26T13:45:00Z",
    updated_at: new Date(),
  }).execute();
  await db.insertInto("registration").values({
    id: `registration-${activityId}`,
    activity_id: activityId,
    participant_id: "contestant-1",
    questionnaire_version: "v1",
    questionnaire_hash: "questionnaire-hash",
    status: "approved",
    answers: JSON.stringify({}),
    revision: 1,
    review_note: "",
    reviewed_by: "staff",
    created_at: new Date(),
    updated_at: new Date(),
  }).execute();
  return activityId;
}

describe.skipIf(!connectionString)("judge entry seat reuse", () => {
  beforeAll(async () => {
    if (!connectionString) return;
    admin = new Client({ connectionString });
    await admin.connect();
    await admin.query(`CREATE SCHEMA "${schema}"`);
    db = createDb({ connectionString, schema });
    await migrate(db);
  });

  afterAll(async () => {
    if (!connectionString) return;
    await closeDb(db);
    await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
    await admin.end();
  });

  it("revokes the old judge session and reopens the seat for the next panel", async () => {
    const activityId = await seedActivity();
    const semi = await prepareCompetitionRound(db, deps(), {
      commandId: "prepare-semi",
      activityId,
      roundKey: "semi",
      scope: "judging",
    });
    await activateCompetitionPanel(db, deps(), {
      commandId: "panel-semi",
      activityId,
      roundId: semi.body.id,
      scope: "judging",
      judges: [{ judgeId: "judge-a", seatKey: "seat-1" }],
    });

    const capability = capabilityCredential("J", activityId, 1, credentialSecret);
    const claimed = await claimJudgeSeat(db, publicDeps(), {
      commandId: "claim-semi",
      publicCode: activityId,
      capability,
    });
    expect(claimed.body.seatKey).toBe("seat-1");
    const firstToken = claimed.body.sessionToken ?? "";
    const authenticationTime = new Date("2026-10-26T14:00:10Z");
    await expect(authenticateJudgeSession(db, firstToken, authenticationTime)).resolves.toMatchObject({
      activityId,
      seatId: claimed.body.seatId,
    });

    const final = await prepareCompetitionRound(db, deps(), {
      commandId: "prepare-final",
      activityId,
      roundKey: "final",
      scope: "judging",
    });
    await activateCompetitionPanel(db, deps(), {
      commandId: "panel-final",
      activityId,
      roundId: final.body.id,
      scope: "judging",
      judges: [{ judgeId: "judge-b", seatKey: "seat-1" }],
    });

    await expect(authenticateJudgeSession(db, firstToken, authenticationTime)).rejects.toMatchObject({
      code: "UNAUTHENTICATED",
    });
    const grant = await db.selectFrom("judge_seat_grant").selectAll()
      .where("activity_id", "=", activityId)
      .where("seat_key", "=", "seat-1")
      .executeTakeFirstOrThrow();
    expect(grant.state).toBe("available");
    expect(grant.judge_id).toBeNull();

    const reclaimed = await claimJudgeSeat(db, publicDeps(), {
      commandId: "claim-final",
      publicCode: activityId,
      capability,
    });
    expect(reclaimed.body.seatKey).toBe("seat-1");
    expect(reclaimed.body.seatId).toBe(claimed.body.seatId);
  });
});
