import { COMPETITION_COMMAND_SCOPES } from "@artflow-plus/domain";
import type { ActorContext } from "@artflow-plus/domain";
import { insertRelease, insertSession } from "@artflow-plus/db";
import type { Database } from "@artflow-plus/db";
import {
  activateCompetitionPanel,
  lockPerformance,
  lockRound,
  openPerformance,
  prepareCompetitionRound,
  submitJudgeScore,
} from "@artflow-plus/runtime";
import type { RuntimeDeps } from "@artflow-plus/runtime";
import type { Kysely } from "kysely";
import { randomUUID } from "node:crypto";

export interface CompetitionReadFixture {
  readonly activityId: string;
  readonly roundId: string;
  readonly panelId: string;
  readonly seatId: string;
}

let tick = 0;

// The competition commands check permissions with exact membership, not the
// hasPermission "*" wildcard, so spell out what the seeding staff actor needs.
const staffActor: ActorContext = {
  actorId: "competition-read-staff",
  actorType: "user",
  roles: ["staff"],
  permissions: ["competition.manage", "competition.round.prepare"],
};
const judgeActor: ActorContext = {
  actorId: "competition-read-judge",
  actorType: "user",
  roles: ["judge"],
  permissions: [],
};

function deps(actor: ActorContext): RuntimeDeps {
  return {
    actor,
    now: () => new Date(Date.UTC(2026, 9, 19, 18, 0, tick++)).toISOString(),
    newEventId: () => `competition-read-${randomUUID()}`,
  };
}

/**
 * Seeds a locked formal round with three score facts so the read projection has
 * a session, a ranking, performances, and facts to return.
 */
export async function seedCompetitionReadFixture(
  db: Kysely<Database>,
): Promise<CompetitionReadFixture> {
  const activityId = `activity-${randomUUID()}`;
  await db.insertInto("activity").values({
    id: activityId,
    title: "Competition read",
    status: "active",
    revision: 1,
    enabled_capabilities: JSON.stringify(["competition"]),
    active_definition_version: 1,
  }).execute();
  await insertRelease(db, {
    activityId,
    version: 1,
    contentHash: "competition-read-release",
    capabilities: {
      competition: {
        ok: true,
        capabilityKey: "competition",
        contentHash: "competition-read-content",
        artifact: {
          order: ["roster", "final", "result"],
          nodes: [
            { key: "roster", type: "roster" },
            { key: "final", type: "round" },
            { key: "result", type: "output" },
          ],
          edges: [{ from: "roster", to: "final" }, { from: "final", to: "result" }],
          rounds: [{ key: "final", judgeCount: 1, minimumJudges: 1, completion: "minimum_valid", advanceCount: 1, scoringMethod: "average" }],
          rubric: { criteria: [{ key: "total", weight: 1, maximum: 100, minimum: 0 }] },
          tiePolicy: "review",
        },
      },
    },
    executionPolicy: { declaredScopes: ["judging"], conflicts: {}, runtimeContractVersion: 2, commandScopes: COMPETITION_COMMAND_SCOPES },
    capabilityVersions: { competition: "1" },
    bindings: [],
    releasedAt: "2026-10-19T17:00:00Z",
    sourceDraftRevision: 1,
  });
  await insertSession(db, {
    id: `session-${activityId}`,
    activityId,
    definitionVersion: 1,
    contentHash: "competition-read-release",
    scope: "judging",
    mode: "formal",
    status: "running",
    revision: 0,
  }, "2026-10-19T17:30:00Z");
  await db.insertInto("roster").values({
    activity_id: activityId,
    status: "final",
    approved_count: 3,
    revision: 1,
    finalized_at: "2026-10-19T17:45:00Z",
    updated_at: new Date(),
  }).execute();
  for (const contestantId of ["singer-a", "singer-b", "singer-c"]) {
    await db.insertInto("registration").values({
      id: `registration-${activityId}-${contestantId}`,
      activity_id: activityId,
      participant_id: contestantId,
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
  const round = await prepareCompetitionRound(db, deps(staffActor), {
    commandId: `prepare-${activityId}`,
    activityId,
    roundKey: "final",
    scope: "judging",
  });
  const panel = await activateCompetitionPanel(db, deps(staffActor), {
    commandId: `panel-${activityId}`,
    activityId,
    roundId: round.body.id,
    scope: "judging",
    judges: [{ judgeId: judgeActor.actorId, seatKey: "seat-1" }],
  });
  const seat = await db.selectFrom("judge_seat").selectAll()
    .where("panel_id", "=", panel.body.id).where("judge_id", "=", judgeActor.actorId)
    .executeTakeFirstOrThrow();
  for (const [index, [contestantId, total]] of ([
    ["singer-a", 90],
    ["singer-b", 90],
    ["singer-c", 80],
  ] as const).entries()) {
    const performance = await openPerformance(db, deps(staffActor), {
      commandId: `open-${activityId}-${contestantId}`,
      activityId,
      roundId: round.body.id,
      scope: "judging",
      contestantId,
      sequence: index + 1,
    });
    await submitJudgeScore(db, deps(judgeActor), {
      commandId: `score-${activityId}-${contestantId}`,
      activityId,
      roundId: round.body.id,
      performanceId: performance.body.id,
      panelSnapshotId: panel.body.id,
      seatId: seat.id,
      contextVersion: 1,
      criteria: { total },
      notes: "",
      scope: "judging",
    });
    await lockPerformance(db, deps(staffActor), {
      commandId: `lock-${activityId}-${contestantId}`,
      activityId,
      roundId: round.body.id,
      performanceId: performance.body.id,
      scope: "judging",
    });
  }
  const currentRound = await db.selectFrom("competition_round").selectAll()
    .where("id", "=", round.body.id).executeTakeFirstOrThrow();
  await lockRound(db, deps(staffActor), {
    commandId: `lock-round-${activityId}`,
    activityId,
    roundId: round.body.id,
    expectedRevision: currentRound.revision,
    scope: "judging",
  });
  return { activityId, roundId: round.body.id, panelId: panel.body.id, seatId: seat.id };
}
