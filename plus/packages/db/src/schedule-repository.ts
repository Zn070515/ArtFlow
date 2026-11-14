import { sql, type Kysely, type Selectable } from "kysely";

import { StaleRevisionError } from "./activity-repository.js";
import type {
  Database,
  ScheduleEntryRow,
  ScheduleReleaseRow,
} from "./types.js";

export type ScheduleMode = "test" | "rehearsal" | "formal";

export interface StoredScheduleEntry {
  readonly id: string;
  readonly activityId: string;
  readonly mode: ScheduleMode;
  readonly position: number;
  readonly slotKey: string;
  readonly participantId: string | null;
  readonly title: string;
  readonly note: string;
  readonly revision: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface ScheduleSnapshotEntry {
  readonly order: number;
  readonly slotKey: string;
  readonly slotLabel: string;
  readonly participantId: string | null;
  readonly title: string;
  readonly note: string;
}

export interface ScheduleSnapshot {
  readonly version: 1;
  readonly schemaVersion: 1;
  readonly entries: readonly ScheduleSnapshotEntry[];
  readonly releasedAt: string;
}

export interface StoredScheduleRelease {
  readonly id: string;
  readonly activityId: string;
  readonly mode: ScheduleMode;
  readonly version: number;
  readonly snapshot: ScheduleSnapshot;
  readonly note: string;
  readonly releasedAt: string;
  readonly revokedAt: string | null;
}

export interface ActiveScheduleRelease {
  readonly activityId: string;
  readonly publicCode: string;
  readonly activityTitle: string;
  readonly release: StoredScheduleRelease;
}

function iso(value: Date | string | null): string | null {
  if (value === null) return null;
  return value instanceof Date ? value.toISOString() : value;
}

function entry(row: Selectable<ScheduleEntryRow>): StoredScheduleEntry {
  return {
    id: row.id,
    activityId: row.activity_id,
    mode: row.mode as ScheduleMode,
    position: row.position,
    slotKey: row.slot_key,
    participantId: row.participant_id,
    title: row.title,
    note: row.note,
    revision: row.revision,
    createdAt: iso(row.created_at) ?? "",
    updatedAt: iso(row.updated_at) ?? "",
  };
}

function snapshot(value: unknown): ScheduleSnapshot {
  return (typeof value === "string" ? JSON.parse(value) : value) as ScheduleSnapshot;
}

function release(row: Selectable<ScheduleReleaseRow>): StoredScheduleRelease {
  return {
    id: row.id,
    activityId: row.activity_id,
    mode: row.mode as ScheduleMode,
    version: row.version,
    snapshot: snapshot(row.snapshot),
    note: row.note,
    releasedAt: iso(row.released_at) ?? "",
    revokedAt: iso(row.revoked_at),
  };
}

export async function ensureScheduleState(
  db: Kysely<Database>,
  activityId: string,
  mode: ScheduleMode,
): Promise<number> {
  await db
    .insertInto("schedule_state")
    .values({
      activity_id: activityId,
      mode,
      revision: 0,
      updated_at: new Date(),
    })
    .onConflict((conflict) => conflict.columns(["activity_id", "mode"]).doNothing())
    .execute();
  const row = await db
    .selectFrom("schedule_state")
    .select("revision")
    .where("activity_id", "=", activityId)
    .where("mode", "=", mode)
    .executeTakeFirstOrThrow();
  return row.revision;
}

export async function getScheduleStateRevision(
  db: Kysely<Database>,
  activityId: string,
  mode: ScheduleMode,
): Promise<number> {
  const row = await db
    .selectFrom("schedule_state")
    .select("revision")
    .where("activity_id", "=", activityId)
    .where("mode", "=", mode)
    .executeTakeFirst();
  return row?.revision ?? 0;
}

export async function bumpScheduleState(
  db: Kysely<Database>,
  activityId: string,
  mode: ScheduleMode,
  expectedRevision: number,
): Promise<number> {
  const row = await db
    .updateTable("schedule_state")
    .set({ revision: sql`revision + 1`, updated_at: new Date() })
    .where("activity_id", "=", activityId)
    .where("mode", "=", mode)
    .where("revision", "=", expectedRevision)
    .returning("revision")
    .executeTakeFirst();
  if (row === undefined) throw new StaleRevisionError(`${activityId}:${mode}`);
  return row.revision;
}

export async function listScheduleEntries(
  db: Kysely<Database>,
  activityId: string,
  mode: ScheduleMode,
): Promise<readonly StoredScheduleEntry[]> {
  const rows = await db
    .selectFrom("schedule_entry")
    .selectAll()
    .where("activity_id", "=", activityId)
    .where("mode", "=", mode)
    .orderBy("position", "asc")
    .orderBy("id", "asc")
    .execute();
  return rows.map(entry);
}

export async function getScheduleEntry(
  db: Kysely<Database>,
  entryId: string,
): Promise<StoredScheduleEntry | null> {
  const row = await db
    .selectFrom("schedule_entry")
    .selectAll()
    .where("id", "=", entryId)
    .executeTakeFirst();
  return row === undefined ? null : entry(row);
}

export async function getScheduleEntryForUpdate(
  db: Kysely<Database>,
  entryId: string,
): Promise<StoredScheduleEntry | null> {
  const row = await db
    .selectFrom("schedule_entry")
    .selectAll()
    .where("id", "=", entryId)
    .forUpdate()
    .executeTakeFirst();
  return row === undefined ? null : entry(row);
}

export async function insertScheduleEntry(
  db: Kysely<Database>,
  value: StoredScheduleEntry,
): Promise<StoredScheduleEntry> {
  const row = await db
    .insertInto("schedule_entry")
    .values({
      id: value.id,
      activity_id: value.activityId,
      mode: value.mode,
      position: value.position,
      slot_key: value.slotKey,
      participant_id: value.participantId,
      title: value.title,
      note: value.note,
      revision: value.revision,
      created_at: new Date(),
      updated_at: new Date(),
    })
    .returningAll()
    .executeTakeFirstOrThrow();
  return entry(row);
}

export async function updateScheduleEntry(
  db: Kysely<Database>,
  value: StoredScheduleEntry,
  expectedRevision: number,
): Promise<StoredScheduleEntry> {
  const row = await db
    .updateTable("schedule_entry")
    .set({
      position: value.position,
      slot_key: value.slotKey,
      participant_id: value.participantId,
      title: value.title,
      note: value.note,
      revision: sql`revision + 1`,
      updated_at: new Date(),
    })
    .where("id", "=", value.id)
    .where("activity_id", "=", value.activityId)
    .where("mode", "=", value.mode)
    .where("revision", "=", expectedRevision)
    .returningAll()
    .executeTakeFirst();
  if (row === undefined) throw new StaleRevisionError(value.id);
  return entry(row);
}

export async function deleteScheduleEntry(
  db: Kysely<Database>,
  entryId: string,
  expectedRevision: number,
): Promise<boolean> {
  const result = await db
    .deleteFrom("schedule_entry")
    .where("id", "=", entryId)
    .where("revision", "=", expectedRevision)
    .executeTakeFirst();
  return Number(result.numDeletedRows ?? 0) > 0;
}

export async function reorderScheduleEntries(
  db: Kysely<Database>,
  activityId: string,
  mode: ScheduleMode,
  orderedIds: readonly string[],
): Promise<void> {
  for (const [index, id] of orderedIds.entries()) {
    await db
      .updateTable("schedule_entry")
      .set({ position: index, updated_at: new Date() })
      .where("id", "=", id)
      .where("activity_id", "=", activityId)
      .where("mode", "=", mode)
      .execute();
  }
}

export async function listScheduleReleases(
  db: Kysely<Database>,
  activityId: string,
  mode: ScheduleMode,
): Promise<readonly StoredScheduleRelease[]> {
  const rows = await db
    .selectFrom("schedule_release")
    .selectAll()
    .where("activity_id", "=", activityId)
    .where("mode", "=", mode)
    .orderBy("version", "desc")
    .execute();
  return rows.map(release);
}

export async function insertScheduleRelease(
  db: Kysely<Database>,
  value: Omit<StoredScheduleRelease, "revokedAt">,
): Promise<StoredScheduleRelease> {
  const row = await db
    .insertInto("schedule_release")
    .values({
      id: value.id,
      activity_id: value.activityId,
      mode: value.mode,
      version: value.version,
      snapshot: JSON.stringify(value.snapshot),
      note: value.note,
      released_at: value.releasedAt,
      revoked_at: null,
    })
    .returningAll()
    .executeTakeFirstOrThrow();
  return release(row);
}

export async function revokeScheduleRelease(
  db: Kysely<Database>,
  releaseId: string,
  note: string,
): Promise<StoredScheduleRelease | null> {
  const row = await db
    .updateTable("schedule_release")
    .set({ revoked_at: new Date(), note })
    .where("id", "=", releaseId)
    .where("revoked_at", "is", null)
    .returningAll()
    .executeTakeFirst();
  return row === undefined ? null : release(row);
}

export async function getScheduleCurrent(
  db: Kysely<Database>,
  activityId: string,
  mode: ScheduleMode,
): Promise<string | null> {
  const row = await db
    .selectFrom("schedule_current")
    .select("entry_id")
    .where("activity_id", "=", activityId)
    .where("mode", "=", mode)
    .executeTakeFirst();
  return row?.entry_id ?? null;
}

export async function setScheduleCurrent(
  db: Kysely<Database>,
  activityId: string,
  mode: ScheduleMode,
  entryId: string | null,
): Promise<void> {
  await db
    .insertInto("schedule_current")
    .values({
      activity_id: activityId,
      mode,
      entry_id: entryId,
      updated_at: new Date(),
    })
    .onConflict((conflict) =>
      conflict.columns(["activity_id", "mode"]).doUpdateSet({
        entry_id: entryId,
        updated_at: new Date(),
      }),
    )
    .execute();
}

export async function selectActiveScheduleRelease(
  db: Kysely<Database>,
  publicCode: string,
): Promise<ActiveScheduleRelease | null> {
  const row = await db
    .selectFrom("schedule_release")
    .innerJoin("activity", "activity.id", "schedule_release.activity_id")
    .selectAll("schedule_release")
    .select(["activity.public_code", "activity.title"])
    .where("activity.public_code", "=", publicCode)
    .where("schedule_release.mode", "=", "formal")
    .where("schedule_release.revoked_at", "is", null)
    .orderBy("schedule_release.version", "desc")
    .executeTakeFirst();
  if (row === undefined) return null;
  return {
    activityId: row.activity_id,
    publicCode: row.public_code,
    activityTitle: row.title,
    release: release(row),
  };
}
