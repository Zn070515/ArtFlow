import type {
  Database,
  StoredScoreFact,
  StoredRound,
} from "@artflow-plus/db";
import {
  getActivityForUpdate,
  getCurrentPanelForUpdate,
  getJudgeSeatForUpdate,
  getJudgeSeatGrant,
  getJudgeSessionForUpdate,
  getPanelMember,
  getPerformanceForUpdate,
  getPerformanceScoreStateForUpdate,
  getRelease,
  getRoundForUpdate,
} from "@artflow-plus/db";
import type {
  ActorContext,
  CompiledCompetitionArtifact,
} from "@artflow-plus/domain";
import {
  DomainError,
  scoreFactKey,
} from "@artflow-plus/domain";
import type { Kysely } from "kysely";

import { requireRunningCommandSession } from "./command-scope.js";
import {
  stableHash,
} from "./hash.js";
import { requireNoConsumedRound } from "./result-consumption.js";


export interface ScoreActivity {
  readonly id: string;
  readonly status: string;
  readonly activeDefinitionVersion: number;
}

export interface ScoreContextInput {
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
  readonly judgeSessionSeatId?: string;
  readonly contextVersion: number;
  readonly performanceState: "not_opened" | "open" | "locked";
  readonly mode: "test" | "rehearsal" | "formal";
  readonly scope: string;
  readonly rubric: CompiledCompetitionArtifact["rubric"];
}

export function correctionFingerprint(input: {
  readonly scoreFactId: string;
  readonly baseVersion: number;
  readonly panelSnapshotId: string;
  readonly contextVersion: number;
  readonly reason: string;
}): string {
  return stableHash(input);
}

export function requireActive(activity: ScoreActivity): void {
  if (activity.status !== "active") throw new DomainError("ACTIVITY_NOT_ACTIVE", "Scoring requires an active activity.");
}

export function requireStaffScorePermission(actor: ActorContext): void {
  if (!actor.permissions.includes("competition.manage") && !actor.permissions.includes("competition.score.write")) {
    throw new DomainError("FORBIDDEN", "The actor cannot enter a staff score.");
  }
}

export function requireReason(value: string | undefined, code: "SOURCE_REFERENCE_REQUIRED" | "CORRECTION_REQUIRED", label: string): string {
  if (value === undefined || !value.trim()) throw new DomainError(code, `${label} is required.`);
  return value.trim();
}

export async function loadScoreContext(
  trx: Kysely<Database>,
  input: ScoreContextInput,
  allowLockedPerformance: boolean,
  commandType: string,
  judgeSessionToken?: string,
  now?: string,
): Promise<LoadedScoreContext> {
  const activity = await getActivityForUpdate(trx, input.activityId);
  if (activity === null) throw new DomainError("NOT_FOUND", `Activity ${input.activityId} was not found.`);
  requireActive(activity);
  const judgeSession = judgeSessionToken === undefined
    ? null
    : await getJudgeSessionForUpdate(trx, stableHash(judgeSessionToken));
  if (judgeSessionToken !== undefined && (judgeSession === null || judgeSession.activityId !== activity.id || judgeSession.revokedAt !== undefined || Date.parse(judgeSession.expiresAt) <= Date.parse(now ?? new Date().toISOString()))) {
    throw new DomainError("UNAUTHENTICATED", "The judge session is invalid.");
  }
  const round = await getRoundForUpdate(trx, input.roundId);
  if (round === null) throw new DomainError("NOT_FOUND", "The competition round was not found.");
  if (round.activityId !== activity.id) throw new DomainError("CROSS_ACTIVITY", "The round belongs to another activity.");
  if (round.state === "locked") throw new DomainError("ROUND_LOCKED", "The round is locked.");
  await requireNoConsumedRound(
    trx,
    activity.id,
    round.id,
    "RESULT_CONSUMED",
    "A confirmed result consumed this round's scores; unlock it before changing scores.",
  );
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
  if (judgeSession !== null) {
    // A session holds an entry seat (judge_seat_grant). It owns the scoring
    // seat when the ids coincide (direct pairing) or when the entry seat key
    // maps to this panel member (the Live console flow).
    const grant = judgeSession.seatId === seat.id
      ? null
      : await getJudgeSeatGrant(trx, judgeSession.seatId);
    const member = grant === null ? null : await getPanelMember(trx, panel.id, seat.judgeId);
    if (judgeSession.seatId !== seat.id && (grant === null || grant.activityId !== activity.id || grant.seatKey !== member?.seatKey)) {
      throw new DomainError("FORBIDDEN", "The judge session does not own this seat.");
    }
  }
  const release = await getRelease(trx, activity.id, round.releaseVersion);
  if (release === null) throw new DomainError("VERSION_NOT_RELEASED", "The round release is no longer available.");
  const plan = release.capabilities.competition;
  if (plan === undefined || plan.ok !== true) throw new DomainError("RELEASE_SNAPSHOT_INCOMPLETE", "The round has no competition rubric.");
  const { session } = await requireRunningCommandSession(trx, activity, commandType, input.scope);
  if (session.definitionVersion !== round.releaseVersion) throw new DomainError("STALE_CONTEXT", "The execution session is not bound to this round release.");
  return {
    activity,
    round,
    panelId: panel.id,
    performanceId: performance.id,
    contestantId: performance.contestantId,
    judgeId: seat.judgeId,
    ...(judgeSession === null ? {} : { judgeSessionSeatId: judgeSession.seatId }),
    contextVersion: performance.contextVersion,
    performanceState: performance.state,
    mode: session.mode,
    scope: session.scope,
    rubric: (plan.artifact as CompiledCompetitionArtifact).rubric,
  };
}

export function result(fact: StoredScoreFact): ScoreFactResult {
  return { ...fact, key: scoreFactKey(fact.roundId, fact.contestantId, fact.judgeId) };
}
