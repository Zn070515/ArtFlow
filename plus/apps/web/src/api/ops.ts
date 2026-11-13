import { apiFetch } from "./client.js";

export interface OpsActivitySummary {
  readonly id: string;
  readonly publicCode: string;
  readonly title: string;
  readonly status: string;
  readonly revision: number;
  readonly enabledCapabilities: readonly string[];
}

export interface OpsRegistration {
  readonly id: string;
  readonly activityId: string;
  readonly participantId: string;
  readonly questionnaireVersion: string;
  readonly questionnaireHash: string;
  readonly status: string;
  readonly answers: Readonly<Record<string, unknown>>;
  readonly revision: number;
  readonly reviewNote?: string;
  readonly reviewedBy?: string;
}

export type OpsRoster =
  | { readonly status: "unknown"; readonly revision: number }
  | {
      readonly status: "final";
      readonly revision: number;
      readonly approvedCount: number;
      readonly finalizedAt: string;
    };

export type ReviewStatus = "approved" | "need_supplement" | "rejected";

export async function fetchOpsActivities(): Promise<readonly OpsActivitySummary[]> {
  const response = await apiFetch<{ activities: readonly OpsActivitySummary[] }>("/api/activities");
  return response.activities;
}

export async function fetchOpsRegistrations(
  activityId: string,
): Promise<readonly OpsRegistration[]> {
  const response = await apiFetch<{ registrations: readonly OpsRegistration[] }>(
    `/api/activities/${activityId}/registrations`,
  );
  return response.registrations;
}

export async function fetchOpsRoster(activityId: string): Promise<OpsRoster> {
  const response = await apiFetch<{ roster: OpsRoster }>(`/api/activities/${activityId}/roster`);
  return response.roster;
}

export async function reviewRegistration(
  activityId: string,
  registrationId: string,
  commandId: string,
  expectedRevision: number,
  status: ReviewStatus,
  note: string,
): Promise<OpsRegistration> {
  return apiFetch<OpsRegistration>(
    `/api/activities/${activityId}/registrations/${registrationId}/review`,
    {
      method: "POST",
      headers: { "idempotency-key": commandId },
      body: JSON.stringify({ expectedRevision, status, note }),
    },
  );
}

export function closeActivity(
  activityId: string,
  expectedRevision: number,
): Promise<unknown> {
  return apiFetch(`/api/activities/${activityId}/close`, {
    method: "POST",
    headers: { "idempotency-key": crypto.randomUUID() },
    body: JSON.stringify({ expectedRevision }),
  });
}

export function unarchiveActivity(
  activityId: string,
  expectedRevision: number,
  note: string,
): Promise<unknown> {
  return apiFetch(`/api/activities/${activityId}/unarchive`, {
    method: "POST",
    headers: { "idempotency-key": crypto.randomUUID() },
    body: JSON.stringify({ expectedRevision, note }),
  });
}

export function archiveActivity(
  activityId: string,
  expectedRevision: number,
  note: string,
): Promise<unknown> {
  return apiFetch(`/api/activities/${activityId}/archive`, {
    method: "POST",
    headers: { "idempotency-key": crypto.randomUUID() },
    body: JSON.stringify({ expectedRevision, note }),
  });
}

export function finalizeRoster(
  activityId: string,
  commandId: string,
  expectedRevision: number,
): Promise<OpsRoster> {
  return apiFetch<OpsRoster>(`/api/activities/${activityId}/roster/finalize`, {
    method: "POST",
    headers: { "idempotency-key": commandId },
    body: JSON.stringify({ expectedRevision }),
  });
}

export interface IssuedSupplementView {
  readonly token: string | null;
  readonly expiresAt: string;
  readonly allowedKeys: readonly string[];
}

export function issueSupplement(
  activityId: string,
  registrationId: string,
  allowedKeys: readonly string[],
  commandId: string,
): Promise<IssuedSupplementView> {
  return apiFetch(
    `/api/activities/${encodeURIComponent(activityId)}/registrations/${encodeURIComponent(registrationId)}/supplement`,
    {
      method: "POST",
      headers: { "idempotency-key": commandId },
      body: JSON.stringify({ allowedKeys }),
    },
  );
}

export function reopenRoster(
  activityId: string,
  commandId: string,
  expectedRevision: number,
  reason: string,
): Promise<OpsRoster> {
  return apiFetch<OpsRoster>(`/api/activities/${activityId}/roster/reopen`, {
    method: "POST",
    headers: { "idempotency-key": commandId },
    body: JSON.stringify({ expectedRevision, reason }),
  });
}

