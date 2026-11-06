import { apiFetch } from "./client.js";

export interface JudgeRubricCriterion {
  readonly key: string;
  readonly weight: number;
  readonly maximum: number;
  readonly minimum?: number;
}

export interface JudgeScoringTarget {
  readonly seatId: string;
  readonly judgeId: string;
  readonly panelSnapshotId: string;
  readonly roundId: string;
  readonly roundKey: string;
  readonly performanceId: string;
  readonly contextVersion: number;
}

export interface JudgeScoreFact {
  readonly total: string;
  readonly criteria: Readonly<Record<string, number>>;
  readonly notes: string;
  readonly source: string;
}

export interface JudgeContext {
  readonly activity: { readonly id: string; readonly title: string; readonly publicCode: string };
  readonly seat: {
    readonly seatKey: string;
    readonly state: "available" | "claimed" | "revoked";
    readonly judgeId: string | null;
  };
  readonly panel: {
    readonly id: string;
    readonly expectedJudges: number;
    readonly minimumJudges: number;
    readonly contextVersion: number;
  } | null;
  readonly round: { readonly id: string; readonly roundKey: string; readonly state: string } | null;
  readonly performance: {
    readonly id: string;
    readonly contestantId: string;
    readonly sequence: number;
    readonly state: "not_opened" | "open" | "locked";
    readonly contextVersion: number;
  } | null;
  readonly scoring: JudgeScoringTarget | null;
  readonly rubric: { readonly criteria: readonly JudgeRubricCriterion[] } | null;
  readonly existingScore: JudgeScoreFact | null;
}

export interface ClaimedJudgeSeat {
  readonly activityId: string;
  readonly seatId: string;
  readonly seatKey: string;
  readonly sessionId: string;
  readonly expiresAt: string;
}

export function claimJudgeSeat(
  publicCode: string,
  capability: string,
): Promise<ClaimedJudgeSeat> {
  return apiFetch<ClaimedJudgeSeat>("/api/judge-entry/claim", {
    method: "POST",
    headers: { "idempotency-key": crypto.randomUUID() },
    body: JSON.stringify({ publicCode, capability }),
  });
}

export function fetchJudgeContext(): Promise<JudgeContext> {
  return apiFetch<JudgeContext>("/api/judge/context");
}

export function submitJudgeScore(input: {
  readonly activityId: string;
  readonly roundKey: string;
  readonly performanceId: string;
  readonly panelSnapshotId: string;
  readonly seatId: string;
  readonly contextVersion: number;
  readonly criteria: Readonly<Record<string, number>>;
  readonly notes: string;
  readonly scope: string;
}): Promise<unknown> {
  return apiFetch(`/api/activities/${input.activityId}/competition/rounds/${input.roundKey}/scores`, {
    method: "POST",
    headers: { "idempotency-key": crypto.randomUUID() },
    body: JSON.stringify({
      scope: input.scope,
      source: "direct_judge",
      performanceId: input.performanceId,
      panelSnapshotId: input.panelSnapshotId,
      seatId: input.seatId,
      contextVersion: input.contextVersion,
      criteria: input.criteria,
      notes: input.notes,
    }),
  });
}
