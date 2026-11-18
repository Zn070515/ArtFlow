import { sql, type Kysely, type Selectable } from "kysely";

import { StaleRevisionError } from "./activity-repository.js";
import type { ActivityPublicProfileRow, Database } from "./types.js";

export interface PublicAnnouncement {
  readonly id: string;
  readonly title: string;
  readonly body: string;
  readonly publishedAt: string;
}

export interface PublicFaqItem {
  readonly question: string;
  readonly answer: string;
}

export interface PublicLink {
  readonly label: string;
  readonly url: string;
}

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
  readonly announcements: readonly PublicAnnouncement[];
  readonly faq: readonly PublicFaqItem[];
  readonly links: readonly PublicLink[];
  readonly participantsVisible: boolean;
  readonly listedPublicly: boolean;
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
  readonly announcements: readonly PublicAnnouncement[];
  readonly faq: readonly PublicFaqItem[];
  readonly links: readonly PublicLink[];
  readonly participantsVisible: boolean;
  readonly listedPublicly: boolean;
  readonly updatedBy: string;
  readonly updatedAt: string;
}

function iso(value: Date | string | null): string | null {
  if (value === null) return null;
  return value instanceof Date ? value.toISOString() : value;
}

function json(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}

function array(value: unknown): readonly unknown[] {
  const parsed = json(value);
  return Array.isArray(parsed) ? parsed : [];
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function parseAnnouncements(value: unknown): PublicAnnouncement[] {
  return array(value).flatMap((item) => {
    if (item === null || typeof item !== "object") return [];
    const record = item as Record<string, unknown>;
    const { id, title, body, publishedAt } = record;
    if (
      typeof id !== "string" || id === "" ||
      typeof title !== "string" || title === "" ||
      typeof body !== "string" || body === "" ||
      typeof publishedAt !== "string" || publishedAt === ""
    ) {
      return [];
    }
    return [{ id, title, body, publishedAt }];
  });
}

function parseFaq(value: unknown): PublicFaqItem[] {
  return array(value).flatMap((item) => {
    if (item === null || typeof item !== "object") return [];
    const { question, answer } = item as Record<string, unknown>;
    if (
      typeof question !== "string" || question === "" ||
      typeof answer !== "string" || answer === ""
    ) {
      return [];
    }
    return [{ question, answer }];
  });
}

function parseLinks(value: unknown): PublicLink[] {
  return array(value).flatMap((item) => {
    if (item === null || typeof item !== "object") return [];
    const { label, url } = item as Record<string, unknown>;
    if (
      typeof label !== "string" || label === "" ||
      typeof url !== "string" || !isHttpUrl(url)
    ) {
      return [];
    }
    return [{ label, url }];
  });
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
    announcements: parseAnnouncements(row.announcements),
    faq: parseFaq(row.faq),
    links: parseLinks(row.links),
    participantsVisible: row.participants_visible === true,
    listedPublicly: row.listed_publicly === true,
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
    announcements: [],
    faq: [],
    links: [],
    participantsVisible: false,
    listedPublicly: false,
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
        announcements: JSON.stringify(input.announcements),
        faq: JSON.stringify(input.faq),
        links: JSON.stringify(input.links),
        participants_visible: input.participantsVisible,
        listed_publicly: input.listedPublicly,
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
      announcements: JSON.stringify(input.announcements),
      faq: JSON.stringify(input.faq),
      links: JSON.stringify(input.links),
      participants_visible: input.participantsVisible,
      listed_publicly: input.listedPublicly,
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

export interface PublicEventSummary {
  readonly publicCode: string;
  readonly title: string;
  readonly status: "active" | "closed";
  readonly tagline: string;
  readonly venue: string;
  readonly startsAt: string | null;
  readonly endsAt: string | null;
  readonly organizer: string;
}

export async function listListedPublicEvents(
  db: Kysely<Database>,
): Promise<readonly PublicEventSummary[]> {
  const rows = await db
    .selectFrom("activity")
    .innerJoin("activity_public_profile", "activity_public_profile.activity_id", "activity.id")
    .select([
      "activity.public_code",
      "activity.title",
      "activity.status",
      "activity_public_profile.tagline",
      "activity_public_profile.venue",
      "activity_public_profile.starts_at",
      "activity_public_profile.ends_at",
      "activity_public_profile.organizer",
    ])
    .where("activity.status", "in", ["active", "closed"])
    .where("activity_public_profile.listed_publicly", "=", true)
    .orderBy(sql`activity_public_profile.starts_at desc nulls last`)
    .orderBy("activity.id", "asc")
    .limit(100)
    .execute();
  return rows.map((row) => ({
    publicCode: row.public_code,
    title: row.title,
    status: row.status === "closed" ? "closed" : "active",
    tagline: row.tagline,
    venue: row.venue,
    startsAt: iso(row.starts_at),
    endsAt: iso(row.ends_at),
    organizer: row.organizer,
  }));
}
