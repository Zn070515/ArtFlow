import type {
  Database,
  StoredAdvancementDecision,
  StoredPodiumCandidate,
  StoredRankingSnapshot,
  StoredRound,
} from "@artflow-plus/db";
import {
  getActivityForUpdate,
  getCurrentPanelForUpdate,
  getLatestAdvancementDecision,
  getLatestPodiumCandidate,
  getPerformanceScoreStateForUpdate,
  getRelease,
  getRoundForUpdate,
  getRoundByKeyForUpdate,
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
  DecimalValue,
  ExecutionMode,
  RankingResult,
  ScoreRow,
} from "@artflow-plus/domain";
import {
  applyTieDecision,
  averageScore,
  compareScores,
  computeRanking,
  decimalValue,
  DomainError,
} from "@artflow-plus/domain";
import type { Kysely } from "kysely";

import { executeCommand, type CommandOutcome } from "./command.js";
import { requireRunningCommandSession } from "./command-scope.js";
import { markConsumedResultsStale } from "./result-consumption.js";
import { runtimeActor, type RuntimeDeps } from "./deps.js";
import { appendEngineEvent } from "./events.js";
import { idFromCommand, stableHash } from "./hash.js";
import { requireNoFormalFacts } from "./mode-guard.js";

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
  mode: ExecutionMode,
): Promise<{ readonly panelId: string; readonly rows: readonly ScoreRow[]; readonly inputFingerprint: string }> {
  const panel = await getCurrentPanelForUpdate(trx, round.id);
  if (panel === null || panel.state !== "active" || !panel.current) throw new DomainError("PANEL_NOT_ACTIVE", "The round has no current active panel.");
  const performances = await listRoundPerformances(trx, round.id);
  if (performances.length === 0) throw new DomainError("NO_PERFORMANCES", "The round has no performances.");
  const states = await Promise.all(performances.map((performance) => getPerformanceScoreStateForUpdate(trx, performance.id)));
  if (states.some((state) => state === null || state.state !== "locked")) {
    throw new DomainError("PERFORMANCE_SCORE_OPEN", "Every performance must be locked before resolution.");
  }
  const facts = await listCurrentScoreFacts(trx, round.id, mode);
  const performancesById = new Map(performances.map((performance) => [performance.id, performance]));
  const factsByPerformance = new Map<string, number>();
  const byContestant = new Map<string, DecimalValue[]>();
  for (const fact of facts) {
    const performance = performancesById.get(fact.performanceId);
    if (performance === undefined || fact.contestantId !== performance.contestantId ||
        fact.panelSnapshotId !== panel.id || fact.contextVersion !== performance.contextVersion) {
      throw new DomainError("STALE_CONTEXT", "A score fact is not bound to the current performance context.");
    }
    factsByPerformance.set(fact.performanceId, (factsByPerformance.get(fact.performanceId) ?? 0) + 1);
    const values = byContestant.get(performance.contestantId) ?? [];
    values.push(fact.total);
    byContestant.set(performance.contestantId, values);
  }
  if (factsByPerformance.size !== performances.length || performances.some((performance) => !factsByPerformance.has(performance.id))) {
    throw new DomainError("SCORE_GATE_OPEN", "Every locked performance needs current score facts.");
  }
  const rows: ScoreRow[] = [];
  for (const [contestantId, values] of byContestant) {
    const sorted = [...values].sort(compareScores);
    const effective = round.scoringMethod === "drop_high_low" && sorted.length >= 3
      ? sorted.slice(1, -1)
      : sorted;
    rows.push({ contestantId, total: averageScore(effective), judgeCount: values.length });
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

function tieGroupId(group: { readonly total: DecimalValue; readonly contestants: readonly string[] }): string {
  return `tie-${stableHash({ total: group.total, contestants: group.contestants })}`;
}

function decorateTieGroups(groups: readonly { readonly total: DecimalValue; readonly contestants: readonly string[] }[]): readonly unknown[] {
  return groups.map((group) => ({ ...group, id: tieGroupId(group) }));
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
    const roundRow = await getRoundForUpdate(trx, input.roundId);
    const { session } = await requireRunningCommandSession(trx, activity, "competition.ranking.resolve", input.scope);
    if (session === null) throw new DomainError("SESSION_NOT_RUNNING", `Scope ${input.scope} has no running execution session.`);
    if (roundRow === null) throw new DomainError("NOT_FOUND", "The competition round was not found.");
    if (roundRow.activityId !== activity.id) throw new DomainError("CROSS_ACTIVITY", "The round belongs to another activity.");
    await requireNoFormalFacts(trx, roundRow.id, session.mode);
    const round = requireRound(roundRow, activity.id);
    const resolved = await rankingInput(trx, activity, round, session.mode);
    const ranking = computeRanking({ rows: resolved.rows, tiePolicy: "review" });
    const current = await getCurrentRankingSnapshot(trx, round.id, session.mode);
    const snapshot: StoredRankingSnapshot = {
      id: idFromCommand("ranking", input.commandId),
      activityId: activity.id,
      roundId: round.id,
      mode: session.mode,
      sourceScoreVersion: round.scoreVersion,
      inputFingerprint: resolved.inputFingerprint,
      status: ranking.status,
      rows: ranking.rows,
      tieGroups: decorateTieGroups(ranking.tieGroups),
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
    const { session } = await requireRunningCommandSession(trx, activity, "competition.advancement.finalize", input.scope);
    if (session === null) throw new DomainError("SESSION_NOT_RUNNING", `Scope ${input.scope} has no running execution session.`);
    if (session.mode !== "formal") throw new DomainError("FORMAL_MODE_REQUIRED", "Only a formal execution can advance contestants.");
    const rankingSnapshot = await getCurrentRankingSnapshot(trx, round.id, session.mode);
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
  readonly tieId?: string;
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
    const { session } = await requireRunningCommandSession(trx, activity, "competition.tie.decide", input.scope);
    if (session === null) throw new DomainError("SESSION_NOT_RUNNING", `Scope ${input.scope} has no running execution session.`);
    if (session.mode !== "formal") throw new DomainError("FORMAL_MODE_REQUIRED", "Only a formal execution can decide ties.");
    const current = await getCurrentRankingSnapshot(trx, round.id, session.mode);
    if (current === null || current.id !== input.rankingSnapshotId || current.inputFingerprint !== input.inputFingerprint) {
      throw new DomainError("STALE_RESOLUTION_INPUT", "The ranking snapshot is stale.");
    }
    const ranking = rankingFromSnapshot(current);
    const target = ranking.tieGroups.find((group) =>
      group.contestants.length === input.contestants.length &&
      group.contestants.every((contestant) => input.contestants.includes(contestant)));
    if (input.tieId !== undefined && (target === undefined || tieGroupId(target) !== input.tieId)) {
      throw new DomainError("TIE_DECISION_INVALID", "The tie decision does not target the requested current tie group.");
    }
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
      tieGroups: decorateTieGroups(decided.tieGroups),
      revision: current.revision + 1,
    };
    await insertRankingSnapshot(trx, snapshot);
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
  readonly sourceScoreVersion: number;
  readonly locked: boolean;
  readonly ranking: RankingResult;
}

export interface PodiumCandidateResult {
  readonly status: "candidate" | "hold";
  readonly placements: readonly { readonly place: number; readonly contestantId: string; readonly total: DecimalValue }[];
  readonly sourceRoundIds: readonly string[];
  readonly sourceScoreVersions: readonly { readonly roundId: string; readonly sourceScoreVersion: number }[];
  readonly inputFingerprint: string;
}

export function buildPodiumCandidate(input: { readonly requiredRoundIds: readonly string[]; readonly rounds: readonly PodiumRoundInput[] }): PodiumCandidateResult {
  const sourceRoundIds = input.rounds.map((round) => round.roundId);
  const sourceScoreVersions = input.rounds.map((round) => ({ roundId: round.roundId, sourceScoreVersion: round.sourceScoreVersion }));
  const inputFingerprint = stableHash({
    requiredRoundIds: input.requiredRoundIds,
    rounds: input.rounds.map((round) => ({ roundId: round.roundId, sourceScoreVersion: round.sourceScoreVersion, locked: round.locked, ranking: round.ranking })),
  });
  const required = new Set(input.requiredRoundIds);
  const complete = required.size === input.requiredRoundIds.length &&
    input.rounds.length === input.requiredRoundIds.length &&
    sourceRoundIds.every((roundId) => required.has(roundId)) &&
    input.requiredRoundIds.every((roundId) => sourceRoundIds.includes(roundId));
  if (!complete || input.rounds.some((round) => !round.locked || round.ranking.status !== "ready" || round.ranking.tieGroups.length > 0)) {
    return { status: "hold", placements: [], sourceRoundIds, sourceScoreVersions, inputFingerprint };
  }
  const finalRoundId = input.requiredRoundIds[input.requiredRoundIds.length - 1];
  const rows = input.rounds.find((round) => round.roundId === finalRoundId)?.ranking.rows ?? [];
  return {
    status: "candidate",
    placements: rows.slice(0, 3).map((row, index) => ({
      place: index + 1,
      contestantId: row.contestantId,
      // Normalize totals read back from pre-decimal ranking snapshots so the
      // persisted placement always carries the canonical decimal string.
      total: decimalValue(row.total),
    })),
    sourceRoundIds,
    sourceScoreVersions,
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
    const { session } = await requireRunningCommandSession(trx, activity, "competition.podium.recompute", input.scope);
    if (session === null) throw new DomainError("SESSION_NOT_RUNNING", `Scope ${input.scope} has no running execution session.`);
    if (session.mode !== "formal") throw new DomainError("FORMAL_MODE_REQUIRED", "Only a formal execution can produce podium candidates.");
    const anchorRoundId = input.roundIds[0];
    if (anchorRoundId === undefined) throw new DomainError("INVALID_INPUT", "Podium recomputation needs a frozen competition round.");
    const anchorRound = requireRound(await getRoundForUpdate(trx, anchorRoundId), activity.id);
    const release = await getRelease(trx, activity.id, anchorRound.releaseVersion);
    const plan = release?.capabilities.competition;
    if (plan === undefined || plan.ok !== true) throw new DomainError("RELEASE_SNAPSHOT_INCOMPLETE", "The frozen release has no competition snapshot.");
    const artifact = plan.artifact as { readonly rounds: readonly { readonly key: string }[] };
    const requiredRoundKeys = artifact.rounds.map((round) => round.key);
    const requiredRoundIds = requiredRoundKeys.map((roundKey) => idFromCommand("round", `${activity.id}:${roundKey}`));
    const rounds: PodiumRoundInput[] = [];
    for (const [index, roundKey] of requiredRoundKeys.entries()) {
      const round = await getRoundByKeyForUpdate(trx, activity.id, roundKey);
      const roundId = requiredRoundIds[index] ?? idFromCommand("round", `${activity.id}:${roundKey}`);
      if (round === null) {
        rounds.push({ roundId, sourceScoreVersion: 0, locked: false, ranking: { status: "hold", rows: [], tieGroups: [], inputFingerprint: "missing" } });
        continue;
      }
      if (round.releaseVersion !== anchorRound.releaseVersion) {
        rounds.push({ roundId: round.id, sourceScoreVersion: round.scoreVersion, locked: false, ranking: { status: "hold", rows: [], tieGroups: [], inputFingerprint: "wrong-release" } });
        continue;
      }
      const ranking = await getCurrentRankingSnapshot(trx, round.id, session.mode);
      const rankingReady = ranking !== null && ranking.sourceScoreVersion === round.scoreVersion;
      rounds.push({
        roundId: round.id,
        sourceScoreVersion: ranking?.sourceScoreVersion ?? round.scoreVersion,
        locked: round.state === "locked" && rankingReady,
        ranking: !rankingReady ? { status: "hold", rows: [], tieGroups: [], inputFingerprint: ranking === null ? "missing" : "source-version-mismatch" } : rankingFromSnapshot(ranking),
      });
    }
    const candidate = buildPodiumCandidate({ requiredRoundIds, rounds });
    if (candidate.inputFingerprint !== input.expectedInputFingerprint) throw new DomainError("STALE_RESOLUTION_INPUT", "The podium input fingerprint is stale.");
    const previous = await getLatestPodiumCandidate(trx, activity.id);
    const stored: StoredPodiumCandidate = {
      id: idFromCommand("podium", input.commandId),
      activityId: activity.id,
      inputFingerprint: candidate.inputFingerprint,
      status: candidate.status,
      placements: candidate.placements,
      sourceRoundIds: candidate.sourceRoundIds,
      sourceScoreVersions: candidate.sourceScoreVersions,
      revision: (previous?.revision ?? 0) + 1,
    };
    await insertPodiumCandidate(trx, stored);
    await markConsumedResultsStale(
      trx,
      deps,
      activity.id,
      { kind: "podium_candidate", dependencyIds: stored.sourceRoundIds },
      "The podium candidate was recomputed after the result was confirmed.",
    );
    await appendEngineEvent(trx, deps, {
      type: "StageResultCandidateProduced",
      activityId: activity.id,
      aggregateType: "podium_candidate",
      aggregateId: stored.id,
      revision: stored.revision,
      capability: "competition",
      mode: session.mode,
      scope: session.scope,
      payload: stored,
    });
    return { body: stored, status: 201 };
  });
}
