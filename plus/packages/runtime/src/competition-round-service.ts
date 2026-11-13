import type {
  Database,
  StoredRound,
} from "@artflow-plus/db";
import {
  getActivityForUpdate,
  getPerformanceScoreStateForUpdate,
  getRoundByKeyForUpdate,
  getRoundForUpdate,
  getRosterForUpdate,
  insertRound,
  listRoundPerformances,
  updateRound,
} from "@artflow-plus/db";
import type {
  ExecutionMode,
} from "@artflow-plus/domain";
import {
  DomainError,
  requireFinalRoster,
} from "@artflow-plus/domain";
import type { Kysely } from "kysely";

import { executeCommand, type CommandOutcome } from "./command.js";
import { runtimeActor, type RuntimeDeps } from "./deps.js";
import { appendEngineEvent } from "./events.js";
import {
  idFromCommand,
} from "./hash.js";
import { requireNoFormalFacts } from "./mode-guard.js";
import { requireNoConsumedRound } from "./result-consumption.js";


import {
  requireActive,
  requireCompetitionArtifact,
  requireRoundForActivity,
  requireRoundPreparePermission,
  requireSetupPermission,
  roundConfig,
  runningSession,
} from "./competition-shared.js";

export interface PrepareCompetitionRoundInput {
  readonly commandId: string;
  readonly activityId: string;
  readonly roundKey: string;
  readonly scope: string;
}

export interface PreparedCompetitionRound extends StoredRound {
  readonly scope: string;
  readonly mode: ExecutionMode;
  readonly participantCount: number;
  readonly rosterRevision: number;
}

export async function prepareCompetitionRound(
  db: Kysely<Database>,
  deps: RuntimeDeps,
  input: PrepareCompetitionRoundInput,
): Promise<CommandOutcome<PreparedCompetitionRound>> {
  const actor = runtimeActor(deps);
  return executeCommand(
    db,
    {
      commandId: input.commandId,
      activityId: input.activityId,
      capability: "competition",
      commandType: "competition.round.prepare",
      scope: input.scope,
      actor,
      payload: { roundKey: input.roundKey, scope: input.scope },
    },
    async (trx) => {
      requireRoundPreparePermission(actor);
      const activity = await getActivityForUpdate(trx, input.activityId);
      if (activity === null) throw new DomainError("NOT_FOUND", `Activity ${input.activityId} was not found.`);
      requireActive(activity);
      const roster = requireFinalRoster(await getRosterForUpdate(trx, input.activityId));
      const { release, session } = await runningSession(trx, activity, "competition.round.prepare", input.scope);
      const artifact = requireCompetitionArtifact(activity, release);
      const config = roundConfig(artifact, input.roundKey);
      const existing = await getRoundByKeyForUpdate(trx, input.activityId, input.roundKey);
      if (existing !== null) throw new DomainError("ROUND_ALREADY_PREPARED", `Round ${input.roundKey} is already prepared.`);
      const round: StoredRound = {
        id: idFromCommand("round", `${input.activityId}:${input.roundKey}`),
        activityId: input.activityId,
        roundKey: input.roundKey,
        releaseVersion: release.version,
        state: "prepared",
        revision: 0,
        scoreVersion: 0,
        minimumJudges: config.minimumJudges,
        judgeCount: config.judgeCount,
        completionMode: config.completion,
        advanceCount: config.advanceCount ?? 0,
        currentPanelId: null,
        lockedAt: null,
      };
      await insertRound(trx, round);
      const body: PreparedCompetitionRound = {
        ...round,
        scope: input.scope,
        mode: session.mode,
        participantCount: roster.approvedCount,
        rosterRevision: roster.revision,
      };
      await appendEngineEvent(trx, deps, {
        type: "CompetitionRoundPrepared",
        activityId: input.activityId,
        aggregateType: "competition_round",
        aggregateId: round.id,
        revision: round.revision,
        capability: "competition",
        mode: session.mode,
        scope: session.scope,
        payload: body,
      });
      return { body, status: 201 };
    },
  );
}

export interface LockRoundInput {
  readonly commandId: string;
  readonly activityId: string;
  readonly roundId: string;
  readonly expectedRevision: number;
  readonly scope: string;
}

export async function lockRound(
  db: Kysely<Database>,
  deps: RuntimeDeps,
  input: LockRoundInput,
): Promise<CommandOutcome<StoredRound>> {
  const actor = runtimeActor(deps);
  return executeCommand(db, {
    commandId: input.commandId,
    activityId: input.activityId,
    capability: "competition",
    commandType: "competition.round.lock",
    scope: input.scope,
    actor,
    payload: { roundId: input.roundId, expectedRevision: input.expectedRevision, scope: input.scope },
  }, async (trx) => {
    requireSetupPermission(actor);
    const activity = await getActivityForUpdate(trx, input.activityId);
    if (activity === null) throw new DomainError("NOT_FOUND", `Activity ${input.activityId} was not found.`);
    requireActive(activity);
    const round = requireRoundForActivity(await getRoundForUpdate(trx, input.roundId), input.activityId);
    const { session } = await runningSession(trx, activity, "competition.round.lock", input.scope);
    await requireNoFormalFacts(trx, round.id, session.mode);
    if (round.revision !== input.expectedRevision) throw new DomainError("STALE_REVISION", "The round changed since it was read.");
    if (round.state !== "scoring") throw new DomainError("ROUND_LOCKED", "The round is not scoring.");
    const performances = await listRoundPerformances(trx, round.id);
    if (performances.length === 0) throw new DomainError("NO_PERFORMANCES", "The round has no performances.");
    for (const performance of performances) {
      const state = await getPerformanceScoreStateForUpdate(trx, performance.id);
      if (state === null || state.state !== "locked" || performance.state !== "locked") {
        throw new DomainError("PERFORMANCE_SCORE_OPEN", "Every performance score gate must be locked before the round can lock.");
      }
    }
    const saved = await updateRound(trx, {
      ...round,
      state: "locked",
      revision: round.revision + 1,
      lockedAt: deps.now(),
    }, input.expectedRevision);
    await appendEngineEvent(trx, deps, {
      type: "RoundLocked",
      activityId: activity.id,
      aggregateType: "competition_round",
      aggregateId: round.id,
      revision: saved.revision,
      capability: "competition",
      mode: session.mode,
      scope: session.scope,
      payload: { round: saved },
    });
    return { body: saved };
  });
}

export interface ReopenRoundForCorrectionInput {
  readonly commandId: string;
  readonly activityId: string;
  readonly roundId: string;
  readonly expectedRevision: number;
  readonly scope: string;
  readonly reason: string;
}

/**
 * Reopens only the round gate. Performance facts remain locked and can only be
 * changed through the existing score-correction protocol. The result-consumer
 * check is deliberately inside the activity/round transaction so publishing
 * unlock and score correction cannot race into a stale confirmed result.
 */
export async function reopenRoundForCorrection(
  db: Kysely<Database>,
  deps: RuntimeDeps,
  input: ReopenRoundForCorrectionInput,
): Promise<CommandOutcome<StoredRound>> {
  const actor = runtimeActor(deps);
  return executeCommand(db, {
    commandId: input.commandId,
    activityId: input.activityId,
    capability: "competition",
    commandType: "competition.round.reopen_correction",
    scope: input.scope,
    actor,
    payload: {
      roundId: input.roundId,
      expectedRevision: input.expectedRevision,
      scope: input.scope,
      reason: input.reason,
    },
  }, async (trx) => {
    requireSetupPermission(actor);
    if (!input.reason.trim()) {
      throw new DomainError("CORRECTION_REQUIRED", "A reason is required to reopen a round for correction.");
    }
    const activity = await getActivityForUpdate(trx, input.activityId);
    if (activity === null) throw new DomainError("NOT_FOUND", `Activity ${input.activityId} was not found.`);
    requireActive(activity);
    const round = requireRoundForActivity(await getRoundForUpdate(trx, input.roundId), input.activityId);
    if (round.revision !== input.expectedRevision) {
      throw new DomainError("STALE_REVISION", "The round changed since it was read.");
    }
    if (round.state !== "locked") {
      throw new DomainError("INVALID_TRANSITION", "Only a locked round can be reopened for correction.");
    }
    const { session } = await runningSession(
      trx,
      activity,
      // Existing frozen releases already authorize the same judging seam as
      // score correction. Reuse that binding so adding this audited command
      // does not make an activity with a prepared/locked round uncorrectable;
      // new releases also expose the dedicated command above.
      "competition.score.correction.open",
      input.scope,
    );
    if (session.mode !== "formal") {
      throw new DomainError("FORMAL_MODE_REQUIRED", "Only formal rounds can be reopened for correction.");
    }
    if (session.definitionVersion !== round.releaseVersion) {
      throw new DomainError("STALE_CONTEXT", "The execution session is not bound to this round release.");
    }
    await requireNoConsumedRound(
      trx,
      activity.id,
      round.id,
      "RESULT_CONSUMED",
      "A confirmed result consumed this round; unlock the result before correcting it.",
    );
    const saved = await updateRound(trx, {
      ...round,
      state: "scoring",
      revision: round.revision + 1,
      lockedAt: null,
    }, input.expectedRevision);
    await appendEngineEvent(trx, deps, {
      type: "CompetitionRoundReopenedForCorrection",
      activityId: activity.id,
      aggregateType: "competition_round",
      aggregateId: round.id,
      revision: saved.revision,
      capability: "competition",
      mode: session.mode,
      scope: session.scope,
      payload: {
        roundId: round.id,
        reason: input.reason.trim(),
        operatorId: actor.actorId,
        expectedRevision: input.expectedRevision,
        revision: saved.revision,
        round: saved,
      },
    });
    return { body: saved };
  });
}
