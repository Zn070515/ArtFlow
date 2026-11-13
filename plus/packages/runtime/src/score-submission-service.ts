import type {
  Database,
  StoredScoreFact,
} from "@artflow-plus/db";
import {
  getScoreFactForUpdate,
  insertScoreFact,
  updateRound,
} from "@artflow-plus/db";
import type {
  ScoreSource,
} from "@artflow-plus/domain";
import {
  DomainError,
  normalizeScoreSubmission,
  scoreFactKey,
} from "@artflow-plus/domain";
import type { Kysely } from "kysely";

import { executeCommand, type CommandOutcome } from "./command.js";
import { runtimeActor, type RuntimeDeps } from "./deps.js";
import { appendEngineEvent } from "./events.js";
import {
  idFromCommand,
} from "./hash.js";


import {
  loadScoreContext,
  requireStaffScorePermission,
  requireReason,
  result,
  type ScoreContextInput,
  type ScoreFactResult,
} from "./score-shared.js";

export interface SubmitJudgeScoreInput extends ScoreContextInput {}

export interface SubmitRapidScoreInput extends ScoreContextInput {}

export interface SubmitProxyScoreInput extends ScoreContextInput {
  readonly sourceReference: string;
  readonly reason: string;
}

export interface SubmitPaperScoreInput extends ScoreContextInput {
  readonly sourceReference: string;
  readonly reason: string;
}


async function submitScore(
  db: Kysely<Database>,
  deps: RuntimeDeps,
  input: ScoreContextInput,
  source: ScoreSource,
  sourceReference?: string,
  reason?: string,
): Promise<CommandOutcome<ScoreFactResult>> {
  const actor = runtimeActor(deps);
  const commandType = `competition.score.${source}`;
  if (source !== "direct_judge") requireStaffScorePermission(actor);
  if (source === "staff_proxy" || source === "paper_dr") {
    requireReason(sourceReference, "SOURCE_REFERENCE_REQUIRED", "sourceReference");
    requireReason(reason, "CORRECTION_REQUIRED", "reason");
  }
  return executeCommand(db, {
    commandId: input.commandId,
    activityId: input.activityId,
    capability: "competition",
    commandType,
    scope: input.scope,
    actor,
    payload: {
      roundId: input.roundId,
      performanceId: input.performanceId,
      panelSnapshotId: input.panelSnapshotId,
      seatId: input.seatId,
      contextVersion: input.contextVersion,
      criteria: input.criteria,
      notes: input.notes ?? "",
      source,
      sourceReference: sourceReference ?? null,
      reason: reason ?? null,
    },
  }, async (trx) => {
    const context = await loadScoreContext(trx, input, false, commandType, source === "direct_judge" ? deps.judgeSessionToken : undefined, deps.now());
    if (source === "direct_judge" && context.judgeSessionSeatId === undefined && actor.actorId !== context.judgeId) {
      throw new DomainError("FORBIDDEN", "The judge actor does not own this seat.");
    }
    const normalized = normalizeScoreSubmission({ criteria: input.criteria, notes: input.notes ?? "" }, context.rubric);
    const existing = await getScoreFactForUpdate(
      trx,
      context.round.id,
      context.contestantId,
      context.judgeId,
      context.mode,
    );
    if (existing !== null) {
      if (existing.contextVersion !== context.contextVersion || existing.panelSnapshotId !== context.panelId) {
        throw new DomainError("STALE_CONTEXT", "The existing score fact belongs to a stale performance context.");
      }
      throw new DomainError("DUPLICATE_SCORE_FACT", "This judge already has a score fact for the performance.");
    }
    const fact: StoredScoreFact = {
      id: idFromCommand("score", `${scoreFactKey(context.round.id, context.contestantId, context.judgeId)}:${context.contextVersion}:${context.mode}`),
      activityId: context.activity.id,
      roundId: context.round.id,
      performanceId: context.performanceId,
      contestantId: context.contestantId,
      judgeId: context.judgeId,
      panelSnapshotId: context.panelId,
      seatId: input.seatId,
      source,
      mode: context.mode,
      total: normalized.total,
      criteria: normalized.criteria,
      notes: normalized.notes,
      version: 1,
      contextVersion: context.contextVersion,
      current: true,
    };
    await insertScoreFact(trx, fact);
    const savedRound = await updateRound(trx, {
      ...context.round,
      revision: context.round.revision + 1,
      scoreVersion: context.round.scoreVersion + 1,
    }, context.round.revision);
    await appendEngineEvent(trx, deps, {
      type: "ScoreFactRecorded",
      activityId: context.activity.id,
      aggregateType: "score_fact",
      aggregateId: fact.id,
      revision: savedRound.revision,
      capability: "competition",
      mode: context.mode,
      scope: context.scope,
      payload: { scoreFact: result(fact), sourceReference: sourceReference ?? null, reason: reason ?? null, sourceScoreVersion: savedRound.scoreVersion },
    });
    return { body: result(fact), status: 201 };
  });
}

export async function submitJudgeScore(db: Kysely<Database>, deps: RuntimeDeps, input: SubmitJudgeScoreInput): Promise<CommandOutcome<ScoreFactResult>> {
  return submitScore(db, deps, input, "direct_judge");
}

export async function submitRapidScore(db: Kysely<Database>, deps: RuntimeDeps, input: SubmitRapidScoreInput): Promise<CommandOutcome<ScoreFactResult>> {
  return submitScore(db, deps, input, "staff_rapid");
}

export async function submitProxyScore(db: Kysely<Database>, deps: RuntimeDeps, input: SubmitProxyScoreInput): Promise<CommandOutcome<ScoreFactResult>> {
  return submitScore(db, deps, input, "staff_proxy", input.sourceReference, input.reason);
}

export async function submitPaperScore(db: Kysely<Database>, deps: RuntimeDeps, input: SubmitPaperScoreInput): Promise<CommandOutcome<ScoreFactResult>> {
  return submitScore(db, deps, input, "paper_dr", input.sourceReference, input.reason);
}
