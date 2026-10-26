import type {
  Database,
  StoredPanelSnapshot,
  StoredPerformance,
  StoredRound,
} from "@artflow-plus/db";
import {
  countCurrentScoreFactsForContext,
  ensureJudgeEntrySeat,
  findRunningSessionByScope,
  getActivityForUpdate,
  getCurrentPanelForUpdate,
  getNextPanelVersion,
  getPerformanceForUpdate,
  getPerformanceScoreStateForUpdate,
  getRelease,
  getRoundByKeyForUpdate,
  getRoundForUpdate,
  getRosterForUpdate,
  getRoster,
  insertJudgeSeat,
  insertPanelMember,
  insertPanelSnapshot,
  insertPerformance,
  insertRound,
  listApprovedParticipantIds,
  listRoundPerformances,
  retireCurrentScoreFactsForPerformance,
  updatePerformance,
  updatePerformanceScoreState,
  updateRound,
} from "@artflow-plus/db";
import type {
  ActorContext,
  CompiledCompetitionArtifact,
  ExecutionMode,
  RosterFinal,
} from "@artflow-plus/domain";
import {
  DomainError,
  requireFinalRoster,
} from "@artflow-plus/domain";
import type { Kysely } from "kysely";

import { executeCommand, type CommandOutcome } from "./command.js";
import { runtimeActor, type RuntimeDeps } from "./deps.js";
import { appendEngineEvent } from "./events.js";
import { idFromCommand, stableHash } from "./hash.js";

interface CompetitionActivity {
  readonly id: string;
  readonly status: string;
  readonly activeDefinitionVersion: number;
  readonly enabledCapabilities: readonly string[];
}

interface JudgeInput {
  readonly judgeId: string;
  readonly seatKey: string;
}

function requireActive(activity: CompetitionActivity): void {
  if (activity.status !== "active") {
    throw new DomainError("ACTIVITY_NOT_ACTIVE", "Competition commands require an active activity.");
  }
}

function requireSetupPermission(actor: ActorContext): void {
  if (!actor.permissions.includes("competition.manage")) {
    throw new DomainError("FORBIDDEN", "The actor cannot manage competition operations.");
  }
}

function requireRoundPreparePermission(actor: ActorContext): void {
  if (!actor.permissions.includes("competition.manage") && !actor.permissions.includes("competition.round.prepare")) {
    throw new DomainError("FORBIDDEN", "The actor cannot prepare competition rounds.");
  }
}

function requireCompetitionArtifact(
  activity: CompetitionActivity,
  release: Awaited<ReturnType<typeof getRelease>>,
): CompiledCompetitionArtifact {
  if (!activity.enabledCapabilities.includes("competition")) {
    throw new DomainError("CAPABILITY_NOT_ENABLED", "Competition is not enabled on this activity.");
  }
  const plan = release?.capabilities.competition;
  if (plan === undefined || plan.ok !== true) {
    throw new DomainError("RELEASE_SNAPSHOT_INCOMPLETE", "The release has no competition snapshot.");
  }
  return plan.artifact as CompiledCompetitionArtifact;
}

function roundConfig(artifact: CompiledCompetitionArtifact, roundKey: string) {
  const config = artifact.rounds.find((round) => round.key === roundKey);
  if (config === undefined && artifact.rounds.length === 0 && roundKey === "round-1") {
    // M4's empty competition package intentionally represented an unconfigured
    // roster-to-result boundary. Keep its historical round-1 rehearsal path
    // valid while configured releases remain strict about declared round keys.
    return {
      key: roundKey,
      judgeCount: 1,
      minimumJudges: 1,
      completion: "minimum_valid" as const,
      advanceCount: 0,
      scoringMethod: "average" as const,
    };
  }
  if (config === undefined) {
    throw new DomainError("ROUND_UNKNOWN", `Round ${roundKey} is not configured by the release.`);
  }
  return config;
}

async function runningSession(
  trx: Kysely<Database>,
  activity: CompetitionActivity,
  scope: string,
) {
  const release = await getRelease(trx, activity.id, activity.activeDefinitionVersion);
  if (release === null) {
    throw new DomainError("VERSION_NOT_RELEASED", "The activity has no active released definition.");
  }
  if (release.executionPolicy.declaredScopes.length > 0 && !release.executionPolicy.declaredScopes.includes(scope)) {
    throw new DomainError("SCOPE_UNDECLARED", `Scope ${scope} is not declared by the release.`);
  }
  const session = await findRunningSessionByScope(trx, activity.id, scope);
  if (session === null) {
    throw new DomainError("SESSION_NOT_RUNNING", `Scope ${scope} has no running execution session.`);
  }
  return { release, session };
}

function requireRoundForActivity(round: StoredRound | null, activityId: string): StoredRound {
  if (round === null) throw new DomainError("NOT_FOUND", "The competition round was not found.");
  if (round.activityId !== activityId) throw new DomainError("CROSS_ACTIVITY", "The round belongs to another activity.");
  return round;
}

function requireActivePanel(panel: StoredPanelSnapshot | null): StoredPanelSnapshot {
  if (panel === null) throw new DomainError("PANEL_NOT_ACTIVE", "The round has no current panel.");
  if (panel.state !== "active" || !panel.current) {
    throw new DomainError("PANEL_NOT_ACTIVE", "The current panel is not active.");
  }
  return panel;
}

function scoreGateMinimum(round: StoredRound): number {
  return round.completionMode === "full_matrix" ? round.judgeCount : round.minimumJudges;
}

function requireGateClosed(round: StoredRound, scoreCount: number): void {
  if (scoreCount < scoreGateMinimum(round)) {
    throw new DomainError("SCORE_GATE_OPEN", `The performance has ${scoreCount} valid scores; ${scoreGateMinimum(round)} are required.`);
  }
}

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
      const { release, session } = await runningSession(trx, activity, input.scope);
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

export interface ActivateCompetitionPanelInput {
  readonly commandId: string;
  readonly activityId: string;
  readonly roundId: string;
  readonly scope: string;
  readonly judges: readonly JudgeInput[];
}

export async function activateCompetitionPanel(
  db: Kysely<Database>,
  deps: RuntimeDeps,
  input: ActivateCompetitionPanelInput,
): Promise<CommandOutcome<StoredPanelSnapshot>> {
  const actor = runtimeActor(deps);
  return executeCommand(
    db,
    {
      commandId: input.commandId,
      activityId: input.activityId,
      capability: "competition",
      commandType: "competition.panel.activate",
      scope: input.scope,
      actor,
      payload: { roundId: input.roundId, scope: input.scope, judges: input.judges },
    },
    async (trx) => {
      requireSetupPermission(actor);
      const activity = await getActivityForUpdate(trx, input.activityId);
      if (activity === null) throw new DomainError("NOT_FOUND", `Activity ${input.activityId} was not found.`);
      requireActive(activity);
      const round = requireRoundForActivity(await getRoundForUpdate(trx, input.roundId), input.activityId);
      if (await getCurrentPanelForUpdate(trx, round.id) !== null) {
        throw new DomainError("PANEL_ALREADY_ACTIVE", "The round already has a current panel.");
      }
      if (round.state !== "prepared") throw new DomainError("INVALID_TRANSITION", "Only a prepared round can activate its first panel.");
      if (input.judges.length !== round.judgeCount) {
        throw new DomainError("JUDGE_ROSTER_INVALID", `The panel requires exactly ${round.judgeCount} judges.`);
      }
      const judgeIds = new Set<string>();
      const seatKeys = new Set<string>();
      for (const judge of input.judges) {
        if (!judge.judgeId.trim() || !judge.seatKey.trim() || judgeIds.has(judge.judgeId) || seatKeys.has(judge.seatKey)) {
          throw new DomainError("JUDGE_ROSTER_INVALID", "Judge identities and seat keys must be nonempty and unique.");
        }
        judgeIds.add(judge.judgeId);
        seatKeys.add(judge.seatKey);
      }
      const { session } = await runningSession(trx, activity, input.scope);
      const panelId = idFromCommand("panel", input.commandId);
      const panel: StoredPanelSnapshot = {
        id: panelId,
        activityId: input.activityId,
        roundId: round.id,
        version: await getNextPanelVersion(trx, round.id),
        state: "active",
        expectedJudges: round.judgeCount,
        minimumJudges: round.minimumJudges,
        rosterDigest: stableHash(await listApprovedParticipantIds(trx, input.activityId)),
        contextVersion: 1,
        current: true,
      };
      await insertPanelSnapshot(trx, panel);
      for (const judge of input.judges) {
        await insertPanelMember(trx, { panelId, judgeId: judge.judgeId, seatKey: judge.seatKey });
        await insertJudgeSeat(trx, {
          id: idFromCommand("seat", `${panelId}:${judge.seatKey}`),
          panelId,
          judgeId: judge.judgeId,
          state: "assigned",
          revision: 0,
        });
        if (activity.enabledCapabilities.includes("ticketing")) {
          // With ticketing enabled, each panel seat becomes a claimable judge-entry
          // seat. The judge session binds to the entry seat; the seat key maps it
          // back to the current panel member for scoring.
          await ensureJudgeEntrySeat(trx, {
            id: idFromCommand("judge-entry-seat", `${input.activityId}:${judge.seatKey}`),
            activityId: input.activityId,
            seatKey: judge.seatKey,
            state: "available",
            revision: 0,
          });
        }
      }
      const savedRound = await updateRound(trx, {
        ...round,
        state: "scoring",
        revision: round.revision + 1,
        currentPanelId: panelId,
      }, round.revision);
      await appendEngineEvent(trx, deps, {
        type: "PanelSnapshotActivated",
        activityId: input.activityId,
        aggregateType: "competition_round",
        aggregateId: round.id,
        revision: savedRound.revision,
        capability: "competition",
        mode: session.mode,
        scope: session.scope,
        payload: { panel, roundRevision: savedRound.revision },
      });
      return { body: panel, status: 201 };
    },
  );
}

export interface OpenPerformanceInput {
  readonly commandId: string;
  readonly activityId: string;
  readonly roundId: string;
  readonly scope: string;
  readonly performanceId?: string;
  readonly contestantId: string;
  readonly sequence: number;
}

async function openPerformanceInTransaction(
  trx: Kysely<Database>,
  activity: CompetitionActivity,
  round: StoredRound,
  input: Pick<OpenPerformanceInput, "contestantId" | "sequence" | "performanceId">,
): Promise<StoredPerformance> {
  requireActivePanel(await getCurrentPanelForUpdate(trx, round.id));
  if (!Number.isInteger(input.sequence) || input.sequence < 1 || !input.contestantId.trim() ||
      (input.performanceId !== undefined && !input.performanceId.trim())) {
    throw new DomainError("INVALID_INPUT", "A performance needs a positive sequence and contestant.");
  }
  const roster = requireFinalRoster(await getRoster(trx, activity.id));
  const approvedParticipants = await listApprovedParticipantIds(trx, activity.id);
  if (approvedParticipants.length !== roster.approvedCount || !approvedParticipants.includes(input.contestantId)) {
    throw new DomainError("CONTESTANT_NOT_IN_ROSTER", "The contestant is not in the final approved roster.");
  }
  const performances = await listRoundPerformances(trx, round.id);
  const open = performances.find((performance) => performance.state === "open");
  if (open !== undefined && open.contestantId !== input.contestantId) {
    throw new DomainError("PERFORMANCE_ALREADY_OPEN", "Another performance is already open.");
  }
  const existingSummary = performances.find((performance) => performance.contestantId === input.contestantId);
  const existing = existingSummary === undefined ? undefined : await getPerformanceForUpdate(trx, existingSummary.id);
  if (existing === null) throw new DomainError("NOT_FOUND", "The performance was not found.");
  if (existing === undefined && input.performanceId !== undefined) {
    const requested = await getPerformanceForUpdate(trx, input.performanceId);
    if (requested !== null) throw new DomainError("NOT_FOUND", "The requested performance does not match the contestant.");
  }
  if (existing !== undefined && existing !== null && input.performanceId !== undefined && existing.id !== input.performanceId) {
    throw new DomainError("NOT_FOUND", "The requested performance does not match the contestant.");
  }
  if (existing?.state === "locked") throw new DomainError("PERFORMANCE_LOCKED", "The performance is already locked.");
  if (existing === undefined) {
    const performance: StoredPerformance = {
      id: input.performanceId ?? idFromCommand("performance", `${round.id}:${input.contestantId}`),
      activityId: activity.id,
      roundId: round.id,
      contestantId: input.contestantId,
      sequence: input.sequence,
      state: "open",
      contextVersion: 1,
    };
    await insertPerformance(trx, performance);
    return performance;
  }
  const state = await getPerformanceScoreStateForUpdate(trx, existing.id);
  if (state === null) throw new DomainError("NOT_FOUND", "The performance score state was not found.");
  const next: StoredPerformance = { ...existing, state: "open", contextVersion: existing.contextVersion + 1 };
  await retireCurrentScoreFactsForPerformance(trx, existing.id, next.contextVersion);
  await updatePerformance(trx, next, existing.contextVersion);
  await updatePerformanceScoreState(trx, {
    ...state,
    state: "open",
    contextVersion: next.contextVersion,
    revision: state.revision + 1,
    openedAt: new Date().toISOString(),
    lockedAt: null,
  }, state.revision);
  return next;
}

export async function openPerformance(
  db: Kysely<Database>,
  deps: RuntimeDeps,
  input: OpenPerformanceInput,
): Promise<CommandOutcome<StoredPerformance>> {
  const actor = runtimeActor(deps);
  return executeCommand(db, {
    commandId: input.commandId,
    activityId: input.activityId,
    capability: "competition",
    commandType: "competition.performance.open",
    scope: input.scope,
    actor,
    payload: { roundId: input.roundId, scope: input.scope, performanceId: input.performanceId ?? null, contestantId: input.contestantId, sequence: input.sequence },
  }, async (trx) => {
    requireSetupPermission(actor);
    const activity = await getActivityForUpdate(trx, input.activityId);
    if (activity === null) throw new DomainError("NOT_FOUND", `Activity ${input.activityId} was not found.`);
    requireActive(activity);
    const round = requireRoundForActivity(await getRoundForUpdate(trx, input.roundId), input.activityId);
    if (round.state !== "scoring") throw new DomainError("ROUND_NOT_PREPARED", "The round is not accepting performances.");
    const { session } = await runningSession(trx, activity, input.scope);
    const performance = await openPerformanceInTransaction(trx, activity, round, input);
    const savedRound = await updateRound(trx, { ...round, revision: round.revision + 1 }, round.revision);
    await appendEngineEvent(trx, deps, {
      type: "PerformanceAdvanced",
      activityId: input.activityId,
      aggregateType: "competition_round",
      aggregateId: round.id,
      revision: savedRound.revision,
      capability: "competition",
      mode: session.mode,
      scope: session.scope,
      payload: { performance, roundRevision: savedRound.revision },
    });
    return { body: performance, status: 201 };
  });
}

export interface LockPerformanceInput {
  readonly commandId: string;
  readonly activityId: string;
  readonly roundId: string;
  readonly performanceId: string;
  readonly scope: string;
}

export async function lockPerformance(
  db: Kysely<Database>,
  deps: RuntimeDeps,
  input: LockPerformanceInput,
): Promise<CommandOutcome<StoredPerformance>> {
  const actor = runtimeActor(deps);
  return executeCommand(db, {
    commandId: input.commandId,
    activityId: input.activityId,
    capability: "competition",
    commandType: "competition.performance.lock",
    scope: input.scope,
    actor,
    payload: { roundId: input.roundId, performanceId: input.performanceId, scope: input.scope },
  }, async (trx) => {
    requireSetupPermission(actor);
    const activity = await getActivityForUpdate(trx, input.activityId);
    if (activity === null) throw new DomainError("NOT_FOUND", `Activity ${input.activityId} was not found.`);
    requireActive(activity);
    const round = requireRoundForActivity(await getRoundForUpdate(trx, input.roundId), input.activityId);
    if (round.state !== "scoring") throw new DomainError("ROUND_LOCKED", "The round is not scoring.");
    const panel = requireActivePanel(await getCurrentPanelForUpdate(trx, round.id));
    const { session } = await runningSession(trx, activity, input.scope);
    const performance = await getPerformanceForUpdate(trx, input.performanceId);
    if (performance === null) throw new DomainError("NOT_FOUND", "The performance was not found.");
    if (performance.roundId !== round.id || performance.activityId !== activity.id) throw new DomainError("CROSS_ACTIVITY", "The performance belongs to another round.");
    if (performance.state !== "open") throw new DomainError("PERFORMANCE_NOT_OPEN", "Only an open performance can be locked.");
    const scoreState = await getPerformanceScoreStateForUpdate(trx, performance.id);
    if (scoreState === null) throw new DomainError("NOT_FOUND", "The performance score state was not found.");
    if (scoreState.contextVersion !== performance.contextVersion) throw new DomainError("STALE_REVISION", "The performance context changed.");
    requireGateClosed(round, await countCurrentScoreFactsForContext(trx, {
      performanceId: performance.id,
      panelSnapshotId: panel.id,
      contextVersion: performance.contextVersion,
    }));
    const nextPerformance: StoredPerformance = { ...performance, state: "locked" };
    await updatePerformance(trx, nextPerformance, performance.contextVersion);
    await updatePerformanceScoreState(trx, {
      ...scoreState,
      state: "locked",
      revision: scoreState.revision + 1,
      lockedAt: new Date().toISOString(),
    }, scoreState.revision);
    const savedRound = await updateRound(trx, { ...round, revision: round.revision + 1 }, round.revision);
    await appendEngineEvent(trx, deps, {
      type: "PerformanceLocked",
      activityId: activity.id,
      aggregateType: "competition_round",
      aggregateId: round.id,
      revision: savedRound.revision,
      capability: "competition",
      mode: session.mode,
      scope: session.scope,
      payload: { performance: nextPerformance, panelId: panel.id, roundRevision: savedRound.revision },
    });
    return { body: nextPerformance };
  });
}

export interface AdvancePerformanceInput {
  readonly commandId: string;
  readonly activityId: string;
  readonly roundId: string;
  readonly currentPerformanceId: string;
  readonly nextContestantId: string;
  readonly nextSequence: number;
  readonly scope: string;
}

export async function advancePerformance(
  db: Kysely<Database>,
  deps: RuntimeDeps,
  input: AdvancePerformanceInput,
): Promise<CommandOutcome<StoredPerformance>> {
  const actor = runtimeActor(deps);
  return executeCommand(db, {
    commandId: input.commandId,
    activityId: input.activityId,
    capability: "competition",
    commandType: "competition.performance.advance",
    scope: input.scope,
    actor,
    payload: {
      roundId: input.roundId,
      currentPerformanceId: input.currentPerformanceId,
      nextContestantId: input.nextContestantId,
      nextSequence: input.nextSequence,
      scope: input.scope,
    },
  }, async (trx) => {
    requireSetupPermission(actor);
    const activity = await getActivityForUpdate(trx, input.activityId);
    if (activity === null) throw new DomainError("NOT_FOUND", `Activity ${input.activityId} was not found.`);
    requireActive(activity);
    const round = requireRoundForActivity(await getRoundForUpdate(trx, input.roundId), input.activityId);
    if (round.state !== "scoring") throw new DomainError("ROUND_LOCKED", "The round is not scoring.");
    const panel = requireActivePanel(await getCurrentPanelForUpdate(trx, round.id));
    const { session } = await runningSession(trx, activity, input.scope);
    const current = await getPerformanceForUpdate(trx, input.currentPerformanceId);
    if (current === null) throw new DomainError("NOT_FOUND", "The current performance was not found.");
    if (current.roundId !== round.id || current.activityId !== activity.id) throw new DomainError("CROSS_ACTIVITY", "The performance belongs to another round.");
    if (current.state !== "open") throw new DomainError("PERFORMANCE_NOT_OPEN", "Only an open performance can advance.");
    const currentScoreState = await getPerformanceScoreStateForUpdate(trx, current.id);
    if (currentScoreState === null) throw new DomainError("NOT_FOUND", "The performance score state was not found.");
    requireGateClosed(round, await countCurrentScoreFactsForContext(trx, {
      performanceId: current.id,
      panelSnapshotId: panel.id,
      contextVersion: current.contextVersion,
    }));
    const lockedCurrent: StoredPerformance = { ...current, state: "locked" };
    await updatePerformance(trx, lockedCurrent, current.contextVersion);
    await updatePerformanceScoreState(trx, {
      ...currentScoreState,
      state: "locked",
      revision: currentScoreState.revision + 1,
      lockedAt: new Date().toISOString(),
    }, currentScoreState.revision);
    const next = await openPerformanceInTransaction(trx, activity, round, {
      contestantId: input.nextContestantId,
      sequence: input.nextSequence,
      performanceId: undefined,
    });
    const savedRound = await updateRound(trx, { ...round, revision: round.revision + 1 }, round.revision);
    await appendEngineEvent(trx, deps, {
      type: "PerformanceLocked",
      activityId: activity.id,
      aggregateType: "competition_round",
      aggregateId: round.id,
      revision: savedRound.revision,
      capability: "competition",
      mode: session.mode,
      scope: session.scope,
      payload: { performance: lockedCurrent, panelId: panel.id, roundRevision: savedRound.revision },
    });
    await appendEngineEvent(trx, deps, {
      type: "PerformanceAdvanced",
      activityId: activity.id,
      aggregateType: "competition_round",
      aggregateId: round.id,
      revision: savedRound.revision,
      capability: "competition",
      mode: session.mode,
      scope: session.scope,
      payload: { performance: next, roundRevision: savedRound.revision },
    });
    return { body: next, status: 201 };
  });
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
    const { session } = await runningSession(trx, activity, input.scope);
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
