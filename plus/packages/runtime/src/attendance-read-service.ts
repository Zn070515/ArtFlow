import type { Database, StoredAttendancePoint, StoredAttendanceStaff } from "@artflow-plus/db";
import {
  getActivity,
  listAttendanceCurrent,
  listAttendancePoints,
  listAttendanceStaff,
  listRegistrations,
  listTicketsForAttendance,
} from "@artflow-plus/db";
import { DomainError, type AttendanceSubjectType } from "@artflow-plus/domain";
import type { Kysely } from "kysely";

import {
  requireAttendanceEnabled,
  requireAttendanceRead,
  type AttendanceMode,
} from "./attendance-service.js";
import { runtimeActor, type RuntimeDeps } from "./deps.js";

export interface AttendanceRowView {
  readonly pointKey: string;
  readonly subjectType: AttendanceSubjectType;
  readonly subjectId: string;
  readonly label: string;
  readonly eligible: boolean;
  readonly status: "present" | "undone" | "not_checked_in";
  readonly note: string | null;
  readonly updatedAt: string | null;
}

export interface AttendanceSummaryView {
  readonly subjectType: AttendanceSubjectType;
  readonly expected: number;
  readonly present: number;
  readonly undone: number;
}

export interface AttendanceListView {
  readonly activityId: string;
  readonly mode: AttendanceMode;
  readonly points: readonly StoredAttendancePoint[];
  readonly staff: readonly StoredAttendanceStaff[];
  readonly rows: readonly AttendanceRowView[];
  readonly summary: readonly AttendanceSummaryView[];
}

export interface AttendanceListInput {
  readonly activityId: string;
  readonly mode?: AttendanceMode;
  readonly point?: string;
  readonly subjectType?: AttendanceSubjectType;
  readonly query?: string;
  readonly limit?: number;
  readonly offset?: number;
}

function participantLabel(row: { readonly participantId: string; readonly answers: unknown }): string {
  const answers = typeof row.answers === "string"
    ? JSON.parse(row.answers) as Record<string, unknown>
    : row.answers;
  const name = answers !== null && typeof answers === "object"
    ? (answers as Record<string, unknown>).name
    : undefined;
  const text = typeof name === "string" ? name.trim() : "";
  return text.length > 0 ? text : row.participantId;
}

export async function listAttendance(
  db: Kysely<Database>,
  deps: RuntimeDeps,
  input: AttendanceListInput,
): Promise<AttendanceListView> {
  const actor = runtimeActor(deps);
  requireAttendanceRead(actor);
  const activity = await getActivity(db, input.activityId);
  if (activity === null) throw new DomainError("NOT_FOUND", "The activity was not found.");
  requireAttendanceEnabled(activity);
  const mode = input.mode ?? "formal";
  const points = await listAttendancePoints(db, input.activityId);
  const staff = await listAttendanceStaff(db, input.activityId);
  const current = await listAttendanceCurrent(db, input.activityId, mode);
  const currentByKey = new Map(current.map((row) => [
    `${row.pointKey}\u0000${row.subjectType}\u0000${row.subjectId}`,
    row,
  ]));
  const registrations = await listRegistrations(db, input.activityId);
  const tickets = await listTicketsForAttendance(db, input.activityId);

  const rows: AttendanceRowView[] = [];
  for (const point of points) {
    if (input.point !== undefined && point.key !== input.point) continue;
    if (point.subjectTypes.includes("participant")) {
      for (const registration of registrations) {
        const eligible = registration.status === "approved";
        const row = currentByKey.get(`${point.key}\u0000participant\u0000${registration.id}`);
        if (!eligible && row === undefined) continue;
        rows.push({
          pointKey: point.key,
          subjectType: "participant",
          subjectId: registration.id,
          label: participantLabel(registration),
          eligible,
          status: row?.status ?? "not_checked_in",
          note: row?.note ?? null,
          updatedAt: row?.updatedAt ?? null,
        });
      }
    }
    if (point.subjectTypes.includes("ticket")) {
      for (const ticket of tickets) {
        const eligible = ticket.state === "issued" || ticket.state === "redeemed";
        const row = currentByKey.get(`${point.key}\u0000ticket\u0000${ticket.id}`);
        if (!eligible && row === undefined) continue;
        rows.push({
          pointKey: point.key,
          subjectType: "ticket",
          subjectId: ticket.id,
          label: ticket.publicCode,
          eligible,
          status: row?.status ?? "not_checked_in",
          note: row?.note ?? null,
          updatedAt: row?.updatedAt ?? null,
        });
      }
    }
    if (point.subjectTypes.includes("staff")) {
      for (const entry of staff) {
        const eligible = entry.active;
        const row = currentByKey.get(`${point.key}\u0000staff\u0000${entry.id}`);
        if (!eligible && row === undefined) continue;
        rows.push({
          pointKey: point.key,
          subjectType: "staff",
          subjectId: entry.id,
          label: entry.displayName,
          eligible,
          status: row?.status ?? "not_checked_in",
          note: row?.note ?? null,
          updatedAt: row?.updatedAt ?? null,
        });
      }
    }
  }

  const scoped = rows
    .filter((row) => input.subjectType === undefined || row.subjectType === input.subjectType)
    .sort((left, right) =>
      left.pointKey.localeCompare(right.pointKey) ||
      left.subjectType.localeCompare(right.subjectType) ||
      left.label.localeCompare(right.label) ||
      left.subjectId.localeCompare(right.subjectId),
    );
  const query = input.query?.trim().toLowerCase() ?? "";
  const filtered = scoped.filter(
    (row) => query.length === 0 || row.label.toLowerCase().includes(query) || row.subjectId.toLowerCase().includes(query),
  );

  const summary: AttendanceSummaryView[] = (["participant", "ticket", "staff"] as const).map((subjectType) => {
    const eligibleRows = scoped.filter((row) => row.subjectType === subjectType && row.eligible);
    return {
      subjectType,
      expected: eligibleRows.length,
      present: eligibleRows.filter((row) => row.status === "present").length,
      undone: eligibleRows.filter((row) => row.status === "undone").length,
    };
  });

  const limit = Math.min(Math.max(input.limit ?? 200, 1), 500);
  const offset = Math.max(input.offset ?? 0, 0);
  return {
    activityId: input.activityId,
    mode,
    points,
    staff,
    rows: filtered.slice(offset, offset + limit),
    summary,
  };
}

export async function listAttendanceRoster(
  db: Kysely<Database>,
  deps: RuntimeDeps,
  activityId: string,
): Promise<{ readonly activityId: string; readonly staff: readonly StoredAttendanceStaff[] }> {
  const actor = runtimeActor(deps);
  requireAttendanceRead(actor);
  const activity = await getActivity(db, activityId);
  if (activity === null) throw new DomainError("NOT_FOUND", "The activity was not found.");
  requireAttendanceEnabled(activity);
  return { activityId, staff: await listAttendanceStaff(db, activityId) };
}
