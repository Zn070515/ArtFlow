import type {
  AttendanceCheckinBody,
  AttendanceListResponse,
  AttendancePoint,
  AttendanceStaff,
  AttendanceStaffListResponse,
  AttendanceUndoBody,
} from "@artflow-plus/contracts";

import { apiFetch } from "./client.js";

export function fetchAttendance(
  activityId: string,
  query: { point?: string; subjectType?: string; query?: string; mode?: "formal" | "test" } = {},
): Promise<AttendanceListResponse> {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== "") params.set(key, value);
  }
  const suffix = params.toString();
  // One template keeps the consumer graph's path parser happy; an empty query
  // string is valid and normalizes to the same route.
  return apiFetch<AttendanceListResponse>(
    `/api/activities/${encodeURIComponent(activityId)}/attendance?${suffix}`,
  );
}

export function fetchAttendanceStaff(activityId: string): Promise<AttendanceStaffListResponse> {
  return apiFetch<AttendanceStaffListResponse>(
    `/api/activities/${encodeURIComponent(activityId)}/attendance/staff`,
  );
}

export function createAttendancePoint(
  activityId: string,
  body: { key: string; name: string; subjectTypes: readonly string[] },
): Promise<AttendancePoint> {
  return apiFetch<AttendancePoint>(`/api/activities/${encodeURIComponent(activityId)}/attendance/points`, {
    method: "POST",
    headers: { "idempotency-key": crypto.randomUUID() },
    body: JSON.stringify(body),
  });
}

export function updateAttendancePoint(
  activityId: string,
  pointKey: string,
  body: {
    readonly expectedRevision: number;
    readonly name: string;
    readonly subjectTypes: readonly string[];
    readonly active: boolean;
  },
): Promise<AttendancePoint> {
  return apiFetch<AttendancePoint>(
    `/api/activities/${encodeURIComponent(activityId)}/attendance/points/${encodeURIComponent(pointKey)}`,
    {
      method: "POST",
      headers: { "idempotency-key": crypto.randomUUID() },
      body: JSON.stringify(body),
    },
  );
}

export function updateAttendanceStaff(
  activityId: string,
  staffId: string,
  body: {
    readonly expectedRevision: number;
    readonly displayName: string;
    readonly actorId: string | null;
    readonly active: boolean;
  },
): Promise<AttendanceStaff> {
  return apiFetch<AttendanceStaff>(
    `/api/activities/${encodeURIComponent(activityId)}/attendance/staff/${encodeURIComponent(staffId)}`,
    {
      method: "POST",
      headers: { "idempotency-key": crypto.randomUUID() },
      body: JSON.stringify(body),
    },
  );
}

export function addAttendanceStaff(
  activityId: string,
  body: { displayName: string; actorId?: string | null },
): Promise<AttendanceStaff> {
  return apiFetch<AttendanceStaff>(`/api/activities/${encodeURIComponent(activityId)}/attendance/staff`, {
    method: "POST",
    headers: { "idempotency-key": crypto.randomUUID() },
    body: JSON.stringify(body),
  });
}

export function checkInAttendance(activityId: string, body: AttendanceCheckinBody): Promise<unknown> {
  return apiFetch(`/api/activities/${encodeURIComponent(activityId)}/attendance/checkin`, {
    method: "POST",
    headers: { "idempotency-key": crypto.randomUUID() },
    body: JSON.stringify(body),
  });
}

export function undoAttendance(activityId: string, body: AttendanceUndoBody): Promise<unknown> {
  return apiFetch(`/api/activities/${encodeURIComponent(activityId)}/attendance/undo`, {
    method: "POST",
    headers: { "idempotency-key": crypto.randomUUID() },
    body: JSON.stringify(body),
  });
}
