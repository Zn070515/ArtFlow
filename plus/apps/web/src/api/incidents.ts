import { apiFetch } from "./client.js";

export type IncidentMode = "test" | "rehearsal" | "formal";
export type IncidentSeverity = "low" | "medium" | "high" | "critical";
export type IncidentCategory =
  | "participant"
  | "judge"
  | "stage"
  | "technical"
  | "safety"
  | "other";
export type IncidentStatus = "open" | "acknowledged" | "resolved";

export interface IncidentView {
  readonly id: string;
  readonly activityId: string;
  readonly mode: IncidentMode;
  readonly severity: IncidentSeverity;
  readonly category: IncidentCategory;
  readonly status: IncidentStatus;
  readonly title: string;
  readonly detail: string;
  readonly location: string;
  readonly relatedType: string | null;
  readonly relatedId: string | null;
  readonly assigneeId: string | null;
  readonly resolution: string;
  readonly openedBy: string;
  readonly revision: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

function headers(): Record<string, string> {
  return {
    "content-type": "application/json",
    "idempotency-key": crypto.randomUUID(),
  };
}

export async function fetchIncidents(
  activityId: string,
  mode: IncidentMode,
  signal?: AbortSignal,
): Promise<readonly IncidentView[]> {
  const response = await apiFetch<{ incidents: readonly IncidentView[] }>(
    `/api/activities/${activityId}/incidents?mode=${mode}`,
    { signal },
  );
  return response.incidents;
}

export function openIncident(
  activityId: string,
  input: {
    readonly mode: IncidentMode;
    readonly severity: IncidentSeverity;
    readonly category: IncidentCategory;
    readonly title: string;
    readonly detail?: string;
    readonly location?: string;
  },
): Promise<IncidentView> {
  return apiFetch(`/api/activities/${activityId}/incidents`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify(input),
  });
}

export function acknowledgeIncident(
  activityId: string,
  incidentId: string,
  expectedRevision: number,
): Promise<IncidentView> {
  return apiFetch(`/api/activities/${activityId}/incidents/${incidentId}/acknowledge`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({ expectedRevision }),
  });
}

export function resolveIncident(
  activityId: string,
  incidentId: string,
  expectedRevision: number,
  resolution: string,
): Promise<IncidentView> {
  return apiFetch(`/api/activities/${activityId}/incidents/${incidentId}/resolve`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({ expectedRevision, resolution }),
  });
}

export function reopenIncident(
  activityId: string,
  incidentId: string,
  expectedRevision: number,
  reason: string,
): Promise<IncidentView> {
  return apiFetch(`/api/activities/${activityId}/incidents/${incidentId}/reopen`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({ expectedRevision, reason }),
  });
}
