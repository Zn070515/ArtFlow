import { ApiError, apiFetch } from "./client.js";

export const JUDGING_SCOPE = "judging";

export interface LiveActivity {
  readonly id: string;
  readonly publicCode: string;
  readonly title: string;
  readonly status: string;
  readonly revision: number;
  readonly enabledCapabilities: readonly string[];
  readonly activeDefinitionVersion: number;
}

export interface LiveRubricCriterion {
  readonly key: string;
  readonly weight: number;
  readonly maximum: number;
  readonly minimum?: number;
}

export interface LiveRoundConfig {
  readonly key: string;
  readonly judgeCount: number;
  readonly minimumJudges: number;
  readonly completion: string;
  readonly advanceCount: number;
  readonly scoringMethod: string;
}

export interface LiveConfig {
  readonly rounds: readonly LiveRoundConfig[];
  readonly rubric: { readonly criteria: readonly LiveRubricCriterion[] };
  readonly tiePolicy: string;
}

export interface LiveSession {
  readonly id: string;
  readonly activityId: string;
  readonly definitionVersion: number;
  readonly contentHash: string;
  readonly scope: string;
  readonly mode: "test" | "rehearsal" | "formal";
  readonly status: "running" | "closed";
  readonly revision: number;
  readonly openedAt: string;
  readonly closedAt?: string;
}

export interface LiveRoundRecord {
  readonly id: string;
  readonly roundKey: string;
  readonly state: "prepared" | "scoring" | "locked" | "resolved";
  readonly revision: number;
  readonly scoreVersion: number;
  readonly judgeCount: number;
  readonly minimumJudges: number;
  readonly currentPanelId: string | null;
}

export interface LivePanel {
  readonly id: string;
  readonly roundId: string;
  readonly version: number;
  readonly state: string;
  readonly expectedJudges: number;
  readonly minimumJudges: number;
  readonly contextVersion: number;
  readonly current: boolean;
}

export interface LiveSeat {
  readonly id: string;
  readonly judgeId: string;
  readonly seatKey: string;
  readonly state: string;
  readonly revision: number;
}

export interface LivePerformance {
  readonly id: string;
  readonly contestantId: string;
  readonly sequence: number;
  readonly state: "not_opened" | "open" | "locked";
  readonly contextVersion: number;
  readonly scoreCount: number;
  readonly expectedJudges: number;
}

export interface LiveRankingRow {
  readonly contestantId: string;
  readonly total: string;
  readonly judgeCount: number;
}

export interface LiveRanking {
  readonly id: string;
  readonly status: "ready" | "hold";
  readonly rows: readonly LiveRankingRow[];
  readonly tieGroups: readonly { readonly total: string; readonly contestants: readonly string[] }[];
  readonly revision: number;
  readonly sourceScoreVersion: number;
}

export interface LiveRound {
  readonly config: LiveRoundConfig;
  readonly round: LiveRoundRecord | null;
  readonly panel: LivePanel | null;
  readonly seats: readonly LiveSeat[];
  readonly performances: readonly LivePerformance[];
  readonly ranking: LiveRanking | null;
}

export interface LiveState {
  readonly activity: LiveActivity;
  readonly config: LiveConfig;
  readonly session: LiveSession | null;
  readonly rounds: readonly LiveRound[];
  readonly participantIds: readonly string[];
}

function commandHeaders(commandId: string): Record<string, string> {
  return { "idempotency-key": commandId };
}

export async function fetchLiveActivities(): Promise<readonly LiveActivity[]> {
  const response = await apiFetch<{ activities: readonly LiveActivity[] }>("/api/activities");
  return response.activities;
}

export function fetchLiveState(activityId: string): Promise<LiveState> {
  return apiFetch<LiveState>(`/api/activities/${activityId}/live`);
}

export function startJudgingSession(
  activityId: string,
  mode: LiveSession["mode"],
): Promise<LiveSession> {
  return apiFetch<LiveSession>(`/api/activities/${activityId}/executions`, {
    method: "POST",
    headers: commandHeaders(crypto.randomUUID()),
    body: JSON.stringify({ scope: JUDGING_SCOPE, mode }),
  });
}

export function closeSession(
  activityId: string,
  sessionId: string,
  expectedRevision: number,
): Promise<LiveSession> {
  return apiFetch<LiveSession>(`/api/activities/${activityId}/executions/${sessionId}/close`, {
    method: "POST",
    headers: commandHeaders(crypto.randomUUID()),
    body: JSON.stringify({ expectedRevision }),
  });
}

export function prepareRound(activityId: string, roundKey: string): Promise<LiveRoundRecord> {
  return apiFetch<LiveRoundRecord>(`/api/activities/${activityId}/competition/rounds`, {
    method: "POST",
    headers: commandHeaders(crypto.randomUUID()),
    body: JSON.stringify({ roundKey, scope: JUDGING_SCOPE }),
  });
}

export function activatePanel(
  activityId: string,
  roundKey: string,
  judges: readonly { readonly judgeId: string; readonly seatKey: string }[],
): Promise<LivePanel> {
  return apiFetch<LivePanel>(
    `/api/activities/${activityId}/competition/rounds/${roundKey}/panel`,
    {
      method: "POST",
      headers: commandHeaders(crypto.randomUUID()),
      body: JSON.stringify({ scope: JUDGING_SCOPE, judges }),
    },
  );
}

export function openPerformance(
  activityId: string,
  roundKey: string,
  input: {
    readonly performanceId: string;
    readonly contestantId: string;
    readonly sequence: number;
  },
): Promise<LivePerformance> {
  return apiFetch<LivePerformance>(
    `/api/activities/${activityId}/competition/rounds/${roundKey}/performances/${input.performanceId}/open`,
    {
      method: "POST",
      headers: commandHeaders(crypto.randomUUID()),
      body: JSON.stringify({
        scope: JUDGING_SCOPE,
        contestantId: input.contestantId,
        sequence: input.sequence,
      }),
    },
  );
}

export function lockPerformance(
  activityId: string,
  roundKey: string,
  performanceId: string,
): Promise<LivePerformance> {
  return apiFetch<LivePerformance>(
    `/api/activities/${activityId}/competition/rounds/${roundKey}/performances/${performanceId}/lock`,
    {
      method: "POST",
      headers: commandHeaders(crypto.randomUUID()),
      body: JSON.stringify({ scope: JUDGING_SCOPE }),
    },
  );
}

export function lockRound(
  activityId: string,
  roundKey: string,
  expectedRevision: number,
): Promise<LiveRoundRecord> {
  return apiFetch<LiveRoundRecord>(
    `/api/activities/${activityId}/competition/rounds/${roundKey}/lock`,
    {
      method: "POST",
      headers: commandHeaders(crypto.randomUUID()),
      body: JSON.stringify({ scope: JUDGING_SCOPE, expectedRevision }),
    },
  );
}

export function resolveRound(activityId: string, roundKey: string): Promise<LiveRanking> {
  return apiFetch<LiveRanking>(
    `/api/activities/${activityId}/competition/rounds/${roundKey}/resolve`,
    {
      method: "POST",
      headers: commandHeaders(crypto.randomUUID()),
      body: JSON.stringify({ scope: JUDGING_SCOPE }),
    },
  );
}

export function fetchRanking(activityId: string, roundKey: string): Promise<LiveRanking> {
  return apiFetch<LiveRanking>(
    `/api/activities/${activityId}/competition/rounds/${roundKey}/ranking?scope=${JUDGING_SCOPE}`,
  );
}

export function reissueJudgeEntry(
  activityId: string,
): Promise<{ readonly version: number; readonly capability: string | null }> {
  return apiFetch(`/api/activities/${activityId}/judge-entry/reissue`, {
    method: "POST",
    headers: commandHeaders(crypto.randomUUID()),
    body: JSON.stringify({ reason: "Live 控制台生成评委入口链接" }),
  });
}

export function judgeEntryUrl(publicCode: string, capability: string): string {
  const origin = typeof window === "undefined" ? "" : window.location.origin;
  return `${origin}/judge/${encodeURIComponent(publicCode)}?capability=${encodeURIComponent(capability)}`;
}

export function describeLiveError(error: unknown, fallback: string): string {
  if (error instanceof ApiError) return error.message;
  if (error instanceof Error && error.message !== "") return error.message;
  return fallback;
}
