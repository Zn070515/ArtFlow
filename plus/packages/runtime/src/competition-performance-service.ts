import type {
  Database,
  StoredPerformance,
  StoredRound,
} from "@artflow-plus/db";
import {
  countCurrentScoreFactsForContext,
  getActivityForUpdate,
  getCurrentPanelForUpdate,
  getPerformanceForUpdate,
  getPerformanceScoreStateForUpdate,
  getRoundForUpdate,
  getRoster,
  insertPerformance,
  listApprovedParticipantIds,
  listRoundPerformances,
  retireCurrentScoreFactsForPerformance,
  updatePerformance,
  updatePerformanceScoreState,
  updateRound,
} from "@artflow-plus/db";
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


import {
  requireActive,
  requireActivePanel,
  requireGateClosed,
  requireRoundForActivity,
  requireSetupPermission,
  runningSession,
  type CompetitionActivity,
} from "./competition-shared.js";

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
    const { session } = await runningSession(trx, activity, "competition.performance.open", input.scope);
    await requireNoFormalFacts(trx, round.id, session.mode);
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
    const { session } = await runningSession(trx, activity, "competition.performance.lock", input.scope);
    await requireNoFormalFacts(trx, round.id, session.mode);
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
      mode: session.mode,
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
    const { session } = await runningSession(trx, activity, "competition.performance.advance", input.scope);
    await requireNoFormalFacts(trx, round.id, session.mode);
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
      mode: session.mode,
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
