import type {
  Database,
  SessionRecord,
  StoredJudgeEntrySeat,
  StoredJudgeSeat,
  StoredPanelSnapshot,
  StoredPerformance,
  StoredRankingSnapshot,
  StoredRound,
  StoredScoreFact,
} from "@artflow-plus/db";
import {
  countCurrentScoreFactsForContext,
  findRunningSessionByScope,
  getActivitySummary,
  getCurrentRankingSnapshot,
  getJudgeSeatByPanelAndJudge,
  getJudgeSeatGrant,
  getPanel,
  getPanelMember,
  getRelease,
  getRound,
  listApprovedParticipantIds,
  listCurrentPanelMembersBySeatKey,
  listCurrentScoreFactsForJudge,
  listJudgeSeatsForPanel,
  listRoundPerformances,
  listRoundsForActivity,
} from "@artflow-plus/db";
import type {
  CompiledCompetitionArtifact,
  CompetitionRubricDefinition,
  CompetitionRoundDefinition,
  ExecutionMode,
} from "@artflow-plus/domain";
import { DomainError, hasPermission } from "@artflow-plus/domain";
import type { Kysely } from "kysely";

import { runtimeActor, type RuntimeDeps } from "./deps.js";
import { authenticateJudgeSession } from "./voting-ticket-service.js";

export interface LivePerformance extends StoredPerformance {
  readonly scoreCount: number;
  readonly expectedJudges: number;
}

export interface LiveSeat extends StoredJudgeSeat {
  readonly seatKey: string;
}

export interface LiveRoundState {
  readonly config: CompetitionRoundDefinition;
  readonly round: StoredRound | null;
  readonly panel: StoredPanelSnapshot | null;
  readonly seats: readonly LiveSeat[];
  readonly performances: readonly LivePerformance[];
  readonly ranking: StoredRankingSnapshot | null;
}

export interface LiveState {
  readonly activity: {
    readonly id: string;
    readonly publicCode: string;
    readonly title: string;
    readonly status: string;
    readonly revision: number;
    readonly enabledCapabilities: readonly string[];
    readonly activeDefinitionVersion: number;
  };
  readonly config: CompiledCompetitionArtifact;
  readonly session: SessionRecord | null;
  readonly rounds: readonly LiveRoundState[];
  readonly participantIds: readonly string[];
}

function requireLiveAccess(actor: Parameters<typeof hasPermission>[0]): void {
  if (!hasPermission(actor, "competition.manage") && !hasPermission(actor, "judge.manage")) {
    throw new DomainError("FORBIDDEN", "One of competition.manage or judge.manage is required.");
  }
}

export async function getLiveState(
  db: Kysely<Database>,
  deps: RuntimeDeps,
  activityId: string,
): Promise<LiveState> {
  const actor = runtimeActor(deps);
  requireLiveAccess(actor);
  const activity = await getActivitySummary(db, activityId);
  if (activity === null) throw new DomainError("NOT_FOUND", "The activity was not found.");
  const release = await getRelease(db, activityId, activity.activeDefinitionVersion);
  if (release === null) throw new DomainError("VERSION_NOT_RELEASED", "The activity has no released definition.");
  const plan = release.capabilities.competition;
  if (plan === undefined || plan.ok !== true) {
    throw new DomainError("RELEASE_SNAPSHOT_INCOMPLETE", "The release has no competition snapshot.");
  }
  const config = plan.artifact as CompiledCompetitionArtifact;
  const session = await findRunningSessionByScope(db, activityId, "judging");
  const mode = session?.mode ?? "formal";
  const roundRows = await listRoundsForActivity(db, activityId);
  const rounds: LiveRoundState[] = [];

  for (const roundConfig of config.rounds) {
    const round = roundRows.find((candidate) => candidate.roundKey === roundConfig.key) ?? null;
    const panel = round?.currentPanelId === null || round === null
      ? null
      : await getPanel(db, round.currentPanelId);
    const seatRows = panel === null ? [] : await listJudgeSeatsForPanel(db, panel.id);
    const seats: LiveSeat[] = await Promise.all(
      seatRows.map(async (seat) => {
        const member = panel === null ? null : await getPanelMember(db, panel.id, seat.judgeId);
        return { ...seat, seatKey: member?.seatKey ?? "" };
      }),
    );
    const performances = round === null ? [] : await listRoundPerformances(db, round.id);
    const livePerformances: LivePerformance[] = [];
    for (const performance of performances) {
      const scoreCount = panel === null
        ? 0
        : await countCurrentScoreFactsForContext(db, {
            performanceId: performance.id,
            panelSnapshotId: panel.id,
            contextVersion: performance.contextVersion,
            mode,
          });
      livePerformances.push({
        ...performance,
        scoreCount,
        expectedJudges: panel?.expectedJudges ?? roundConfig.judgeCount,
      });
    }
    rounds.push({
      config: roundConfig,
      round,
      panel,
      seats,
      performances: livePerformances,
      ranking: round === null ? null : await getCurrentRankingSnapshot(db, round.id, mode),
    });
  }

  return {
    activity: {
      id: activity.id,
      publicCode: activity.publicCode,
      title: activity.title,
      status: activity.status,
      revision: activity.revision,
      enabledCapabilities: activity.enabledCapabilities,
      activeDefinitionVersion: activity.activeDefinitionVersion,
    },
    config,
    session,
    rounds,
    participantIds: await listApprovedParticipantIds(db, activityId),
  };
}

export interface JudgeSeatSummary {
  readonly seatKey: string;
  readonly state: StoredJudgeEntrySeat["state"];
  readonly judgeId: string | null;
}

/** The identifiers a judge needs to submit one score fact for the open performance. */
export interface JudgeScoringTarget {
  readonly seatId: string;
  readonly judgeId: string;
  readonly panelSnapshotId: string;
  readonly roundId: string;
  readonly roundKey: string;
  readonly performanceId: string;
  readonly contextVersion: number;
}

export interface JudgeContext {
  readonly activity: { readonly id: string; readonly title: string; readonly publicCode: string };
  readonly seat: JudgeSeatSummary;
  readonly panel: StoredPanelSnapshot | null;
  readonly round: StoredRound | null;
  readonly performance: StoredPerformance | null;
  readonly scoring: JudgeScoringTarget | null;
  readonly rubric: CompetitionRubricDefinition | null;
  readonly mode: ExecutionMode;
  readonly existingScore: StoredScoreFact | null;
}

interface ResolvedJudgePanel {
  readonly panel: StoredPanelSnapshot;
  readonly round: StoredRound;
  readonly performance: StoredPerformance | null;
  readonly judgeId: string;
}

/**
 * A judge session owns an entry seat (judge_seat_grant), not a competition
 * seat. The entry seat's key maps it to the member of the current panel; the
 * round with an open performance wins when several rounds share the key.
 */
async function resolveJudgePanel(
  db: Kysely<Database>,
  activityId: string,
  seatKey: string,
): Promise<ResolvedJudgePanel | null> {
  const members = await listCurrentPanelMembersBySeatKey(db, activityId, seatKey);
  let fallback: ResolvedJudgePanel | null = null;
  for (const member of members) {
    const panel = await getPanel(db, member.panelId);
    if (panel === null || !panel.current) continue;
    const round = await getRound(db, member.roundId);
    if (round === null) continue;
    const performances = await listRoundPerformances(db, round.id);
    const performance = performances.find((candidate) => candidate.state === "open") ?? null;
    const resolved: ResolvedJudgePanel = { panel, round, performance, judgeId: member.judgeId };
    if (performance !== null) return resolved;
    fallback ??= resolved;
  }
  return fallback;
}

export async function getJudgeContext(
  db: Kysely<Database>,
  judgeToken: string,
): Promise<JudgeContext> {
  const session = await authenticateJudgeSession(db, judgeToken);
  const grant = await getJudgeSeatGrant(db, session.seatId);
  if (grant === null || grant.activityId !== session.activityId) {
    throw new DomainError("UNAUTHENTICATED", "The judge seat is no longer available.");
  }
  const activity = await getActivitySummary(db, session.activityId);
  if (activity === null) throw new DomainError("NOT_FOUND", "The activity was not found.");
  const release = await getRelease(db, session.activityId, activity.activeDefinitionVersion);
  const plan = release?.capabilities.competition;
  const artifact = plan !== undefined && plan.ok === true
    ? (plan.artifact as CompiledCompetitionArtifact)
    : null;
  const running = await findRunningSessionByScope(db, session.activityId, "judging");
  const mode = running?.mode ?? "formal";
  const resolved = await resolveJudgePanel(db, session.activityId, grant.seatKey);
  const seat: JudgeSeatSummary = {
    seatKey: grant.seatKey,
    state: grant.state,
    judgeId: resolved?.judgeId ?? null,
  };
  const base = {
    activity: { id: activity.id, title: activity.title, publicCode: activity.publicCode },
    seat,
    rubric: artifact?.rubric ?? null,
    mode,
  };
  if (resolved === null) {
    return { ...base, panel: null, round: null, performance: null, scoring: null, existingScore: null };
  }
  const scoringSeat = await getJudgeSeatByPanelAndJudge(db, resolved.panel.id, resolved.judgeId);
  const performance = resolved.performance;
  const scores = await listCurrentScoreFactsForJudge(db, resolved.round.id, resolved.judgeId, mode);
  const existingScore = performance === null
    ? null
    : scores.find((score) => score.contestantId === performance.contestantId) ?? null;
  const scoring: JudgeScoringTarget | null =
    performance === null || scoringSeat === null || scoringSeat.state !== "assigned"
      ? null
      : {
          seatId: scoringSeat.id,
          judgeId: resolved.judgeId,
          panelSnapshotId: resolved.panel.id,
          roundId: resolved.round.id,
          roundKey: resolved.round.roundKey,
          performanceId: performance.id,
          contextVersion: performance.contextVersion,
        };
  return {
    ...base,
    panel: resolved.panel,
    round: resolved.round,
    performance,
    scoring,
    existingScore,
  };
}
