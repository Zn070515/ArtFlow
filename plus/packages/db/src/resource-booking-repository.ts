import { sql, type Kysely, type Selectable } from "kysely";

import type { Database, ResourceBookingRow } from "./types.js";

export type ResourceBookingStatus = "draft" | "confirmed" | "cancelled";

export interface StoredResourceBooking {
  readonly id: string;
  readonly activityId: string;
  readonly resourceKey: string;
  readonly resourceName: string;
  readonly title: string;
  readonly note: string;
  readonly startsAt: string;
  readonly endsAt: string;
  readonly status: ResourceBookingStatus;
  readonly revision: number;
  readonly createdBy: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly cancelledAt?: string;
  readonly cancelReason?: string;
}

function iso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : value;
}

function booking(row: Selectable<ResourceBookingRow>): StoredResourceBooking {
  return {
    id: row.id,
    activityId: row.activity_id,
    resourceKey: row.resource_key,
    resourceName: row.resource_name,
    title: row.title,
    note: row.note,
    startsAt: iso(row.starts_at),
    endsAt: iso(row.ends_at),
    status: row.status as ResourceBookingStatus,
    revision: row.revision,
    createdBy: row.created_by,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
    ...(row.cancelled_at === null ? {} : { cancelledAt: iso(row.cancelled_at) }),
    ...(row.cancel_reason === null ? {} : { cancelReason: row.cancel_reason }),
  };
}

export async function listResourceBookings(
  db: Kysely<Database>,
  activityId: string,
): Promise<readonly StoredResourceBooking[]> {
  const rows = await db
    .selectFrom("resource_booking")
    .selectAll()
    .where("activity_id", "=", activityId)
    .orderBy("starts_at", "asc")
    .orderBy("created_at", "asc")
    .execute();
  return rows.map(booking);
}

export async function getResourceBooking(
  db: Kysely<Database>,
  id: string,
): Promise<StoredResourceBooking | null> {
  const row = await db
    .selectFrom("resource_booking")
    .selectAll()
    .where("id", "=", id)
    .executeTakeFirst();
  return row === undefined ? null : booking(row);
}

export async function getResourceBookingForUpdate(
  trx: Kysely<Database>,
  id: string,
): Promise<StoredResourceBooking | null> {
  const row = await trx
    .selectFrom("resource_booking")
    .selectAll()
    .where("id", "=", id)
    .forUpdate()
    .executeTakeFirst();
  return row === undefined ? null : booking(row);
}

export interface NewResourceBooking {
  readonly id: string;
  readonly activityId: string;
  readonly resourceKey: string;
  readonly resourceName: string;
  readonly title: string;
  readonly note: string;
  readonly startsAt: string;
  readonly endsAt: string;
  readonly createdBy: string;
}

export async function insertResourceBooking(
  trx: Kysely<Database>,
  input: NewResourceBooking,
): Promise<void> {
  await trx
    .insertInto("resource_booking")
    .values({
      id: input.id,
      activity_id: input.activityId,
      resource_key: input.resourceKey,
      resource_name: input.resourceName,
      title: input.title,
      note: input.note,
      starts_at: new Date(input.startsAt),
      ends_at: new Date(input.endsAt),
      status: "draft",
      revision: 0,
      created_by: input.createdBy,
      created_at: new Date(),
      updated_at: new Date(),
      cancelled_at: null,
      cancel_reason: null,
    })
    .execute();
}

export interface ResourceBookingEdit {
  readonly title?: string;
  readonly note?: string;
  readonly startsAt?: string;
  readonly endsAt?: string;
}

export async function updateResourceBooking(
  trx: Kysely<Database>,
  id: string,
  expectedRevision: number,
  edit: ResourceBookingEdit,
): Promise<boolean> {
  const result = await trx
    .updateTable("resource_booking")
    .set({
      ...(edit.title === undefined ? {} : { title: edit.title }),
      ...(edit.note === undefined ? {} : { note: edit.note }),
      ...(edit.startsAt === undefined ? {} : { starts_at: new Date(edit.startsAt) }),
      ...(edit.endsAt === undefined ? {} : { ends_at: new Date(edit.endsAt) }),
      updated_at: new Date(),
      revision: expectedRevision + 1,
    })
    .where("id", "=", id)
    .where("revision", "=", expectedRevision)
    .returning("id")
    .executeTakeFirst();
  return result !== undefined;
}

export async function confirmResourceBooking(
  trx: Kysely<Database>,
  id: string,
  expectedRevision: number,
): Promise<boolean> {
  const result = await trx
    .updateTable("resource_booking")
    .set({ status: "confirmed", updated_at: new Date(), revision: expectedRevision + 1 })
    .where("id", "=", id)
    .where("revision", "=", expectedRevision)
    .where("status", "=", "draft")
    .returning("id")
    .executeTakeFirst();
  return result !== undefined;
}

export async function cancelResourceBooking(
  trx: Kysely<Database>,
  id: string,
  expectedRevision: number,
  now: Date,
  reason: string,
): Promise<boolean> {
  const result = await trx
    .updateTable("resource_booking")
    .set({
      status: "cancelled",
      cancelled_at: now,
      cancel_reason: reason,
      updated_at: now,
      revision: expectedRevision + 1,
    })
    .where("id", "=", id)
    .where("revision", "=", expectedRevision)
    .where("status", "in", ["draft", "confirmed"])
    .returning("id")
    .executeTakeFirst();
  return result !== undefined;
}

export async function findConfirmedResourceOverlap(
  trx: Kysely<Database>,
  input: {
    readonly activityId: string;
    readonly resourceKey: string;
    readonly startsAt: string;
    readonly endsAt: string;
    readonly excludeId?: string;
  },
): Promise<StoredResourceBooking | null> {
  let query = trx
    .selectFrom("resource_booking")
    .selectAll()
    .where("activity_id", "=", input.activityId)
    .where("resource_key", "=", input.resourceKey)
    .where("status", "=", "confirmed")
    .where("starts_at", "<", new Date(input.endsAt))
    .where("ends_at", ">", new Date(input.startsAt));
  if (input.excludeId !== undefined) {
    query = query.where("id", "!=", input.excludeId);
  }
  const row = await query.executeTakeFirst();
  return row === undefined ? null : booking(row);
}

/** Serializes confirmations for one activity/resource without a schema extension. */
export async function lockResource(
  trx: Kysely<Database>,
  activityId: string,
  resourceKey: string,
): Promise<void> {
  await sql`select pg_advisory_xact_lock(hashtext(${`resources:${activityId}:${resourceKey}`}))`.execute(trx);
}
