import { COMPETITION_COMMAND_SCOPES } from "@artflow-plus/domain";
import { randomUUID } from "node:crypto";

import { insertRelease, insertSession } from "@artflow-plus/db";
import type { Database } from "@artflow-plus/db";
import type { ActorContext } from "@artflow-plus/domain";
import type { Kysely } from "kysely";

import {
  activateCompetitionPanel,
  lockPerformance,
  lockRound,
  openPerformance,
  prepareCompetitionRound,
  submitJudgeScore,
} from "../../src/index.js";
import type { RuntimeDeps } from "../../src/index.js";

export interface RecoveryFixture {
  readonly activityId: string;
  readonly roundId: string;
  readonly panelId: string;
  readonly seatId: string;
}

let tick = 0;

export const recoveryStaff: ActorContext = {
  actorId: "resolution-staff",
  actorType: "user",
  roles: ["staff"],
  permissions: ["competition.manage", "competition.round.prepare"],
};
export const recoveryJudge: ActorContext = {
  actorId: "judge-1",
  actorType: "user",
  roles: ["judge"],
  permissions: [],
};

export function recoveryDeps(actor: ActorContext): RuntimeDeps {
  return {
    actor,
    now: () => new Date(Date.UTC(2026, 9, 19, 18, 0, tick++)).toISOString(),
    newEventId: () => `resolution-${randomUUID()}`,
  };
}

export async function seedLockedRound(
  db: Kysely<Database>,
  mode: "formal" | "rehearsal" = "formal",
): Promise<RecoveryFixture> {
  const activityId = `activity-${randomUUID()}`;
  await db.insertInto("activity").values({
    id: activityId,
    title: "Resolution runtime",
    status: "active",
    revision: 1,
    enabled_capabilities: JSON.stringify(["competition"]),
    active_definition_version: 1,
  }).execute();
  await insertRelease(db, {
    activityId,
    version: 1,
    contentHash: "resolution-release",
    capabilities: {
      competition: {
        ok: true,
        capabilityKey: "competition",
        contentHash: "resolution-content",
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
    contentHash: "resolution-release",
    scope: "judging",
    mode,
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
  const round = await prepareCompetitionRound(db, recoveryDeps(recoveryStaff), {
    commandId: `prepare-${activityId}`,
    activityId,
    roundKey: "final",
    scope: "judging",
  });
  const panel = await activateCompetitionPanel(db, recoveryDeps(recoveryStaff), {
    commandId: `panel-${activityId}`,
    activityId,
    roundId: round.body.id,
    scope: "judging",
    judges: [{ judgeId: recoveryJudge.actorId, seatKey: "seat-1" }],
  });
  const seat = await db.selectFrom("judge_seat").selectAll()
    .where("panel_id", "=", panel.body.id).where("judge_id", "=", recoveryJudge.actorId)
    .executeTakeFirstOrThrow();
  for (const [index, [contestantId, total]] of ([
    ["singer-a", 90],
    ["singer-b", 90],
    ["singer-c", 80],
  ] as const).entries()) {
    const performance = await openPerformance(db, recoveryDeps(recoveryStaff), {
      commandId: `open-${activityId}-${contestantId}`,
      activityId,
      roundId: round.body.id,
      scope: "judging",
      contestantId,
      sequence: index + 1,
    });
    await submitJudgeScore(db, recoveryDeps(recoveryJudge), {
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
    await lockPerformance(db, recoveryDeps(recoveryStaff), {
      commandId: `lock-${activityId}-${contestantId}`,
      activityId,
      roundId: round.body.id,
      performanceId: performance.body.id,
      scope: "judging",
    });
  }
  const currentRound = await db.selectFrom("competition_round").selectAll().where("id", "=", round.body.id).executeTakeFirstOrThrow();
  await lockRound(db, recoveryDeps(recoveryStaff), {
    commandId: `lock-round-${activityId}`,
    activityId,
    roundId: round.body.id,
    expectedRevision: currentRound.revision,
    scope: "judging",
  });
  return { activityId, roundId: round.body.id, panelId: panel.body.id, seatId: seat.id };
}
