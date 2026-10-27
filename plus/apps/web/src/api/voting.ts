import type { VotingSessionsSnapshot } from "@artflow-plus/contracts";

import { apiFetch } from "./client.js";

export interface ExecutionSessionView {
  readonly id: string;
  readonly activityId: string;
  readonly definitionVersion: number;
  readonly scope: string;
  readonly mode: "test" | "rehearsal" | "formal";
  readonly status: "running" | "closed";
  readonly revision: number;
}

export interface PublishingStateView {
  readonly stages: readonly { readonly key: string; readonly label: string }[];
}

export interface VoteResultCandidateView {
  readonly sessionId: string;
  readonly sessionRevision: number;
  readonly mode: string;
  readonly totalBallots: number;
  readonly status: "ready" | "hold";
  readonly holdReason?: "NO_VALID_BALLOTS";
  readonly inputFingerprint: string;
  readonly decisions: readonly {
    readonly rank: number;
    readonly contestantId: string;
    readonly score: string;
    readonly count: number;
    readonly unit: "percent";
  }[];
}

function commandId(prefix: string): string {
  return `${prefix}-${crypto.randomUUID()}`;
}

export async function fetchVotingSessions(activityId: string): Promise<VotingSessionsSnapshot> {
  return apiFetch<VotingSessionsSnapshot>(`/api/activities/${activityId}/voting/sessions`);
}

export async function fetchExecutions(activityId: string): Promise<readonly ExecutionSessionView[]> {
  const response = await apiFetch<{ sessions: readonly ExecutionSessionView[] }>(
    `/api/activities/${activityId}/executions`,
  );
  return response.sessions;
}

export async function startExecution(
  activityId: string,
  scope: string,
): Promise<ExecutionSessionView> {
  return apiFetch<ExecutionSessionView>(`/api/activities/${activityId}/executions`, {
    method: "POST",
    headers: { "idempotency-key": commandId("execution-start") },
    body: JSON.stringify({ scope, mode: "formal" }),
  });
}

export async function closeExecution(
  activityId: string,
  sessionId: string,
  expectedRevision: number,
): Promise<ExecutionSessionView> {
  return apiFetch<ExecutionSessionView>(
    `/api/activities/${activityId}/executions/${sessionId}/close`,
    {
      method: "POST",
      headers: { "idempotency-key": commandId("execution-close") },
      body: JSON.stringify({ expectedRevision }),
    },
  );
}

export async function openVoteSession(
  activityId: string,
  candidateIds: readonly string[],
): Promise<unknown> {
  return apiFetch(`/api/activities/${activityId}/voting/sessions`, {
    method: "POST",
    headers: { "idempotency-key": commandId("vote-open") },
    body: JSON.stringify({
      sessionId: `vote-${crypto.randomUUID()}`,
      scope: "voting",
      candidateIds,
    }),
  });
}

export async function closeVoteSession(
  activityId: string,
  sessionId: string,
  expectedRevision: number,
): Promise<unknown> {
  return apiFetch(`/api/activities/${activityId}/voting/sessions/${sessionId}/close`, {
    method: "POST",
    headers: { "idempotency-key": commandId("vote-close") },
    body: JSON.stringify({ scope: "voting", expectedRevision }),
  });
}

export async function fetchPublishingState(activityId: string): Promise<PublishingStateView> {
  return apiFetch<PublishingStateView>(`/api/activities/${activityId}/publishing/state`);
}

export async function previewVoteResult(
  activityId: string,
  sessionId: string,
): Promise<VoteResultCandidateView> {
  return apiFetch<VoteResultCandidateView>(
    `/api/activities/${activityId}/publishing/vote-results/${sessionId}`,
  );
}

export async function confirmVoteResult(
  activityId: string,
  stageKey: string,
  candidate: VoteResultCandidateView,
): Promise<{ readonly candidateRevision: number }> {
  return apiFetch(`/api/activities/${activityId}/publishing/stage-results/${stageKey}/confirm-vote`, {
    method: "POST",
    headers: { "idempotency-key": commandId("vote-confirm") },
    body: JSON.stringify({
      scope: "publishing",
      voteSessionId: candidate.sessionId,
      expectedSessionRevision: candidate.sessionRevision,
      expectedInputFingerprint: candidate.inputFingerprint,
      awards: [],
    }),
  });
}

export async function releaseVoteResult(
  activityId: string,
  stageKey: string,
  expectedCandidateRevision: number,
  note: string,
): Promise<unknown> {
  return apiFetch(`/api/activities/${activityId}/publishing/releases`, {
    method: "POST",
    headers: { "idempotency-key": commandId("vote-release") },
    body: JSON.stringify({ stageKey, scope: "publishing", expectedCandidateRevision, note }),
  });
}
