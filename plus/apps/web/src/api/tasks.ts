import type {
  ReadinessResponse,
  TaskAction,
  TaskCommandBody,
  TaskListResponse,
  TaskResponse,
} from "@artflow-plus/contracts";

import { apiFetch } from "./client.js";

export function fetchTasks(activityId: string): Promise<TaskListResponse> {
  return apiFetch<TaskListResponse>(`/api/activities/${encodeURIComponent(activityId)}/tasks`);
}

export function fetchReadiness(activityId: string): Promise<ReadinessResponse> {
  return apiFetch<ReadinessResponse>(`/api/activities/${encodeURIComponent(activityId)}/readiness`);
}

export function mutateTask(
  activityId: string,
  taskId: string,
  action: TaskAction,
  body: TaskCommandBody,
): Promise<TaskResponse> {
  const { expectedRevision, ...command } = body;
  return apiFetch<TaskResponse>(
    `/api/activities/${encodeURIComponent(activityId)}/tasks/${encodeURIComponent(taskId)}/${action}`,
    {
      method: "POST",
      headers: { "idempotency-key": crypto.randomUUID() },
      body: JSON.stringify({ expectedRevision, ...command }),
    },
  );
}
