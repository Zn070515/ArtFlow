import { apiFetch } from "./client.js";

export type ScheduleMode = "test" | "rehearsal" | "formal";

export interface ScheduleEntryView {
  readonly id: string;
  readonly activityId: string;
  readonly mode: ScheduleMode;
  readonly position: number;
  readonly slotKey: string;
  readonly slotLabel: string;
  readonly participantId: string | null;
  readonly title: string;
  readonly note: string;
  readonly revision: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface ScheduleReleaseView {
  readonly id: string;
  readonly activityId: string;
  readonly mode: ScheduleMode;
  readonly version: number;
  readonly note: string;
  readonly releasedAt: string;
  readonly revokedAt: string | null;
  readonly snapshot: {
    readonly entries: readonly {
      readonly order: number;
      readonly slotKey: string;
      readonly slotLabel: string;
      readonly participantId: string | null;
      readonly title: string;
      readonly note: string;
    }[];
  };
}

export interface ScheduleView {
  readonly revision: number;
  readonly entries: readonly ScheduleEntryView[];
  readonly releases: readonly ScheduleReleaseView[];
  readonly currentEntryId: string | null;
  readonly slots: readonly {
    readonly key: string;
    readonly label: string;
    readonly durationMinutes: number;
    readonly kind: "program" | "break" | "ceremony";
  }[];
}

function commandHeaders(): Record<string, string> {
  return {
    "content-type": "application/json",
    "idempotency-key": crypto.randomUUID(),
  };
}

export function fetchSchedule(
  activityId: string,
  mode: ScheduleMode,
  signal?: AbortSignal,
): Promise<ScheduleView> {
  return apiFetch(`/api/activities/${activityId}/schedule?mode=${mode}`, { signal });
}

export function upsertScheduleEntry(
  activityId: string,
  input: {
    readonly mode: ScheduleMode;
    readonly expectedRevision: number;
    readonly entryId?: string;
    readonly slotKey: string;
    readonly participantId?: string | null;
    readonly title: string;
    readonly note?: string;
    readonly position?: number;
  },
): Promise<unknown> {
  return apiFetch(`/api/activities/${activityId}/schedule/entries`, {
    method: "POST",
    headers: commandHeaders(),
    body: JSON.stringify(input),
  });
}

export function reorderSchedule(
  activityId: string,
  input: {
    readonly mode: ScheduleMode;
    readonly expectedRevision: number;
    readonly orderedIds: readonly string[];
  },
): Promise<ScheduleView> {
  return apiFetch(`/api/activities/${activityId}/schedule/reorder`, {
    method: "POST",
    headers: commandHeaders(),
    body: JSON.stringify(input),
  });
}

export function removeScheduleEntry(
  activityId: string,
  input: {
    readonly mode: ScheduleMode;
    readonly expectedRevision: number;
    readonly entryId: string;
  },
): Promise<unknown> {
  return apiFetch(
    `/api/activities/${activityId}/schedule/entries/${encodeURIComponent(input.entryId)}/remove`,
    {
      method: "POST",
      headers: commandHeaders(),
      body: JSON.stringify({ mode: input.mode, expectedRevision: input.expectedRevision }),
    },
  );
}

export function releaseSchedule(
  activityId: string,
  input: {
    readonly mode: ScheduleMode;
    readonly expectedRevision: number;
    readonly note?: string;
  },
): Promise<ScheduleReleaseView> {
  return apiFetch(`/api/activities/${activityId}/schedule/release`, {
    method: "POST",
    headers: commandHeaders(),
    body: JSON.stringify(input),
  });
}

export function revokeScheduleRelease(
  activityId: string,
  releaseId: string,
  expectedRevision: number,
  note: string,
): Promise<ScheduleReleaseView> {
  return apiFetch(
    `/api/activities/${activityId}/schedule/releases/${encodeURIComponent(releaseId)}/revoke`,
    {
      method: "POST",
      headers: commandHeaders(),
      body: JSON.stringify({ expectedRevision, note }),
    },
  );
}

export function advanceSchedule(
  activityId: string,
): Promise<{ readonly currentEntryId: string; readonly nextEntryId: string | null; readonly mode: ScheduleMode }> {
  return apiFetch(`/api/activities/${activityId}/schedule/advance`, {
    method: "POST",
    headers: commandHeaders(),
    body: JSON.stringify({}),
  });
}
