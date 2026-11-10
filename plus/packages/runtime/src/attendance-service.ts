import type {
  Database,
  StoredAttendanceCurrent,
  StoredAttendancePoint,
  StoredAttendanceStaff,
} from "@artflow-plus/db";
import {
  getActivity,
  getActivityForUpdate,
  getAttendanceCurrentForUpdate,
  getAttendancePointForUpdate,
  getAttendanceStaff,
  getAttendanceStaffForUpdate,
  getRegistration,
  getTicket,
  hasAttendanceCurrentForPointType,
  insertAttendanceFact,
  insertAttendancePoint,
  insertAttendanceStaff,
  listAttendanceCurrent,
  listAttendancePoints,
  listAttendanceStaff,
  listRegistrations,
  listTicketsForAttendance,
  updateAttendancePoint,
  updateAttendanceStaff,
  upsertAttendanceCurrent,
} from "@artflow-plus/db";
import {
  DomainError,
  hasPermission,
  requirePermission,
  type ActorContext,
  type AttendanceSubjectType,
} from "@artflow-plus/domain";
import type { Kysely, Transaction } from "kysely";

import { executeCommand, type CommandOutcome } from "./command.js";
import { requireRunningCommandSession } from "./command-scope.js";
import { runtimeActor, type RuntimeDeps } from "./deps.js";
import { appendEngineEvent } from "./events.js";
import { idFromCommand } from "./hash.js";

export type AttendanceMode = "formal" | "test";

const ATTENDANCE_READ_PERMISSIONS = [
  "attendance.manage",
  "studio.manage",
  "competition.manage",
  "judge.manage",
  "registration.manage",
  "registration.review",
  "materials.manage",
  "materials.review",
  "grouping.manage",
  "voting.manage",
  "result.manage",
  "archive.manage",
  "ticket.manage",
] as const;

function withActor(deps: RuntimeDeps, actor: ActorContext): RuntimeDeps {
  return { ...deps, actor };
}

function requireAttendanceRead(actor: ActorContext): void {
  if (!ATTENDANCE_READ_PERMISSIONS.some((permission) => hasPermission(actor, permission))) {
    throw new DomainError("FORBIDDEN", "An attendance read permission is required.");
  }
}

function requireAttendanceEnabled(activity: { readonly enabledCapabilities: readonly string[] }): void {
  if (!activity.enabledCapabilities.includes("attendance")) {
    throw new DomainError("CAPABILITY_NOT_ENABLED", "The attendance capability is not enabled on this activity.");
  }
}

function requireActive(activity: { readonly status: string }): void {
  if (activity.status !== "active") {
    throw new DomainError("ACTIVITY_NOT_ACTIVE", "Attendance changes require an active activity.");
  }
}

function normalizeNote(value: string | undefined): string | null {
  const note = value?.trim() ?? "";
  if (note.length > 500) throw new DomainError("INVALID_INPUT", "The note may not exceed 500 characters.");
  return note.length === 0 ? null : note;
}

function normalizeName(value: string, label: string): string {
  const name = value.trim();
  if (name.length === 0 || name.length > 120) {
    throw new DomainError("INVALID_INPUT", `${label} must be 1-120 characters.`);
  }
  return name;
}

function requireSubjectType(value: string): AttendanceSubjectType {
  if (value !== "participant" && value !== "ticket" && value !== "staff") {
    throw new DomainError("INVALID_INPUT", "Unknown attendance subject type.");
  }
  return value;
}

async function requireEligibleSubject(
  trx: Transaction<Database>,
  activityId: string,
  subjectType: AttendanceSubjectType,
  subjectId: string,
): Promise<void> {
  if (subjectType === "participant") {
    const registration = await getRegistration(trx, subjectId);
    if (registration === null || registration.activityId !== activityId) {
      throw new DomainError("CROSS_ACTIVITY", "The registration belongs to another activity.");
    }
    if (registration.status !== "approved") {
      throw new DomainError("SUBJECT_NOT_ELIGIBLE", "Only an approved registration can be checked in.");
    }
    return;
  }
  if (subjectType === "ticket") {
    const ticket = await getTicket(trx, subjectId);
    if (ticket === null || ticket.activityId !== activityId) {
      throw new DomainError("CROSS_ACTIVITY", "The ticket belongs to another activity.");
    }
    if (ticket.state === "revoked" || ticket.state === "expired") {
      throw new DomainError("SUBJECT_NOT_ELIGIBLE", "A revoked or expired ticket cannot be checked in.");
    }
    return;
  }
  const staff = await getAttendanceStaff(trx, activityId, subjectId);
  if (staff === null || !staff.active) {
    throw new DomainError("SUBJECT_NOT_ELIGIBLE", "The staff roster entry is not active.");
  }
}

export interface CreateAttendancePointInput {
  readonly commandId: string;
  readonly activityId: string;
  readonly actor: ActorContext;
  readonly key: string;
  readonly name: string;
  readonly subjectTypes: readonly AttendanceSubjectType[];
}

export async function createAttendancePoint(
  db: Kysely<Database>,
  deps: RuntimeDeps,
  input: CreateAttendancePointInput,
): Promise<CommandOutcome<StoredAttendancePoint>> {
  const actor = input.actor;
  const eventDeps = withActor(deps, actor);
  const subjectTypes = [...new Set(input.subjectTypes.map(requireSubjectType))];
  if (subjectTypes.length === 0) throw new DomainError("INVALID_INPUT", "At least one subject type is required.");
  return executeCommand(db, {
    commandId: input.commandId,
    activityId: input.activityId,
    capability: "attendance",
    commandType: "attendance.point.create",
    actor,
    payload: { key: input.key, name: input.name, subjectTypes },
  }, async (trx) => {
    requirePermission(actor, "attendance.manage");
    const activity = await getActivityForUpdate(trx, input.activityId);
    if (activity === null) throw new DomainError("NOT_FOUND", "The activity was not found.");
    requireActive(activity);
    requireAttendanceEnabled(activity);
    const key = input.key.trim();
    if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(key)) {
      throw new DomainError("INVALID_INPUT", "The point key must match [a-z0-9][a-z0-9._-]{0,63}.");
    }
    if ((await getAttendancePointForUpdate(trx, input.activityId, key)) !== null) {
      throw new DomainError("POINT_KEY_TAKEN", "The point key is already in use.");
    }
    const now = deps.now();
    const point: StoredAttendancePoint = {
      id: idFromCommand("attendance-point", input.commandId),
      activityId: input.activityId,
      key,
      name: normalizeName(input.name, "The point name"),
      subjectTypes,
      active: true,
      revision: 0,
      createdBy: actor.actorId,
      createdAt: now,
      updatedAt: now,
    };
    await insertAttendancePoint(trx, point);
    await appendEngineEvent(trx, eventDeps, {
      type: "AttendancePointChanged",
      activityId: input.activityId,
      aggregateType: "attendance_point",
      aggregateId: point.id,
      revision: 0,
      capability: "attendance",
      payload: { pointKey: point.key, active: true },
    });
    return { body: point, status: 201 };
  });
}

export interface UpdateAttendancePointInput {
  readonly commandId: string;
  readonly activityId: string;
  readonly actor: ActorContext;
  readonly pointKey: string;
  readonly expectedRevision: number;
  readonly subjectTypes: readonly AttendanceSubjectType[];
  readonly name: string;
  readonly active: boolean;
}

export async function updateAttendancePointCommand(
  db: Kysely<Database>,
  deps: RuntimeDeps,
  input: UpdateAttendancePointInput,
): Promise<CommandOutcome<StoredAttendancePoint>> {
  const actor = input.actor;
  const eventDeps = withActor(deps, actor);
  const subjectTypes = [...new Set(input.subjectTypes.map(requireSubjectType))];
  if (subjectTypes.length === 0) throw new DomainError("INVALID_INPUT", "At least one subject type is required.");
  return executeCommand(db, {
    commandId: input.commandId,
    activityId: input.activityId,
    capability: "attendance",
    commandType: "attendance.point.update",
    actor,
    payload: {
      pointKey: input.pointKey,
      expectedRevision: input.expectedRevision,
      subjectTypes,
      name: input.name,
      active: input.active,
    },
  }, async (trx) => {
    requirePermission(actor, "attendance.manage");
    const activity = await getActivityForUpdate(trx, input.activityId);
    if (activity === null) throw new DomainError("NOT_FOUND", "The activity was not found.");
    requireActive(activity);
    requireAttendanceEnabled(activity);
    const point = await getAttendancePointForUpdate(trx, input.activityId, input.pointKey);
    if (point === null) throw new DomainError("POINT_NOT_FOUND", "The attendance point was not found.");
    if (point.revision !== input.expectedRevision) {
      throw new DomainError("STALE_REVISION", "The attendance point changed since it was read.");
    }
    for (const removed of point.subjectTypes.filter((type) => !subjectTypes.includes(type))) {
      if (await hasAttendanceCurrentForPointType(trx, input.activityId, point.key, removed)) {
        throw new DomainError(
          "POINT_TYPE_IN_USE",
          "A subject type with existing attendance cannot be removed from the point.",
        );
      }
    }
    const saved = await updateAttendancePoint(trx, {
      activityId: input.activityId,
      id: point.id,
      expectedRevision: point.revision,
      name: normalizeName(input.name, "The point name"),
      subjectTypes,
      active: input.active,
    });
    await appendEngineEvent(trx, eventDeps, {
      type: "AttendancePointChanged",
      activityId: input.activityId,
      aggregateType: "attendance_point",
      aggregateId: saved.id,
      revision: saved.revision,
      capability: "attendance",
      payload: { pointKey: saved.key, active: saved.active },
    });
    return { body: saved };
  });
}

export interface AddAttendanceStaffInput {
  readonly commandId: string;
  readonly activityId: string;
  readonly actor: ActorContext;
  readonly displayName: string;
  readonly actorId?: string | null;
}

export async function addAttendanceStaff(
  db: Kysely<Database>,
  deps: RuntimeDeps,
  input: AddAttendanceStaffInput,
): Promise<CommandOutcome<StoredAttendanceStaff>> {
  const actor = input.actor;
  const eventDeps = withActor(deps, actor);
  return executeCommand(db, {
    commandId: input.commandId,
    activityId: input.activityId,
    capability: "attendance",
    commandType: "attendance.staff.add",
    actor,
    payload: { displayName: input.displayName, actorId: input.actorId ?? null },
  }, async (trx) => {
    requirePermission(actor, "attendance.manage");
    const activity = await getActivityForUpdate(trx, input.activityId);
    if (activity === null) throw new DomainError("NOT_FOUND", "The activity was not found.");
    requireActive(activity);
    requireAttendanceEnabled(activity);
    const now = deps.now();
    const staff: StoredAttendanceStaff = {
      id: idFromCommand("attendance-staff", input.commandId),
      activityId: input.activityId,
      displayName: normalizeName(input.displayName, "The staff display name"),
      actorId: input.actorId ?? null,
      active: true,
      revision: 0,
      createdBy: actor.actorId,
      createdAt: now,
      updatedAt: now,
    };
    await insertAttendanceStaff(trx, staff);
    await appendEngineEvent(trx, eventDeps, {
      type: "AttendanceStaffChanged",
      activityId: input.activityId,
      aggregateType: "attendance_staff",
      aggregateId: staff.id,
      revision: 0,
      capability: "attendance",
      payload: { staffId: staff.id, active: true },
    });
    return { body: staff, status: 201 };
  });
}

export interface UpdateAttendanceStaffInput {
  readonly commandId: string;
  readonly activityId: string;
  readonly actor: ActorContext;
  readonly staffId: string;
  readonly expectedRevision: number;
  readonly displayName: string;
  readonly actorId: string | null;
  readonly active: boolean;
}

export async function updateAttendanceStaffCommand(
  db: Kysely<Database>,
  deps: RuntimeDeps,
  input: UpdateAttendanceStaffInput,
): Promise<CommandOutcome<StoredAttendanceStaff>> {
  const actor = input.actor;
  const eventDeps = withActor(deps, actor);
  return executeCommand(db, {
    commandId: input.commandId,
    activityId: input.activityId,
    capability: "attendance",
    commandType: "attendance.staff.update",
    actor,
    payload: {
      staffId: input.staffId,
      expectedRevision: input.expectedRevision,
      displayName: input.displayName,
      actorId: input.actorId,
      active: input.active,
    },
  }, async (trx) => {
    requirePermission(actor, "attendance.manage");
    const activity = await getActivityForUpdate(trx, input.activityId);
    if (activity === null) throw new DomainError("NOT_FOUND", "The activity was not found.");
    requireActive(activity);
    requireAttendanceEnabled(activity);
    const staff = await getAttendanceStaffForUpdate(trx, input.activityId, input.staffId);
    if (staff === null) throw new DomainError("NOT_FOUND", "The staff roster entry was not found.");
    if (staff.revision !== input.expectedRevision) {
      throw new DomainError("STALE_REVISION", "The staff roster entry changed since it was read.");
    }
    const saved = await updateAttendanceStaff(trx, {
      activityId: input.activityId,
      id: staff.id,
      expectedRevision: staff.revision,
      displayName: normalizeName(input.displayName, "The staff display name"),
      actorId: input.actorId,
      active: input.active,
    });
    await appendEngineEvent(trx, eventDeps, {
      type: "AttendanceStaffChanged",
      activityId: input.activityId,
      aggregateType: "attendance_staff",
      aggregateId: saved.id,
      revision: saved.revision,
      capability: "attendance",
      payload: { staffId: saved.id, active: saved.active },
    });
    return { body: saved };
  });
}

export interface AttendanceCheckinInput {
  readonly commandId: string;
  readonly activityId: string;
  readonly actor: ActorContext;
  readonly pointKey: string;
  readonly subjectType: AttendanceSubjectType;
  readonly subjectId: string;
  readonly note?: string;
}

export async function checkIn(
  db: Kysely<Database>,
  deps: RuntimeDeps,
  input: AttendanceCheckinInput,
): Promise<CommandOutcome<StoredAttendanceCurrent>> {
  const actor = input.actor;
  const eventDeps = withActor(deps, actor);
  const note = normalizeNote(input.note);
  const subjectType = requireSubjectType(input.subjectType);
  return executeCommand(db, {
    commandId: input.commandId,
    activityId: input.activityId,
    capability: "attendance",
    commandType: "attendance.checkin",
    scope: "checkin",
    actor,
    payload: { pointKey: input.pointKey, subjectType, subjectId: input.subjectId, note },
  }, async (trx) => {
    requirePermission(actor, "attendance.manage");
    const activity = await getActivityForUpdate(trx, input.activityId);
    if (activity === null) throw new DomainError("NOT_FOUND", "The activity was not found.");
    requireActive(activity);
    requireAttendanceEnabled(activity);
    const { session } = await requireRunningCommandSession(trx, activity, "attendance.checkin", "checkin");
    if (session.mode !== "formal" && session.mode !== "test") {
      throw new DomainError("INVALID_MODE", "Attendance requires a formal or test check-in session.");
    }
    const point = await getAttendancePointForUpdate(trx, input.activityId, input.pointKey);
    if (point === null) throw new DomainError("POINT_NOT_FOUND", "The attendance point was not found.");
    if (!point.active) throw new DomainError("POINT_INACTIVE", "The attendance point is inactive.");
    if (!point.subjectTypes.includes(subjectType)) {
      throw new DomainError("SUBJECT_TYPE_NOT_ALLOWED", "This point does not accept that subject type.");
    }
    await requireEligibleSubject(trx, input.activityId, subjectType, input.subjectId);
    const current = await getAttendanceCurrentForUpdate(trx, {
      activityId: input.activityId,
      mode: session.mode,
      pointKey: input.pointKey,
      subjectType,
      subjectId: input.subjectId,
    });
    if (current !== null && current.status === "present") {
      throw new DomainError("ALREADY_CHECKED_IN", "The subject is already checked in at this point.");
    }
    const now = deps.now();
    await insertAttendanceFact(trx, {
      id: idFromCommand("attendance-fact", input.commandId),
      activityId: input.activityId,
      mode: session.mode,
      pointKey: input.pointKey,
      subjectType,
      subjectId: input.subjectId,
      action: "checkin",
      note,
      actorId: actor.actorId,
      commandId: input.commandId,
      occurredAt: now,
    });
    const saved = await upsertAttendanceCurrent(trx, {
      activityId: input.activityId,
      mode: session.mode,
      pointKey: input.pointKey,
      subjectType,
      subjectId: input.subjectId,
      status: "present",
      note,
      revision: (current?.revision ?? 0) + 1,
      updatedAt: now,
    });
    await appendEngineEvent(trx, eventDeps, {
      type: "AttendanceCheckedIn",
      activityId: input.activityId,
      aggregateType: "attendance",
      aggregateId: `${input.pointKey}:${subjectType}:${input.subjectId}`,
      revision: saved.revision,
      capability: "attendance",
      payload: { pointKey: input.pointKey, subjectType, subjectId: input.subjectId },
    });
    return { body: saved };
  });
}

export interface AttendanceUndoInput {
  readonly commandId: string;
  readonly activityId: string;
  readonly actor: ActorContext;
  readonly pointKey: string;
  readonly subjectType: AttendanceSubjectType;
  readonly subjectId: string;
  readonly note?: string;
}

export async function undoCheckIn(
  db: Kysely<Database>,
  deps: RuntimeDeps,
  input: AttendanceUndoInput,
): Promise<CommandOutcome<StoredAttendanceCurrent>> {
  const actor = input.actor;
  const eventDeps = withActor(deps, actor);
  const note = normalizeNote(input.note);
  const subjectType = requireSubjectType(input.subjectType);
  return executeCommand(db, {
    commandId: input.commandId,
    activityId: input.activityId,
    capability: "attendance",
    commandType: "attendance.undo",
    scope: "checkin",
    actor,
    payload: { pointKey: input.pointKey, subjectType, subjectId: input.subjectId, note },
  }, async (trx) => {
    requirePermission(actor, "attendance.manage");
    const activity = await getActivityForUpdate(trx, input.activityId);
    if (activity === null) throw new DomainError("NOT_FOUND", "The activity was not found.");
    requireActive(activity);
    requireAttendanceEnabled(activity);
    const { session } = await requireRunningCommandSession(trx, activity, "attendance.undo", "checkin");
    if (session.mode !== "formal" && session.mode !== "test") {
      throw new DomainError("INVALID_MODE", "Attendance requires a formal or test check-in session.");
    }
    const current = await getAttendanceCurrentForUpdate(trx, {
      activityId: input.activityId,
      mode: session.mode,
      pointKey: input.pointKey,
      subjectType,
      subjectId: input.subjectId,
    });
    if (current === null || current.status !== "present") {
      throw new DomainError("NOT_CHECKED_IN", "The subject is not checked in at this point.");
    }
    const now = deps.now();
    await insertAttendanceFact(trx, {
      id: idFromCommand("attendance-fact", input.commandId),
      activityId: input.activityId,
      mode: session.mode,
      pointKey: input.pointKey,
      subjectType,
      subjectId: input.subjectId,
      action: "undo",
      note,
      actorId: actor.actorId,
      commandId: input.commandId,
      occurredAt: now,
    });
    const saved = await upsertAttendanceCurrent(trx, {
      ...current,
      status: "undone",
      note,
      revision: current.revision + 1,
      updatedAt: now,
    });
    await appendEngineEvent(trx, eventDeps, {
      type: "AttendanceUndone",
      activityId: input.activityId,
      aggregateType: "attendance",
      aggregateId: `${input.pointKey}:${subjectType}:${input.subjectId}`,
      revision: saved.revision,
      capability: "attendance",
      payload: { pointKey: input.pointKey, subjectType, subjectId: input.subjectId },
    });
    return { body: saved };
  });
}
