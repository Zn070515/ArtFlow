import { apiFetch } from "./client.js";

export interface RuntimeEventView {
  readonly sequence: number;
  readonly type: string;
  readonly occurredAt: string;
  readonly capability: string;
  readonly aggregateId: string;
  readonly revision: number;
  readonly mode?: string;
  readonly scope?: string;
}

export interface EventFeedView {
  readonly events: readonly RuntimeEventView[];
  readonly nextCursor: number;
  readonly headCursor: number;
}

export interface ExecutionStateView {
  readonly lastSequence: number;
  readonly headSequence: number;
  readonly stale: boolean;
  readonly status: "running" | "blocked";
  readonly blockedSequence?: number;
  readonly blockedReason?: string;
}

export interface OutboxHealthView {
  readonly headSequence: number;
  readonly publishedHeadSequence: number;
  readonly pendingCount: number;
}

export function fetchEvents(
  activityId: string,
  options: { readonly mode?: "test" | "rehearsal" | "formal"; readonly limit?: number } = {},
): Promise<EventFeedView> {
  const params = new URLSearchParams();
  if (options.mode !== undefined) params.set("mode", options.mode);
  params.set("limit", String(options.limit ?? 20));
  return apiFetch<EventFeedView>(
    `/api/activities/${encodeURIComponent(activityId)}/events?${params.toString()}`,
  );
}

export function fetchExecutionState(
  activityId: string,
  mode: "test" | "rehearsal" | "formal" = "formal",
): Promise<ExecutionStateView> {
  return apiFetch<ExecutionStateView>(
    `/api/activities/${encodeURIComponent(activityId)}/execution-state?mode=${mode}`,
  );
}

export function fetchOutboxHealth(): Promise<OutboxHealthView> {
  return apiFetch<OutboxHealthView>("/api/operations/outbox");
}
