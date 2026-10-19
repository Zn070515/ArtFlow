import type {
  Database,
  StoredAdvancementDecision,
  StoredPodiumCandidate,
  StoredRankingSnapshot,
  StoredRound,
} from "@artflow-plus/db";
import {
  findRunningSessionByScope,
  getActivityForUpdate,
  getCurrentPanelForUpdate,
  getLatestAdvancementDecision,
  getLatestPodiumCandidate,
  getPerformanceScoreStateForUpdate,
  getRoundForUpdate,
  getCurrentRankingSnapshot,
  insertAdvancementDecision,
  insertPodiumCandidate,
  insertRankingSnapshot,
  insertTieDecision,
  listCurrentScoreFacts,
  listRoundPerformances,
  listTieDecisions,
} from "@artflow-plus/db";
import type {
  ActorContext,
  RankingResult,
  ScoreRow,
} from "@artflow-plus/domain";
import {
  applyTieDecision,
  computeRanking,
  DomainError,
} from "@artflow-plus/domain";
import type { Kysely } from "kysely";

import { executeCommand, type CommandOutcome } from "./command.js";
import { runtimeActor, type RuntimeDeps } from "./deps.js";
import { appendEngineEvent } from "./events.js";
import { idFromCommand, stableHash } from "./hash.js";

interface ResolutionActivity {
  readonly id: string;
  readonly status: string;
}

function requireResolutionPermission(actor: ActorContext): void {
  if (!actor.permissions.includes("competition.manage") && !actor.permissions.includes("competition.score.write")) {
    throw new DomainError("FORBIDDEN", "The actor cannot resolve competition results.");
  }
}

function requireRound(round: StoredRound | null, activityId: string): StoredRound {
  if (round === null) throw new DomainError("NOT_FOUND", "The competition round was not found.");
  if (round.activityId !== activityId) throw new DomainError("CROSS_ACTIVITY", "The round belongs to another activity.");
  if (round.state !== "locked") throw new DomainError("PERFORMANCE_SCORE_OPEN", "The round must be locked before resolution.");
  return round;
}

async function rankingInput(
  trx: Kysely<Database>,
  activity: ResolutionActivity,
  round: StoredRound,
): Promise<{ readonly panelId: string; readonly rows: readonly ScoreRow[]; readonly inputFingerprint: string }> {
  const panel = await getCurrentPanelForUpdate(trx, round.id);
  if (panel === null || panel.state !== "active" || !panel.current) throw new DomainError("PANEL_NOT_ACTIVE", "The round has no current active panel.");
  const performances = await listRoundPerformances(trx, round.id);
  if (performances.length === 0) throw new DomainError("NO_PERFORMANCES", "The round has no performances.");
  const states = await Promise.all(performances.map((performance) => getPerformanceScoreStateForUpdate(trx, performance.id)));
  if (states.some((state) => state === null || state.state !== "locked")) {
    throw new DomainError("PERFORMANCE_SCORE_OPEN", "Every performance must be locked before resolution.");
  }
  const facts = await listCurrentScoreFacts(trx, round.id);
  const byContestant = new Map<string, number[]>();
  for (const fact of facts) {
    if (fact.panelSnapshotId !== panel.id || fact.contextVersion < 1) throw new DomainError("STALE_CONTEXT", "A score fact is not bound to the current panel context.");
    const values = byContestant.get(fact.contestantId) ?? [];
    values.push(fact.total);
    byContestant.set(fact.contestantId, values);
  }
  if (byContestant.size !== performances.length) throw new DomainError("SCORE_GATE_OPEN", "Every locked performance needs current score facts.");
  const rows: ScoreRow[] = [];
  for (const [contestantId, values] of byContestant) {
    const sorted = [...values].sort((left, right) => left - right);
    const effective = round.scoringMethod === "drop_high_low" && sorted.length >= 3
      ? sorted.slice(1, -1)
      : sorted;
    const total = effective.reduce((sum, value) => sum + value, 0) / effective.length;
    rows.push({ contestantId, total: Math.round(total * 100) / 100, judgeCount: values.length });
  }
  const inputFingerprint = stableHash({
    activityId: activity.id,
    roundId: round.id,
    sourceScoreVersion: round.scoreVersion,
    panelId: panel.id,
    performances,
    facts,
  });
  return { panelId: panel.id, rows, inputFingerprint };
}

function rankingFromSnapshot(snapshot: StoredRankingSnapshot): RankingResult {
  return {
    status: snapshot.status,
    rows: snapshot.rows as RankingResult["rows"],
    tieGroups: snapshot.tieGroups as RankingResult["tieGroups"],
    inputFingerprint: snapshot.inputFingerprint,
  };
}

export interface ResolveRoundInput {
  readonly commandId: string;
  readonly activityId: string;
  readonly roundId: string;
  readonly scope: string;
}

export async function resolveRound(
  db: Kysely<Database>,
  deps: RuntimeDeps,
  input: ResolveRoundInput,
): Promise<CommandOutcome<StoredRankingSnapshot>> {
  const actor = runtimeActor(deps);
  return executeCommand(db, {
    commandId: input.commandId,
    activityId: input.activityId,
    capability: "competition",
    commandType: "competition.ranking.resolve",
    scope: input.scope,
    actor,
    payload: input,
  }, async (trx) => {
    requireResolutionPermission(actor);
    const activity = await getActivityForUpdate(trx, input.activityId);
    if (activity === null) throw new DomainError("NOT_FOUND", "The activity was not found.");
    const round = requireRound(await getRoundForUpdate(trx, input.roundId), activity.id);
    const session = await findRunningSessionByScope(trx, activity.id, input.scope);
    if (session === null) throw new DomainError("SESSION_NOT_RUNNING", `Scope ${input.scope} has no running execution session.`);
    const resolved = await rankingInput(trx, activity, round);
    const ranking = computeRanking({ rows: resolved.rows, tiePolicy: "review" });
    const current = await getCurrentRankingSnapshot(trx, round.id);
    const snapshot: StoredRankingSnapshot = {
      id: idFromCommand("ranking", input.commandId),
      activityId: activity.id,
      roundId: round.id,
      sourceScoreVersion: round.scoreVersion,
      inputFingerprint: resolved.inputFingerprint,
      status: ranking.status,
      rows: ranking.rows,
      tieGroups: ranking.tieGroups,
      revision: (current?.revision ?? 0) + 1,
    };
    await insertRankingSnapshot(trx, snapshot);
    await appendEngineEvent(trx, deps, {
      type: "RankingComputed",
      activityId: activity.id,
      aggregateType: "ranking",
      aggregateId: round.id,
      revision: snapshot.revision,
      capability: "competition",
      mode: session.mode,
      scope: session.scope,
      payload: { ranking: snapshot, sourceScoreVersion: snapshot.sourceScoreVersion, inputFingerprint: snapshot.inputFingerprint },
    });
    return { body: snapshot, status: 201 };
  });
}

export interface FinalizeAdvancementInput {
  readonly commandId: string;
  readonly activityId: string;
  readonly roundId: string;
  readonly expectedRankingRevision: number;
  readonly scope: string;
}

function tieCrossesCutoff(ranking: RankingResult, advanceCount: number): boolean {
  return ranking.tieGroups.some((group) => {
    const start = ranking.rows.findIndex((row) => group.contestants.includes(row.contestantId));
    return start >= 0 && start < advanceCount && start + group.contestants.length > advanceCount;
  });
}

export async function finalizeAdvancement(
  db: Kysely<Database>,
  deps: RuntimeDeps,
  input: FinalizeAdvancementInput,
): Promise<CommandOutcome<StoredAdvancementDecision>> {
  const actor = runtimeActor(deps);
  return executeCommand(db, {
    commandId: input.commandId,
    activityId: input.activityId,
    capability: "competition",
    commandType: "competition.advancement.finalize",
    scope: input.scope,
    actor,
    payload: input,
  }, async (trx) => {
    requireResolutionPermission(actor);
    const activity = await getActivityForUpdate(trx, input.activityId);
    if (activity === null) throw new DomainError("NOT_FOUND", "The activity was not found.");
    const round = requireRound(await getRoundForUpdate(trx, input.roundId), activity.id);
    const rankingSnapshot = await getCurrentRankingSnapshot(trx, round.id);
    if (rankingSnapshot === null) throw new DomainError("NOT_FOUND", "The round has no ranking snapshot.");
    if (rankingSnapshot.revision !== input.expectedRankingRevision) throw new DomainError("STALE_REVISION", "The ranking changed since it was read.");
    const ranking = rankingFromSnapshot(rankingSnapshot);
    const needsReview = ranking.status === "hold" && tieCrossesCutoff(ranking, round.advanceCount);
    const decisions = needsReview
      ? ranking.rows.map((row) => ({ contestantId: row.contestantId, advanced: false }))
      : ranking.rows.map((row, index) => ({ contestantId: row.contestantId, advanced: index < round.advanceCount }));
    const previous = await getLatestAdvancementDecision(trx, round.id);
    const decision: StoredAdvancementDecision = {
      id: idFromCommand("advancement", input.commandId),
      activityId: activity.id,
      roundId: round.id,
      inputFingerprint: rankingSnapshot.inputFingerprint,
      status: needsReview ? "needs_review" : "auto",
      decisions,
      decidedBy: needsReview ? null : actor.actorId,
      revision: (previous?.revision ?? 0) + 1,
    };
    await insertAdvancementDecision(trx, decision);
    const session = await findRunningSessionByScope(trx, activity.id, input.scope);
    if (session === null) throw new DomainError("SESSION_NOT_RUNNING", `Scope ${input.scope} has no running execution session.`);
    await appendEngineEvent(trx, deps, {
      type: "AdvancementFinalized",
      activityId: activity.id,
      aggregateType: "advancement",
      aggregateId: round.id,
      revision: decision.revision,
      capability: "competition",
      mode: session.mode,
      scope: session.scope,
      payload: { decision, sourceScoreVersion: rankingSnapshot.sourceScoreVersion, inputFingerprint: rankingSnapshot.inputFingerprint },
    });
    return { body: decision, status: 201 };
  });
}

export interface RecordTieDecisionInput {
  readonly commandId: string;
  readonly activityId: string;
  readonly roundId: string;
  readonly rankingSnapshotId: string;
  readonly inputFingerprint: string;
  readonly contestants: readonly string[];
  readonly order: readonly string[];
  readonly reason: string;
  readonly scope: string;
}

export async function recordTieDecision(
  db: Kysely<Database>,
  deps: RuntimeDeps,
  input: RecordTieDecisionInput,
): Promise<CommandOutcome<StoredRankingSnapshot>> {
  const actor = runtimeActor(deps);
  return executeCommand(db, {
    commandId: input.commandId,
    activityId: input.activityId,
    capability: "competition",
    commandType: "competition.tie.decide",
    scope: input.scope,
    actor,
    payload: input,
  }, async (trx) => {
    requireResolutionPermission(actor);
    if (!input.reason.trim()) throw new DomainError("TIE_DECISION_INVALID", "A tie decision reason is required.");
    const activity = await getActivityForUpdate(trx, input.activityId);
    if (activity === null) throw new DomainError("NOT_FOUND", "The activity was not found.");
    const round = requireRound(await getRoundForUpdate(trx, input.roundId), activity.id);
    const current = await getCurrentRankingSnapshot(trx, round.id);
    if (current === null || current.id !== input.rankingSnapshotId || current.inputFingerprint !== input.inputFingerprint) {
      throw new DomainError("STALE_RESOLUTION_INPUT", "The ranking snapshot is stale.");
    }
    const ranking = rankingFromSnapshot(current);
    const decided = applyTieDecision(ranking, {
      contestants: input.contestants,
      order: input.order,
      reason: input.reason,
    });
    const decisions = await listTieDecisions(trx, round.id);
    await insertTieDecision(trx, {
      id: idFromCommand("tie", input.commandId),
      activityId: activity.id,
      roundId: round.id,
      rankingSnapshotId: current.id,
      inputFingerprint: input.inputFingerprint,
      contestants: input.contestants,
      ordering: input.order,
      reason: input.reason.trim(),
      revision: decisions.length + 1,
    });
    const snapshot: StoredRankingSnapshot = {
      ...current,
      id: idFromCommand("ranking", input.commandId),
      status: decided.status,
      rows: decided.rows,
      tieGroups: decided.tieGroups,
      revision: current.revision + 1,
    };
    await insertRankingSnapshot(trx, snapshot);
    const session = await findRunningSessionByScope(trx, activity.id, input.scope);
    if (session === null) throw new DomainError("SESSION_NOT_RUNNING", `Scope ${input.scope} has no running execution session.`);
    await appendEngineEvent(trx, deps, {
      type: "TieDecisionRecorded",
      activityId: activity.id,
      aggregateType: "ranking",
      aggregateId: round.id,
      revision: snapshot.revision,
      capability: "competition",
      mode: session.mode,
      scope: session.scope,
      payload: { ranking: snapshot, contestants: input.contestants, order: input.order, reason: input.reason.trim(), sourceScoreVersion: current.sourceScoreVersion, inputFingerprint: current.inputFingerprint },
    });
    return { body: snapshot, status: 201 };
  });
}

export interface PodiumRoundInput {
  readonly roundId: string;
  readonly locked: boolean;
  readonly ranking: RankingResult;
}

export interface PodiumCandidateResult {
  readonly status: "candidate" | "hold";
  readonly placements: readonly { readonly place: number; readonly contestantId: string; readonly total: number }[];
  readonly sourceRoundIds: readonly string[];
  readonly inputFingerprint: string;
}

export function buildPodiumCandidate(input: { readonly rounds: readonly PodiumRoundInput[] }): PodiumCandidateResult {
  const inputFingerprint = stableHash(input.rounds.map((round) => ({ roundId: round.roundId, locked: round.locked, ranking: round.ranking })));
  if (input.rounds.length === 0 || input.rounds.some((round) => !round.locked || round.ranking.status !== "ready" || round.ranking.tieGroups.length > 0)) {
    return { status: "hold", placements: [], sourceRoundIds: input.rounds.map((round) => round.roundId), inputFingerprint };
  }
  const rows = input.rounds[0]?.ranking.rows ?? [];
  return {
    status: "candidate",
    placements: rows.slice(0, 3).map((row, index) => ({ place: index + 1, contestantId: row.contestantId, total: row.total })),
    sourceRoundIds: input.rounds.map((round) => round.roundId),
    inputFingerprint,
  };
}

export interface RecomputePodiumCandidateInput {
  readonly commandId: string;
  readonly activityId: string;
  readonly roundIds: readonly string[];
  readonly expectedInputFingerprint: string;
  readonly scope: string;
}

export async function recomputePodiumCandidate(
  db: Kysely<Database>,
  deps: RuntimeDeps,
  input: RecomputePodiumCandidateInput,
): Promise<CommandOutcome<StoredPodiumCandidate>> {
  const actor = runtimeActor(deps);
  return executeCommand(db, {
    commandId: input.commandId,
    activityId: input.activityId,
    capability: "competition",
    commandType: "competition.podium.recompute",
    scope: input.scope,
    actor,
    payload: input,
  }, async (trx) => {
    requireResolutionPermission(actor);
    const activity = await getActivityForUpdate(trx, input.activityId);
    if (activity === null) throw new DomainError("NOT_FOUND", "The activity was not found.");
    const rounds: PodiumRoundInput[] = [];
    for (const roundId of input.roundIds) {
      const round = requireRound(await getRoundForUpdate(trx, roundId), activity.id);
      const ranking = await getCurrentRankingSnapshot(trx, round.id);
      if (ranking === null) throw new DomainError("NOT_FOUND", "A required round has no ranking snapshot.");
      rounds.push({ roundId: round.id, locked: round.state === "locked", ranking: rankingFromSnapshot(ranking) });
    }
    const candidate = buildPodiumCandidate({ rounds });
    if (candidate.inputFingerprint !== input.expectedInputFingerprint) throw new DomainError("STALE_RESOLUTION_INPUT", "The podium input fingerprint is stale.");
    const previous = await getLatestPodiumCandidate(trx, activity.id);
    const stored: StoredPodiumCandidate = {
      id: idFromCommand("podium", input.commandId),
      activityId: activity.id,
      inputFingerprint: candidate.inputFingerprint,
      status: candidate.status,
      placements: candidate.placements,
      sourceRoundIds: candidate.sourceRoundIds,
      revision: (previous?.revision ?? 0) + 1,
    };
    await insertPodiumCandidate(trx, stored);
    await appendEngineEvent(trx, deps, {
      type: "StageResultCandidateProduced",
      activityId: activity.id,
      aggregateType: "podium_candidate",
      aggregateId: stored.id,
      revision: stored.revision,
      capability: "competition",
      payload: stored,
    });
    return { body: stored, status: 201 };
  });
}
