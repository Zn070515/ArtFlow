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
  options: {
    readonly mode?: "test" | "rehearsal" | "formal";
    readonly limit?: number;
    readonly after?: number;
  } = {},
): Promise<EventFeedView> {
  const params = new URLSearchParams();
  if (options.mode !== undefined) params.set("mode", options.mode);
  if (options.after !== undefined) params.set("after", String(options.after));
  params.set("limit", String(options.limit ?? 20));
  return apiFetch<EventFeedView>(
    `/api/activities/${encodeURIComponent(activityId)}/events?${params.toString()}`,
  );
}

/**
 * The feed is cursor-forward, so "recent events" means starting near the head.
 * One probe call reveals the head, then the window is read forward from there.
 */
export async function fetchRecentEvents(
  activityId: string,
  limit = 20,
): Promise<EventFeedView> {
  const head = await fetchEvents(activityId, { limit: 1 });
  const after = Math.max(0, head.headCursor - limit);
  return fetchEvents(activityId, { after, limit });
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
