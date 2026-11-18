import { sql, type Kysely, type Selectable } from "kysely";

import { StaleRevisionError } from "./activity-repository.js";
import type { ActivityPublicProfileRow, Database } from "./types.js";

export interface StoredActivityPublicProfile {
  readonly activityId: string;
  readonly tagline: string;
  readonly description: string;
  readonly venue: string;
  readonly startsAt: string | null;
  readonly endsAt: string | null;
  readonly organizer: string;
  readonly contact: string;
  readonly announcement: string;
  readonly revision: number;
  readonly updatedBy: string;
  readonly updatedAt: string;
}

export interface ActivityPublicProfileInput {
  readonly activityId: string;
  readonly tagline: string;
  readonly description: string;
  readonly venue: string;
  readonly startsAt: string | null;
  readonly endsAt: string | null;
  readonly organizer: string;
  readonly contact: string;
  readonly announcement: string;
  readonly updatedBy: string;
  readonly updatedAt: string;
}

function iso(value: Date | string | null): string | null {
  if (value === null) return null;
  return value instanceof Date ? value.toISOString() : value;
}

function rowToProfile(row: Selectable<ActivityPublicProfileRow>): StoredActivityPublicProfile {
  return {
    activityId: row.activity_id,
    tagline: row.tagline,
    description: row.description,
    venue: row.venue,
    startsAt: iso(row.starts_at),
    endsAt: iso(row.ends_at),
    organizer: row.organizer,
    contact: row.contact,
    announcement: row.announcement,
    revision: row.revision,
    updatedBy: row.updated_by,
    updatedAt: iso(row.updated_at) ?? "",
  };
}

export async function findActivityPublicProfile(
  db: Kysely<Database>,
  activityId: string,
): Promise<StoredActivityPublicProfile | null> {
  const row = await db
    .selectFrom("activity_public_profile")
    .selectAll()
    .where("activity_id", "=", activityId)
    .executeTakeFirst();
  return row === undefined ? null : rowToProfile(row);
}

export async function getActivityPublicProfile(
  db: Kysely<Database>,
  activityId: string,
): Promise<StoredActivityPublicProfile> {
  return (await findActivityPublicProfile(db, activityId)) ?? {
    activityId,
    tagline: "",
    description: "",
    venue: "",
    startsAt: null,
    endsAt: null,
    organizer: "",
    contact: "",
    announcement: "",
    revision: 0,
    updatedBy: "",
    updatedAt: "",
  };
}

async function lockProfile(
  trx: Kysely<Database>,
  activityId: string,
): Promise<StoredActivityPublicProfile | null> {
  const row = await trx
    .selectFrom("activity_public_profile")
    .selectAll()
    .where("activity_id", "=", activityId)
    .forUpdate()
    .executeTakeFirst();
  return row === undefined ? null : rowToProfile(row);
}

/**
 * The command locks the activity row before this call. That first lock is what
 * serializes two concurrent first saves, so the primary-key insert cannot race.
 */
export async function upsertActivityPublicProfile(
  trx: Kysely<Database>,
  input: ActivityPublicProfileInput,
  expectedRevision: number,
): Promise<StoredActivityPublicProfile> {
  const existing = await lockProfile(trx, input.activityId);
  if (existing === null) {
    if (expectedRevision !== 0) throw new StaleRevisionError(input.activityId);
    const row = await trx
      .insertInto("activity_public_profile")
      .values({
        activity_id: input.activityId,
        tagline: input.tagline,
        description: input.description,
        venue: input.venue,
        starts_at: input.startsAt === null ? null : new Date(input.startsAt),
        ends_at: input.endsAt === null ? null : new Date(input.endsAt),
        organizer: input.organizer,
        contact: input.contact,
        announcement: input.announcement,
        revision: 1,
        updated_by: input.updatedBy,
        updated_at: new Date(input.updatedAt),
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    return rowToProfile(row);
  }
  if (existing.revision !== expectedRevision) throw new StaleRevisionError(input.activityId);
  const row = await trx
    .updateTable("activity_public_profile")
    .set({
      tagline: input.tagline,
      description: input.description,
      venue: input.venue,
      starts_at: input.startsAt === null ? null : new Date(input.startsAt),
      ends_at: input.endsAt === null ? null : new Date(input.endsAt),
      organizer: input.organizer,
      contact: input.contact,
      announcement: input.announcement,
      revision: sql`revision + 1`,
      updated_by: input.updatedBy,
      updated_at: new Date(input.updatedAt),
    })
    .where("activity_id", "=", input.activityId)
    .where("revision", "=", expectedRevision)
    .returningAll()
    .executeTakeFirst();
  if (row === undefined) throw new StaleRevisionError(input.activityId);
  return rowToProfile(row);
}
