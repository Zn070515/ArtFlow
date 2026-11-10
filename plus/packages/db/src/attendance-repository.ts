import type { AttendanceSubjectType } from "@artflow-plus/domain";
import type { Kysely, Selectable, Transaction } from "kysely";

import { StaleRevisionError } from "./activity-repository.js";
import type {
  AttendanceCurrentRow,
  AttendancePointRow,
  AttendanceStaffRow,
  Database,
} from "./types.js";

export type AttendanceMode = "formal" | "test";
export type AttendanceStatus = "present" | "undone";

export interface StoredAttendancePoint {
  readonly id: string;
  readonly activityId: string;
  readonly key: string;
  readonly name: string;
  readonly subjectTypes: readonly AttendanceSubjectType[];
  readonly active: boolean;
  readonly revision: number;
  readonly createdBy: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface StoredAttendanceStaff {
  readonly id: string;
  readonly activityId: string;
  readonly displayName: string;
  readonly actorId: string | null;
  readonly active: boolean;
  readonly revision: number;
  readonly createdBy: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface StoredAttendanceCurrent {
  readonly activityId: string;
  readonly mode: AttendanceMode;
  readonly pointKey: string;
  readonly subjectType: AttendanceSubjectType;
  readonly subjectId: string;
  readonly status: AttendanceStatus;
  readonly note: string | null;
  readonly revision: number;
  readonly updatedAt: string;
}

export interface AttendanceFactInput {
  readonly id: string;
  readonly activityId: string;
  readonly mode: AttendanceMode;
  readonly pointKey: string;
  readonly subjectType: AttendanceSubjectType;
  readonly subjectId: string;
  readonly action: "checkin" | "undo";
  readonly note: string | null;
  readonly actorId: string;
  readonly commandId: string;
  readonly occurredAt: string;
}

export interface AttendanceTicketSummary {
  readonly id: string;
  readonly publicCode: string;
  readonly state: string;
}

function iso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : value;
}

function subjectTypesValue(value: unknown): readonly AttendanceSubjectType[] {
  const parsed = typeof value === "string" ? JSON.parse(value) : value;
  if (!Array.isArray(parsed)) return [];
  return parsed.filter((item): item is AttendanceSubjectType =>
    item === "participant" || item === "ticket" || item === "staff",
  );
}

function rowToPoint(row: Selectable<AttendancePointRow>): StoredAttendancePoint {
  return {
    id: row.id,
    activityId: row.activity_id,
    key: row.key,
    name: row.name,
    subjectTypes: subjectTypesValue(row.subject_types),
    active: row.active,
    revision: row.revision,
    createdBy: row.created_by,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

function rowToStaff(row: Selectable<AttendanceStaffRow>): StoredAttendanceStaff {
  return {
    id: row.id,
    activityId: row.activity_id,
    displayName: row.display_name,
    actorId: row.actor_id,
    active: row.active,
    revision: row.revision,
    createdBy: row.created_by,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

function rowToCurrent(row: Selectable<AttendanceCurrentRow>): StoredAttendanceCurrent {
  return {
    activityId: row.activity_id,
    mode: row.mode as AttendanceMode,
    pointKey: row.point_key,
    subjectType: row.subject_type as AttendanceSubjectType,
    subjectId: row.subject_id,
    status: row.status as AttendanceStatus,
    note: row.note,
    revision: row.revision,
    updatedAt: iso(row.updated_at),
  };
}

export async function insertAttendancePoint(
  trx: Transaction<Database>,
  point: StoredAttendancePoint,
): Promise<void> {
  await trx.insertInto("attendance_point").values({
    id: point.id,
    activity_id: point.activityId,
    key: point.key,
    name: point.name,
    subject_types: JSON.stringify(point.subjectTypes),
    active: point.active,
    revision: point.revision,
    created_by: point.createdBy,
    created_at: point.createdAt,
    updated_at: point.updatedAt,
  }).execute();
}

export async function getAttendancePointForUpdate(
  trx: Transaction<Database>,
  activityId: string,
  key: string,
): Promise<StoredAttendancePoint | null> {
  const row = await trx
    .selectFrom("attendance_point")
    .selectAll()
    .where("activity_id", "=", activityId)
    .where("key", "=", key)
    .forUpdate()
    .executeTakeFirst();
  return row === undefined ? null : rowToPoint(row);
}

export async function updateAttendancePoint(
  trx: Transaction<Database>,
  input: {
    readonly activityId: string;
    readonly id: string;
    readonly expectedRevision: number;
    readonly name: string;
    readonly subjectTypes: readonly AttendanceSubjectType[];
    readonly active: boolean;
  },
): Promise<StoredAttendancePoint> {
  const row = await trx
    .updateTable("attendance_point")
    .set({
      name: input.name,
      subject_types: JSON.stringify(input.subjectTypes),
      active: input.active,
      revision: input.expectedRevision + 1,
      updated_at: new Date(),
    })
    .where("activity_id", "=", input.activityId)
    .where("id", "=", input.id)
    .where("revision", "=", input.expectedRevision)
    .returningAll()
    .executeTakeFirst();
  if (row === undefined) throw new StaleRevisionError(input.id);
  return rowToPoint(row);
}

export async function listAttendancePoints(
  db: Kysely<Database>,
  activityId: string,
): Promise<readonly StoredAttendancePoint[]> {
  const rows = await db
    .selectFrom("attendance_point")
    .selectAll()
    .where("activity_id", "=", activityId)
    .orderBy("key")
    .execute();
  return rows.map(rowToPoint);
}

export async function insertAttendanceStaff(
  trx: Transaction<Database>,
  staff: StoredAttendanceStaff,
): Promise<void> {
  await trx.insertInto("attendance_staff").values({
    id: staff.id,
    activity_id: staff.activityId,
    display_name: staff.displayName,
    actor_id: staff.actorId,
    active: staff.active,
    revision: staff.revision,
    created_by: staff.createdBy,
    created_at: staff.createdAt,
    updated_at: staff.updatedAt,
  }).execute();
}

export async function getAttendanceStaffForUpdate(
  trx: Transaction<Database>,
  activityId: string,
  id: string,
): Promise<StoredAttendanceStaff | null> {
  const row = await trx
    .selectFrom("attendance_staff")
    .selectAll()
    .where("activity_id", "=", activityId)
    .where("id", "=", id)
    .forUpdate()
    .executeTakeFirst();
  return row === undefined ? null : rowToStaff(row);
}

export async function updateAttendanceStaff(
  trx: Transaction<Database>,
  input: {
    readonly activityId: string;
    readonly id: string;
    readonly expectedRevision: number;
    readonly displayName: string;
    readonly actorId: string | null;
    readonly active: boolean;
  },
): Promise<StoredAttendanceStaff> {
  const row = await trx
    .updateTable("attendance_staff")
    .set({
      display_name: input.displayName,
      actor_id: input.actorId,
      active: input.active,
      revision: input.expectedRevision + 1,
      updated_at: new Date(),
    })
    .where("activity_id", "=", input.activityId)
    .where("id", "=", input.id)
    .where("revision", "=", input.expectedRevision)
    .returningAll()
    .executeTakeFirst();
  if (row === undefined) throw new StaleRevisionError(input.id);
  return rowToStaff(row);
}

export async function listAttendanceStaff(
  db: Kysely<Database>,
  activityId: string,
): Promise<readonly StoredAttendanceStaff[]> {
  const rows = await db
    .selectFrom("attendance_staff")
    .selectAll()
    .where("activity_id", "=", activityId)
    .orderBy("display_name")
    .orderBy("id")
    .execute();
  return rows.map(rowToStaff);
}

export async function getAttendanceStaff(
  db: Kysely<Database>,
  activityId: string,
  id: string,
): Promise<StoredAttendanceStaff | null> {
  const row = await db
    .selectFrom("attendance_staff")
    .selectAll()
    .where("activity_id", "=", activityId)
    .where("id", "=", id)
    .executeTakeFirst();
  return row === undefined ? null : rowToStaff(row);
}

export async function insertAttendanceFact(
  trx: Transaction<Database>,
  fact: AttendanceFactInput,
): Promise<void> {
  await trx.insertInto("attendance_fact").values({
    id: fact.id,
    activity_id: fact.activityId,
    mode: fact.mode,
    point_key: fact.pointKey,
    subject_type: fact.subjectType,
    subject_id: fact.subjectId,
    action: fact.action,
    note: fact.note,
    actor_id: fact.actorId,
    command_id: fact.commandId,
    occurred_at: fact.occurredAt,
  }).execute();
}

export async function getAttendanceCurrentForUpdate(
  trx: Transaction<Database>,
  input: {
    readonly activityId: string;
    readonly mode: AttendanceMode;
    readonly pointKey: string;
    readonly subjectType: AttendanceSubjectType;
    readonly subjectId: string;
  },
): Promise<StoredAttendanceCurrent | null> {
  const row = await trx
    .selectFrom("attendance_current")
    .selectAll()
    .where("activity_id", "=", input.activityId)
    .where("mode", "=", input.mode)
    .where("point_key", "=", input.pointKey)
    .where("subject_type", "=", input.subjectType)
    .where("subject_id", "=", input.subjectId)
    .forUpdate()
    .executeTakeFirst();
  return row === undefined ? null : rowToCurrent(row);
}

export async function upsertAttendanceCurrent(
  trx: Transaction<Database>,
  current: StoredAttendanceCurrent,
): Promise<StoredAttendanceCurrent> {
  const row = await trx
    .insertInto("attendance_current")
    .values({
      activity_id: current.activityId,
      mode: current.mode,
      point_key: current.pointKey,
      subject_type: current.subjectType,
      subject_id: current.subjectId,
      status: current.status,
      note: current.note,
      revision: current.revision,
      updated_at: current.updatedAt,
    })
    .onConflict((conflict) =>
      conflict
        .columns(["activity_id", "mode", "point_key", "subject_type", "subject_id"])
        .doUpdateSet({
          status: current.status,
          note: current.note,
          revision: current.revision,
          updated_at: current.updatedAt,
        }),
    )
    .returningAll()
    .executeTakeFirstOrThrow();
  return rowToCurrent(row);
}

export async function listAttendanceCurrent(
  db: Kysely<Database>,
  activityId: string,
  mode: AttendanceMode,
): Promise<readonly StoredAttendanceCurrent[]> {
  const rows = await db
    .selectFrom("attendance_current")
    .selectAll()
    .where("activity_id", "=", activityId)
    .where("mode", "=", mode)
    .orderBy("point_key")
    .orderBy("subject_type")
    .orderBy("subject_id")
    .execute();
  return rows.map(rowToCurrent);
}

export async function hasAttendanceCurrentForPointType(
  db: Kysely<Database>,
  activityId: string,
  pointKey: string,
  subjectType: AttendanceSubjectType,
): Promise<boolean> {
  const row = await db
    .selectFrom("attendance_current")
    .select("subject_id")
    .where("activity_id", "=", activityId)
    .where("point_key", "=", pointKey)
    .where("subject_type", "=", subjectType)
    .executeTakeFirst();
  return row !== undefined;
}

export async function listTicketsForAttendance(
  db: Kysely<Database>,
  activityId: string,
): Promise<readonly AttendanceTicketSummary[]> {
  const rows = await db
    .selectFrom("ticket")
    .select(["id", "public_code", "state"])
    .where("activity_id", "=", activityId)
    .orderBy("public_code")
    .execute();
  return rows.map((row) => ({ id: row.id, publicCode: row.public_code, state: row.state }));
}
