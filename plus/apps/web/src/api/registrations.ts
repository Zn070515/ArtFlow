import { apiFetch, ApiError } from "./client.js";

export interface PublicActivity {
  readonly id: string;
  readonly publicCode: string;
  readonly title: string;
  readonly status: string;
  readonly registrationOpen: boolean;
}

export interface RegistrationState {
  readonly id: string;
  readonly activityId: string;
  readonly participantId: string;
  readonly questionnaireVersion: string;
  readonly questionnaireHash: string;
  readonly status: string;
  readonly answers: Readonly<Record<string, unknown>>;
  readonly revision: number;
  readonly reviewNote?: string;
}

export interface RegistrationFileSlot {
  readonly key: string;
  readonly slot: string;
  readonly purpose: string;
  readonly accepts: readonly string[];
  readonly maxBytes?: number;
}

export interface RegistrationQuestion {
  readonly key: string;
  readonly label: string;
  readonly type: "text" | "file" | "notice";
  readonly required: boolean;
  readonly file?: Omit<RegistrationFileSlot, "key">;
}

export interface RegistrationMaterial {
  readonly id: string;
  readonly questionKey: string;
  readonly originalName: string;
  readonly contentType: string;
  readonly byteLength: number;
  readonly status: string;
  readonly revision: number;
}

export interface RegistrationDetail {
  readonly activity: { id: string; title: string; status: string; publicCode: string };
  readonly registration: RegistrationState & { reviewNote?: string };
  readonly questionnaire: {
    readonly version: string;
    readonly questions: readonly RegistrationQuestion[];
    readonly fileSlots: readonly RegistrationFileSlot[];
  };
  readonly materials: readonly RegistrationMaterial[];
}

export async function fetchPublicActivity(publicCode: string): Promise<PublicActivity> {
  return apiFetch<PublicActivity>(`/api/public/activities/${encodeURIComponent(publicCode)}`);
}

export async function fetchMyRegistration(activityId: string): Promise<RegistrationState | null> {
  try {
    return await apiFetch<RegistrationState>(`/api/activities/${activityId}/registrations/mine`);
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) return null;
    throw error;
  }
}

export function startRegistration(activityId: string, commandId: string): Promise<RegistrationState> {
  return apiFetch<RegistrationState>(`/api/activities/${activityId}/registrations`, {
    method: "POST",
    headers: { "idempotency-key": commandId },
    body: "{}",
  });
}

export function fetchRegistrationDetail(
  activityId: string,
  registrationId: string,
): Promise<RegistrationDetail> {
  return apiFetch<RegistrationDetail>(
    `/api/activities/${activityId}/registrations/${registrationId}`,
  );
}

export function saveAnswer(
  activityId: string,
  registrationId: string,
  commandId: string,
  expectedRevision: number,
  questionKey: string,
  value: string,
): Promise<RegistrationState> {
  return apiFetch<RegistrationState>(
    `/api/activities/${activityId}/registrations/${registrationId}/answers`,
    {
      method: "PATCH",
      headers: { "idempotency-key": commandId },
      body: JSON.stringify({ expectedRevision, questionKey, value }),
    },
  );
}

export function submitRegistration(
  activityId: string,
  registrationId: string,
  commandId: string,
  expectedRevision: number,
): Promise<RegistrationState> {
  return apiFetch<RegistrationState>(
    `/api/activities/${activityId}/registrations/${registrationId}/submit`,
    {
      method: "POST",
      headers: { "idempotency-key": commandId },
      body: JSON.stringify({ expectedRevision }),
    },
  );
}

export function uploadMaterialMetadata(
  activityId: string,
  registrationId: string,
  commandId: string,
  input: {
    readonly questionKey: string;
    readonly originalName: string;
    readonly contentType: string;
    readonly byteLength: number;
  },
): Promise<unknown> {
  return apiFetch(
    `/api/activities/${activityId}/registrations/${registrationId}/materials`,
    {
      method: "POST",
      headers: { "idempotency-key": commandId },
      body: JSON.stringify(input),
    },
  );
}
