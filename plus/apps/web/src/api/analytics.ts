import type { ActivityAnalyticsResponse } from "@artflow-plus/contracts";

import { apiFetch } from "./client.js";

export type { ActivityAnalyticsResponse } from "@artflow-plus/contracts";

export function fetchActivityAnalytics(activityId: string): Promise<ActivityAnalyticsResponse> {
  return apiFetch<ActivityAnalyticsResponse>(`/api/activities/${encodeURIComponent(activityId)}/operations/analytics`);
}
