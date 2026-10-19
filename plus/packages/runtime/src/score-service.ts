import type {
  Database,
  StoredScoreCorrection,
  StoredScoreFact,
  StoredRound,
} from "@artflow-plus/db";
import {
  findRunningSessionByScope,
  getActivityForUpdate,
  getCurrentPanelForUpdate,
  getCorrectionForUpdate,
  getJudgeSeatForUpdate,
  getOpenCorrectionForUpdate,
  getPerformanceForUpdate,
  getPerformanceScoreStateForUpdate,
  getRelease,
  getRoundForUpdate,
  getScoreFactByIdForUpdate,
  getScoreFactForUpdate,
  insertCorrection,
  insertScoreFact,
  insertScoreRevision,
  updateCorrection,
  updateScoreFact,
} from "@artflow-plus/db";
import type {
  ActorContext,
  CompiledCompetitionArtifact,
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
import { idFromCommand, stableHash } from "./hash.js";

interface ScoreActivity {
  readonly id: string;
  readonly status: string;
  readonly activeDefinitionVersion: number;
}

interface ScoreContextInput {
  readonly commandId: string;
  readonly activityId: string;
  readonly roundId: string;
  readonly performanceId: string;
  readonly panelSnapshotId: string;
  readonly seatId: string;
  readonly contextVersion: number;
  readonly criteria: Readonly<Record<string, number>>;
  readonly notes?: string;
  readonly scope: string;
}

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

export interface ScoreFactResult extends StoredScoreFact {
  readonly key: string;
}

interface LoadedScoreContext {
  readonly activity: ScoreActivity;
  readonly round: StoredRound;
  readonly panelId: string;
  readonly performanceId: string;
  readonly contestantId: string;
  readonly judgeId: string;
  readonly contextVersion: number;
  readonly performanceState: "not_opened" | "open" | "locked";
  readonly mode: "test" | "rehearsal" | "formal";
  readonly scope: string;
  readonly rubric: CompiledCompetitionArtifact["rubric"];
}

function requireActive(activity: ScoreActivity): void {
  if (activity.status !== "active") throw new DomainError("ACTIVITY_NOT_ACTIVE", "Scoring requires an active activity.");
}

function requireStaffScorePermission(actor: ActorContext): void {
  if (!actor.permissions.includes("competition.manage") && !actor.permissions.includes("competition.score.write")) {
    throw new DomainError("FORBIDDEN", "The actor cannot enter a staff score.");
  }
}

function requireReason(value: string | undefined, code: "SOURCE_REFERENCE_REQUIRED" | "CORRECTION_REQUIRED", label: string): string {
  if (value === undefined || !value.trim()) throw new DomainError(code, `${label} is required.`);
  return value.trim();
}

async function loadScoreContext(
  trx: Kysely<Database>,
  input: ScoreContextInput,
  allowLockedPerformance: boolean,
): Promise<LoadedScoreContext> {
  const activity = await getActivityForUpdate(trx, input.activityId);
  if (activity === null) throw new DomainError("NOT_FOUND", `Activity ${input.activityId} was not found.`);
  requireActive(activity);
  const round = await getRoundForUpdate(trx, input.roundId);
  if (round === null) throw new DomainError("NOT_FOUND", "The competition round was not found.");
  if (round.activityId !== activity.id) throw new DomainError("CROSS_ACTIVITY", "The round belongs to another activity.");
  if (round.state === "locked") throw new DomainError("ROUND_LOCKED", "The round is locked.");
  const panel = await getCurrentPanelForUpdate(trx, round.id);
  if (panel === null || panel.state !== "active" || !panel.current || panel.id !== input.panelSnapshotId) {
    throw new DomainError("PANEL_NOT_ACTIVE", "The submitted panel is not the current active panel.");
  }
  const performance = await getPerformanceForUpdate(trx, input.performanceId);
  if (performance === null) throw new DomainError("PERFORMANCE_NOT_SCORABLE", "The performance was not found.");
  if (performance.roundId !== round.id || performance.activityId !== activity.id) {
    throw new DomainError("CROSS_ACTIVITY", "The performance belongs to another round.");
  }
  const scoreState = await getPerformanceScoreStateForUpdate(trx, performance.id);
  if (scoreState === null || scoreState.contextVersion !== performance.contextVersion || scoreState.contextVersion !== input.contextVersion) {
    throw new DomainError("STALE_CONTEXT", "The performance context is stale.");
  }
  if (allowLockedPerformance) {
    if (performance.state === "not_opened" || scoreState.state !== performance.state) {
      throw new DomainError("PERFORMANCE_NOT_SCORABLE", "The performance score gate is not usable.");
    }
  } else if (performance.state !== "open" || scoreState.state !== "open") {
    throw new DomainError("PERFORMANCE_NOT_SCORABLE", "The performance score gate is not open.");
  }
  if (performance.contextVersion !== input.contextVersion) {
    throw new DomainError("STALE_CONTEXT", "The performance context is stale.");
  }
  const seat = await getJudgeSeatForUpdate(trx, input.seatId);
  if (seat === null || seat.panelId !== panel.id || seat.state !== "assigned") {
    throw new DomainError("STALE_CONTEXT", "The submitted seat is not assigned to the current panel.");
  }
  const release = await getRelease(trx, activity.id, round.releaseVersion);
  if (release === null) throw new DomainError("VERSION_NOT_RELEASED", "The round release is no longer available.");
  const plan = release.capabilities.competition;
  if (plan === undefined || plan.ok !== true) throw new DomainError("RELEASE_SNAPSHOT_INCOMPLETE", "The round has no competition rubric.");
  const session = await findRunningSessionByScope(trx, activity.id, input.scope);
  if (session === null) throw new DomainError("SESSION_NOT_RUNNING", `Scope ${input.scope} has no running execution session.`);
  if (session.definitionVersion !== round.releaseVersion) throw new DomainError("STALE_CONTEXT", "The execution session is not bound to this round release.");
  return {
    activity,
    round,
    panelId: panel.id,
    performanceId: performance.id,
    contestantId: performance.contestantId,
    judgeId: seat.judgeId,
    contextVersion: performance.contextVersion,
    performanceState: performance.state,
    mode: session.mode,
    scope: session.scope,
    rubric: (plan.artifact as CompiledCompetitionArtifact).rubric,
  };
}

function result(fact: StoredScoreFact): ScoreFactResult {
  return { ...fact, key: scoreFactKey(fact.roundId, fact.contestantId, fact.judgeId) };
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
  if (source !== "direct_judge") requireStaffScorePermission(actor);
  if (source === "staff_proxy" || source === "paper_dr") {
    requireReason(sourceReference, "SOURCE_REFERENCE_REQUIRED", "sourceReference");
    requireReason(reason, "CORRECTION_REQUIRED", "reason");
  }
  return executeCommand(db, {
    commandId: input.commandId,
    activityId: input.activityId,
    capability: "competition",
    commandType: `competition.score.${source}`,
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
    const context = await loadScoreContext(trx, input, false);
    if (source === "direct_judge" && actor.actorId !== context.judgeId) {
      throw new DomainError("FORBIDDEN", "The judge actor does not own this seat.");
    }
    const normalized = normalizeScoreSubmission({ criteria: input.criteria, notes: input.notes ?? "" }, context.rubric);
    const existing = await getScoreFactForUpdate(
      trx,
      context.round.id,
      context.contestantId,
      context.judgeId,
    );
    if (existing !== null) {
      if (existing.contextVersion !== context.contextVersion || existing.panelSnapshotId !== context.panelId) {
        throw new DomainError("STALE_CONTEXT", "The existing score fact belongs to a stale performance context.");
      }
      throw new DomainError("DUPLICATE_SCORE_FACT", "This judge already has a score fact for the performance.");
    }
    const fact: StoredScoreFact = {
      id: idFromCommand("score", scoreFactKey(context.round.id, context.contestantId, context.judgeId)),
      activityId: context.activity.id,
      roundId: context.round.id,
      performanceId: context.performanceId,
      contestantId: context.contestantId,
      judgeId: context.judgeId,
      panelSnapshotId: context.panelId,
      seatId: input.seatId,
      source,
      total: normalized.total,
      criteria: normalized.criteria,
      notes: normalized.notes,
      version: 1,
      contextVersion: context.contextVersion,
      current: true,
    };
    await insertScoreFact(trx, fact);
    await appendEngineEvent(trx, deps, {
      type: "ScoreFactRecorded",
      activityId: context.activity.id,
      aggregateType: "score_fact",
      aggregateId: fact.id,
      revision: fact.version,
      capability: "competition",
      mode: context.mode,
      scope: context.scope,
      payload: { scoreFact: result(fact), sourceReference: sourceReference ?? null, reason: reason ?? null },
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

export interface EditScoreFactInput {
  readonly commandId: string;
  readonly activityId: string;
  readonly roundId: string;
  readonly performanceId: string;
  readonly panelSnapshotId: string;
  readonly seatId: string;
  readonly contextVersion: number;
  readonly expectedVersion: number;
  readonly criteria: Readonly<Record<string, number>>;
  readonly reason: string;
  readonly scope: string;
  readonly correctionId?: string;
}

export async function editScoreFact(
  db: Kysely<Database>,
  deps: RuntimeDeps,
  input: EditScoreFactInput,
): Promise<CommandOutcome<ScoreFactResult>> {
  const actor = runtimeActor(deps);
  requireStaffScorePermission(actor);
  const reason = requireReason(input.reason, "CORRECTION_REQUIRED", "reason");
  return executeCommand(db, {
    commandId: input.commandId,
    activityId: input.activityId,
    capability: "competition",
    commandType: "competition.score.edit",
    scope: input.scope,
    actor,
    payload: { ...input, reason },
  }, async (trx) => {
    const context = await loadScoreContext(trx, input, true);
    const fact = await getScoreFactForUpdate(trx, context.round.id, context.contestantId, context.judgeId);
    if (fact === null) throw new DomainError("SCORE_FACT_NOT_FOUND", "The score fact was not found.");
    if (fact.contextVersion !== context.contextVersion || fact.panelSnapshotId !== context.panelId) {
      throw new DomainError("STALE_CONTEXT", "The score fact belongs to a stale performance context.");
    }
    if (fact.version !== input.expectedVersion) throw new DomainError("STALE_REVISION", "The score fact changed since it was read.");
    if (input.correctionId === undefined && context.performanceState !== "open") {
      throw new DomainError("SCORE_FACT_LOCKED", "A locked score requires an explicit correction.");
    }
    if (input.correctionId !== undefined && context.performanceState !== "locked") {
      throw new DomainError("CORRECTION_REQUIRED", "A correction must target a locked performance.");
    }
    if (input.correctionId === undefined && context.round.state !== "scoring") throw new DomainError("ROUND_LOCKED", "The round is locked.");
    let correction: StoredScoreCorrection | null = null;
    if (input.correctionId !== undefined) {
      correction = await getOpenCorrectionForUpdate(trx, fact.id);
      if (correction === null || correction.id !== input.correctionId || correction.baseVersion !== fact.version) {
        throw new DomainError("CORRECTION_REQUIRED", "The correction is not open for this fact version.");
      }
    }
    const normalized = normalizeScoreSubmission({ criteria: input.criteria, notes: fact.notes }, context.rubric);
    await insertScoreRevision(trx, {
      id: idFromCommand("score-revision", input.commandId),
      scoreFactId: fact.id,
      version: fact.version,
      source: fact.source,
      total: fact.total,
      criteria: fact.criteria,
      reason,
      commandId: input.commandId,
      actorId: actor.actorId,
      createdAt: deps.now(),
    });
    const updated = await updateScoreFact(trx, {
      ...fact,
      total: normalized.total,
      criteria: normalized.criteria,
      notes: normalized.notes,
      version: fact.version + 1,
    }, input.expectedVersion);
    if (correction !== null) {
      await updateCorrection(trx, { ...correction, state: "revised", revision: correction.revision + 1 }, correction.revision);
    }
    const session = await findRunningSessionByScope(trx, context.activity.id, input.scope);
    if (session === null) throw new DomainError("SESSION_NOT_RUNNING", `Scope ${input.scope} has no running execution session.`);
    await appendEngineEvent(trx, deps, {
      type: "ScoreFactRevised",
      activityId: context.activity.id,
      aggregateType: "score_fact",
      aggregateId: fact.id,
      revision: updated.version,
      capability: "competition",
      mode: session.mode,
      scope: session.scope,
      payload: { scoreFact: result(updated), reason, correctionId: input.correctionId ?? null },
    });
    return { body: result(updated) };
  });
}

export interface OpenScoreCorrectionInput {
  readonly commandId: string;
  readonly activityId: string;
  readonly roundId: string;
  readonly performanceId: string;
  readonly scoreFactId: string;
  readonly panelSnapshotId: string;
  readonly scope: string;
  readonly reason: string;
}

async function correctionContext(
  trx: Kysely<Database>,
  input: OpenScoreCorrectionInput,
): Promise<{ readonly activity: ScoreActivity; readonly round: StoredRound; readonly fact: StoredScoreFact; readonly mode: "test" | "rehearsal" | "formal"; readonly scope: string }> {
  const activity = await getActivityForUpdate(trx, input.activityId);
  if (activity === null) throw new DomainError("NOT_FOUND", `Activity ${input.activityId} was not found.`);
  requireActive(activity);
  const round = await getRoundForUpdate(trx, input.roundId);
  if (round === null || round.activityId !== activity.id) throw new DomainError("NOT_FOUND", "The competition round was not found.");
  if (round.state === "locked") throw new DomainError("ROUND_LOCKED", "The round is locked.");
  const panel = await getCurrentPanelForUpdate(trx, round.id);
  if (panel === null || panel.id !== input.panelSnapshotId || panel.state !== "active" || !panel.current) throw new DomainError("PANEL_NOT_ACTIVE", "The panel is not active.");
  const performance = await getPerformanceForUpdate(trx, input.performanceId);
  if (performance === null || performance.roundId !== round.id) throw new DomainError("SCORE_FACT_NOT_FOUND", "The performance was not found.");
  const performanceScoreState = await getPerformanceScoreStateForUpdate(trx, performance.id);
  if (performance.state !== "locked" || performanceScoreState?.state !== "locked") {
    throw new DomainError("CORRECTION_REQUIRED", "A correction must target a locked performance.");
  }
  const fact = await getScoreFactByIdForUpdate(trx, input.scoreFactId);
  if (fact === null || fact.roundId !== round.id || fact.performanceId !== performance.id) throw new DomainError("SCORE_FACT_NOT_FOUND", "The score fact was not found.");
  if (fact.panelSnapshotId !== panel.id) throw new DomainError("STALE_CONTEXT", "The score fact belongs to a superseded panel.");
  const session = await findRunningSessionByScope(trx, activity.id, input.scope);
  if (session === null) throw new DomainError("SESSION_NOT_RUNNING", `Scope ${input.scope} has no running execution session.`);
  return { activity, round, fact, mode: session.mode, scope: session.scope };
}

export async function openScoreCorrection(db: Kysely<Database>, deps: RuntimeDeps, input: OpenScoreCorrectionInput): Promise<CommandOutcome<StoredScoreCorrection>> {
  const actor = runtimeActor(deps);
  requireStaffScorePermission(actor);
  const reason = requireReason(input.reason, "CORRECTION_REQUIRED", "reason");
  return executeCommand(db, {
    commandId: input.commandId,
    activityId: input.activityId,
    capability: "competition",
    commandType: "competition.score.correction.open",
    scope: input.scope,
    actor,
    payload: { ...input, reason },
  }, async (trx) => {
    const context = await correctionContext(trx, input);
    if (await getOpenCorrectionForUpdate(trx, context.fact.id) !== null) throw new DomainError("CORRECTION_ALREADY_OPEN", "A correction is already open for this fact.");
    const correction: StoredScoreCorrection = {
      id: idFromCommand("correction", input.commandId),
      scoreFactId: context.fact.id,
      inputFingerprint: stableHash({
        scoreFactId: context.fact.id,
        baseVersion: context.fact.version,
        panelSnapshotId: input.panelSnapshotId,
        reason,
      }),
      state: "open",
      baseVersion: context.fact.version,
      reason,
      revision: 0,
    };
    await insertCorrection(trx, correction);
    await appendEngineEvent(trx, deps, {
      type: "ScoreCorrectionOpened",
      activityId: context.activity.id,
      aggregateType: "score_correction",
      aggregateId: correction.id,
      revision: correction.revision,
      capability: "competition",
      mode: context.mode,
      scope: context.scope,
      payload: correction,
    });
    return { body: correction, status: 201 };
  });
}

export interface CloseScoreCorrectionInput {
  readonly commandId: string;
  readonly activityId: string;
  readonly roundId: string;
  readonly scoreFactId: string;
  readonly correctionId: string;
  readonly panelSnapshotId: string;
  readonly scope: string;
}

export async function closeScoreCorrection(db: Kysely<Database>, deps: RuntimeDeps, input: CloseScoreCorrectionInput): Promise<CommandOutcome<StoredScoreCorrection>> {
  const actor = runtimeActor(deps);
  requireStaffScorePermission(actor);
  return executeCommand(db, {
    commandId: input.commandId,
    activityId: input.activityId,
    capability: "competition",
    commandType: "competition.score.correction.close",
    scope: input.scope,
    actor,
    payload: input,
  }, async (trx) => {
    const activity = await getActivityForUpdate(trx, input.activityId);
    if (activity === null) throw new DomainError("NOT_FOUND", "The activity was not found.");
    const round = await getRoundForUpdate(trx, input.roundId);
    if (round === null || round.activityId !== activity.id) throw new DomainError("NOT_FOUND", "The competition round was not found.");
    const fact = await getScoreFactByIdForUpdate(trx, input.scoreFactId);
    if (fact === null) throw new DomainError("SCORE_FACT_NOT_FOUND", "The score fact was not found.");
    const panel = await getCurrentPanelForUpdate(trx, input.roundId);
    if (panel === null || panel.id !== input.panelSnapshotId || panel.state !== "active" || !panel.current) throw new DomainError("PANEL_NOT_ACTIVE", "The panel is not active.");
    const correction = await getCorrectionForUpdate(trx, input.correctionId);
    if (correction === null || correction.scoreFactId !== fact.id) throw new DomainError("CORRECTION_NOT_FOUND", "The correction was not found.");
    if (correction.state !== "revised" || fact.version <= correction.baseVersion) throw new DomainError("CORRECTION_REQUIRED", "The correction must revise the fact before closing.");
    const saved = await updateCorrection(trx, { ...correction, state: "closed", revision: correction.revision + 1 }, correction.revision);
    return { body: saved };
  });
}

export interface RecalculateAfterCorrectionInput extends CloseScoreCorrectionInput {}

export async function recalculateAfterCorrection(db: Kysely<Database>, deps: RuntimeDeps, input: RecalculateAfterCorrectionInput): Promise<CommandOutcome<StoredScoreCorrection>> {
  const actor = runtimeActor(deps);
  requireStaffScorePermission(actor);
  return executeCommand(db, {
    commandId: input.commandId,
    activityId: input.activityId,
    capability: "competition",
    commandType: "competition.score.correction.recalculate",
    scope: input.scope,
    actor,
    payload: input,
  }, async (trx) => {
    const activity = await getActivityForUpdate(trx, input.activityId);
    if (activity === null) throw new DomainError("NOT_FOUND", "The activity was not found.");
    const round = await getRoundForUpdate(trx, input.roundId);
    if (round === null || round.activityId !== activity.id) throw new DomainError("NOT_FOUND", "The competition round was not found.");
    const fact = await getScoreFactByIdForUpdate(trx, input.scoreFactId);
    if (fact === null) throw new DomainError("SCORE_FACT_NOT_FOUND", "The score fact was not found.");
    const correction = await getCorrectionForUpdate(trx, input.correctionId);
    if (correction === null || correction.scoreFactId !== fact.id) throw new DomainError("CORRECTION_NOT_FOUND", "The correction was not found.");
    if (correction.state !== "closed") throw new DomainError("CORRECTION_REQUIRED", "The correction must be closed before recalculation.");
    await appendEngineEvent(trx, deps, {
      type: "ScoresRecalculated",
      activityId: activity.id,
      aggregateType: "score_correction",
      aggregateId: correction.id,
      revision: correction.revision,
      capability: "competition",
      payload: { correctionId: correction.id, scoreFactId: fact.id, version: fact.version },
    });
    return { body: correction };
  });
}
