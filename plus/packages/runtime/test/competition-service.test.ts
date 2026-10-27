import { COMPETITION_COMMAND_SCOPES } from "@artflow-plus/domain";
import { randomUUID } from "node:crypto";

import {
  closeDb,
  createDb,
  insertRelease,
  insertSession,
  migrate,
} from "@artflow-plus/db";
import type { Database } from "@artflow-plus/db";
import type { ActorContext } from "@artflow-plus/domain";
import type { Kysely } from "kysely";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  activateCompetitionPanel,
  lockPerformance,
  lockRound,
  openPerformance,
  prepareCompetitionRound,
} from "../src/index.js";
import type { RuntimeDeps } from "../src/index.js";

const connectionString = process.env.ARTFLOW_PLUS_DATABASE_URL;
if (process.env.REQUIRE_DB === "1" && connectionString === undefined) {
  throw new Error("REQUIRE_DB=1 but ARTFLOW_PLUS_DATABASE_URL is unset.");
}
const schema = `artflow_competition_runtime_${Date.now()}_${process.pid}`;

let db: Kysely<Database>;
let admin: Client;
let tick = 0;

const staff: ActorContext = {
  actorId: "competition-staff",
  actorType: "user",
  roles: ["staff"],
  permissions: ["competition.manage", "competition.round.prepare"],
};

function deps(actor: ActorContext = staff): RuntimeDeps {
  return {
    actor,
    now: () => new Date(Date.UTC(2026, 9, 19, 14, 0, tick++)).toISOString(),
    newEventId: () => `competition-${randomUUID()}`,
  };
}

const competitionArtifact = {
  order: ["roster", "final", "result"],
  nodes: [
    { key: "roster", type: "roster" },
    { key: "final", type: "round" },
    { key: "result", type: "output" },
  ],
  edges: [
    { from: "roster", to: "final" },
    { from: "final", to: "result" },
  ],
  rounds: [{ key: "final", judgeCount: 2, minimumJudges: 2, completion: "full_matrix", advanceCount: 1, scoringMethod: "average" }],
  rubric: { criteria: [{ key: "total", weight: 1, maximum: 100, minimum: 0 }] },
  tiePolicy: "review",
};

async function seedActivity(finalRoster = false): Promise<string> {
  const activityId = `activity-${randomUUID()}`;
  await db.insertInto("activity").values({
    id: activityId,
    title: "Competition runtime",
    status: "active",
    revision: 1,
    enabled_capabilities: JSON.stringify(["competition"]),
    active_definition_version: 1,
  }).execute();
  await insertRelease(db, {
    activityId,
    version: 1,
    contentHash: "competition-release",
    capabilities: {
      competition: {
        ok: true,
        capabilityKey: "competition",
        contentHash: "competition-content",
        artifact: competitionArtifact,
      },
    },
    executionPolicy: { declaredScopes: ["judging"], conflicts: {}, runtimeContractVersion: 2, commandScopes: COMPETITION_COMMAND_SCOPES },
    capabilityVersions: { competition: "1" },
    bindings: [],
    releasedAt: "2026-10-19T13:00:00Z",
    sourceDraftRevision: 1,
  });
  await insertSession(db, {
    id: `session-${activityId}`,
    activityId,
    definitionVersion: 1,
    contentHash: "competition-release",
    scope: "judging",
    mode: "formal",
    status: "running",
    revision: 0,
  }, "2026-10-19T13:30:00Z");
  if (finalRoster) {
    await db.insertInto("roster").values({
      activity_id: activityId,
      status: "final",
      approved_count: 2,
      revision: 1,
      finalized_at: "2026-10-19T13:45:00Z",
      updated_at: new Date(),
    }).execute();
    for (const participantId of ["contestant-1", "contestant-2"]) {
      await db.insertInto("registration").values({
        id: `registration-${activityId}-${participantId}`,
        activity_id: activityId,
        participant_id: participantId,
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
    }
  }
  return activityId;
}

describe.skipIf(!connectionString)("competition lifecycle commands on PostgreSQL", () => {
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

  it("prepares a configured round only after the roster is final", async () => {
    const activityId = await seedActivity();
    await expect(prepareCompetitionRound(db, deps(), {
      commandId: "prepare-before-roster",
      activityId,
      roundKey: "final",
      scope: "judging",
    })).rejects.toMatchObject({ code: "ROSTER_UNKNOWN" });

    await db.insertInto("roster").values({
      activity_id: activityId,
      status: "final",
      approved_count: 2,
      revision: 1,
      finalized_at: "2026-10-19T13:45:00Z",
      updated_at: new Date(),
    }).execute();
    const prepared = await prepareCompetitionRound(db, deps(), {
      commandId: "prepare-after-roster",
      activityId,
      roundKey: "final",
      scope: "judging",
    });
    expect(prepared.body).toMatchObject({ roundKey: "final", participantCount: 2, state: "prepared" });
    await expect(prepareCompetitionRound(db, deps(), {
      commandId: "prepare-duplicate",
      activityId,
      roundKey: "final",
      scope: "judging",
    })).rejects.toMatchObject({ code: "ROUND_ALREADY_PREPARED" });
  });

  it("activates one panel, opens a performance, and blocks the round while its gate is open", async () => {
    const activityId = await seedActivity(true);
    const prepared = await prepareCompetitionRound(db, deps(), {
      commandId: "prepare-lifecycle",
      activityId,
      roundKey: "final",
      scope: "judging",
    });
    const panel = await activateCompetitionPanel(db, deps(), {
      commandId: "activate-panel",
      activityId,
      roundId: prepared.body.id,
      scope: "judging",
      judges: [
        { judgeId: "judge-1", seatKey: "seat-1" },
        { judgeId: "judge-2", seatKey: "seat-2" },
      ],
    });
    expect(panel.body).toMatchObject({ version: 1, expectedJudges: 2, minimumJudges: 2, current: true });
    const opened = await openPerformance(db, deps(), {
      commandId: "open-performance",
      activityId,
      roundId: prepared.body.id,
      scope: "judging",
      contestantId: "contestant-1",
      sequence: 1,
    });
    expect(opened.body).toMatchObject({ contestantId: "contestant-1", state: "open", contextVersion: 1 });
    await expect(lockPerformance(db, deps(), {
      commandId: "lock-performance-too-early",
      activityId,
      roundId: prepared.body.id,
      performanceId: opened.body.id,
      scope: "judging",
    })).rejects.toMatchObject({ code: "SCORE_GATE_OPEN" });
    await expect(lockRound(db, deps(), {
      commandId: "lock-round-too-early",
      activityId,
      roundId: prepared.body.id,
      expectedRevision: 2,
      scope: "judging",
    })).rejects.toMatchObject({ code: "PERFORMANCE_SCORE_OPEN" });
  });

  it("binds performances to the final roster and reserves lifecycle commands for competition managers", async () => {
    const activityId = await seedActivity(true);
    const prepared = await prepareCompetitionRound(db, deps(), {
      commandId: "prepare-roster-boundary",
      activityId,
      roundKey: "final",
      scope: "judging",
    });
    await expect(activateCompetitionPanel(db, deps({
      ...staff,
      permissions: ["competition.round.prepare"],
    }), {
      commandId: "activate-panel-with-prepare-only",
      activityId,
      roundId: prepared.body.id,
      scope: "judging",
      judges: [
        { judgeId: "judge-1", seatKey: "seat-1" },
        { judgeId: "judge-2", seatKey: "seat-2" },
      ],
    })).rejects.toMatchObject({ code: "FORBIDDEN" });

    const panel = await activateCompetitionPanel(db, deps(), {
      commandId: "activate-roster-boundary-panel",
      activityId,
      roundId: prepared.body.id,
      scope: "judging",
      judges: [
        { judgeId: "judge-1", seatKey: "seat-1" },
        { judgeId: "judge-2", seatKey: "seat-2" },
      ],
    });
    await expect(openPerformance(db, deps(), {
      commandId: "open-not-approved-contestant",
      activityId,
      roundId: prepared.body.id,
      scope: "judging",
      contestantId: "not-approved",
      sequence: 1,
    })).rejects.toMatchObject({ code: "CONTESTANT_NOT_IN_ROSTER" });
    const count = await db.selectFrom("performance").select(({ fn }) => fn.countAll().as("count"))
      .where("round_id", "=", prepared.body.id).executeTakeFirstOrThrow();
    expect(Number(count.count)).toBe(0);
    const opened = await openPerformance(db, deps(), {
      commandId: "open-path-identified-performance",
      activityId,
      roundId: prepared.body.id,
      scope: "judging",
      performanceId: "path-performance-1",
      contestantId: "contestant-1",
      sequence: 1,
    });
    expect(opened.body.id).toBe("path-performance-1");
    await expect(openPerformance(db, deps(), {
      commandId: "open-path-identity-mismatch",
      activityId,
      roundId: prepared.body.id,
      scope: "judging",
      performanceId: "path-performance-2",
      contestantId: "contestant-1",
      sequence: 1,
    })).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(panel.body.current).toBe(true);
  });
});
