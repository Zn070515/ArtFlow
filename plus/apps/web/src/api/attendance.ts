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
  const path = `/api/activities/${encodeURIComponent(activityId)}/attendance`;
  return apiFetch<AttendanceListResponse>(suffix === "" ? path : `${path}?${suffix}`);
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
