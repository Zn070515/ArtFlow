import { fetchActivityAnalytics } from "./analytics.js";
import type { ActivityAnalyticsResponse } from "./analytics.js";
import { fetchLiveState } from "./live.js";
import type { LiveState } from "./live.js";
import { fetchOpsActivities } from "./ops.js";
import type { OpsActivitySummary } from "./ops.js";
import { fetchStudioState } from "./studio.js";
import type { StudioState } from "./studio.js";

export type { ActivityAnalyticsResponse, LiveState };
export type WorkspaceActivity = OpsActivitySummary;
export type { StudioState };

export function fetchWorkspaceActivities(): Promise<readonly WorkspaceActivity[]> {
  return fetchOpsActivities();
}

export function fetchWorkspaceAnalytics(activityId: string): Promise<ActivityAnalyticsResponse> {
  return fetchActivityAnalytics(activityId);
}

export function fetchWorkspaceLiveState(activityId: string): Promise<LiveState> {
  return fetchLiveState(activityId);
}

export function fetchWorkspaceStudioState(activityId: string): Promise<StudioState> {
  return fetchStudioState(activityId);
}
