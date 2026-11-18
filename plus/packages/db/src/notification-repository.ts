import { sql, type Kysely, type SqlBool } from "kysely";

import type { Database } from "./types.js";

export interface OutboxNotificationEvent {
  readonly id: number;
  readonly eventId: string;
  readonly type: string;
  readonly activityId: string;
  readonly occurredAt: string;
  readonly mode?: string;
  readonly payload: unknown;
}

function parseJson(value: unknown): unknown {
  if (typeof value !== "string") return value ?? null;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}

/** Cross-activity event feed for the email notifier; projections use their own feeds. */
export async function readOutboxAfter(
  db: Kysely<Database>,
  afterId: number,
  limit: number,
): Promise<readonly OutboxNotificationEvent[]> {
  const rows = await db
    .selectFrom("outbox")
    .select(["id", "event_id", "event_type", "activity_id", "occurred_at", "mode", "payload"])
    .where(sql<SqlBool>`id > ${afterId}`)
    .orderBy("id", "asc")
    .limit(limit)
    .execute();
  return rows.map((row) => ({
    id: Number(row.id),
    eventId: row.event_id,
    type: row.event_type,
    activityId: row.activity_id ?? "",
    occurredAt: row.occurred_at instanceof Date ? row.occurred_at.toISOString() : row.occurred_at,
    ...(row.mode === null ? {} : { mode: row.mode }),
    payload: parseJson(row.payload),
  }));
}

export async function getOutboxHead(db: Kysely<Database>): Promise<number> {
  const row = await db
    .selectFrom("outbox")
    .select(({ fn }) => fn.max<number>("id").as("head"))
    .executeTakeFirst();
  return Number(row?.head ?? 0);
}

export async function getNotificationCursor(
  db: Kysely<Database>,
  channel: string,
): Promise<number> {
  const row = await db
    .selectFrom("notification_cursor")
    .select("last_outbox_id")
    .where("channel", "=", channel)
    .executeTakeFirst();
  return row === undefined ? 0 : Number(row.last_outbox_id);
}

/** Null means the channel has never been initialized; do not replay history. */
export async function getNotificationCursorState(
  db: Kysely<Database>,
  channel: string,
): Promise<{ readonly lastOutboxId: number } | null> {
  const row = await db
    .selectFrom("notification_cursor")
    .select("last_outbox_id")
    .where("channel", "=", channel)
    .executeTakeFirst();
  return row === undefined ? null : { lastOutboxId: Number(row.last_outbox_id) };
}

export async function advanceNotificationCursor(
  db: Kysely<Database>,
  channel: string,
  lastOutboxId: number,
): Promise<void> {
  await db
    .insertInto("notification_cursor")
    .values({ channel, last_outbox_id: lastOutboxId, updated_at: new Date() })
    .onConflict((conflict) => conflict.column("channel").doUpdateSet({
      last_outbox_id: Math.max(0, lastOutboxId),
      updated_at: new Date(),
    }))
    .execute();
}

export interface NewNotificationDelivery {
  readonly id: string;
  readonly eventId: string;
  readonly channel: string;
  readonly recipient: string;
  readonly kind: string;
  readonly subject: string;
  readonly body: string;
  readonly link: string;
}

export async function insertNotificationDeliveries(
  db: Kysely<Database>,
  rows: readonly NewNotificationDelivery[],
): Promise<void> {
  if (rows.length === 0) return;
  await db
    .insertInto("notification_delivery")
    .values(rows.map((row) => ({
      id: row.id,
      event_id: row.eventId,
      channel: row.channel,
      recipient: row.recipient,
      kind: row.kind,
      subject: row.subject,
      body: row.body,
      link: row.link,
      status: "pending",
      attempts: 0,
      last_error: null,
      created_at: new Date(),
      sent_at: null,
    })))
    .onConflict((conflict) => conflict.columns(["event_id", "channel", "recipient"]).doNothing())
    .execute();
}

export interface PendingNotificationDelivery {
  readonly id: string;
  readonly recipient: string;
  readonly kind: string;
  readonly subject: string;
  readonly body: string;
  readonly link: string;
  readonly attempts: number;
}

export async function listPendingNotificationDeliveries(
  db: Kysely<Database>,
  limit: number,
): Promise<readonly PendingNotificationDelivery[]> {
  const rows = await db
    .selectFrom("notification_delivery")
    .select(["id", "recipient", "kind", "subject", "body", "link", "attempts"])
    .where("status", "=", "pending")
    .where("attempts", "<", 3)
    .orderBy("created_at", "asc")
    .limit(limit)
    .execute();
  return rows.map((row) => ({
    id: row.id,
    recipient: row.recipient,
    kind: row.kind,
    subject: row.subject,
    body: row.body,
    link: row.link,
    attempts: Number(row.attempts),
  }));
}

export async function markNotificationSent(
  db: Kysely<Database>,
  id: string,
): Promise<void> {
  await db
    .updateTable("notification_delivery")
    .set({ status: "sent", sent_at: new Date(), last_error: null })
    .where("id", "=", id)
    .execute();
}

export async function markNotificationFailed(
  db: Kysely<Database>,
  id: string,
  error: string,
): Promise<void> {
  await db
    .updateTable("notification_delivery")
    .set({
      attempts: sql`attempts + 1`,
      last_error: error.slice(0, 1000),
      status: sql`case when attempts + 1 >= 3 then 'failed' else 'pending' end`,
    })
    .where("id", "=", id)
    .execute();
}

export interface NotificationRecipient {
  readonly email: string;
  readonly publicCode: string;
  readonly activityTitle: string;
}

export async function getRegistrationRecipient(
  db: Kysely<Database>,
  registrationId: string,
): Promise<NotificationRecipient | null> {
  const row = await db
    .selectFrom("registration")
    .innerJoin("activity", "activity.id", "registration.activity_id")
    .innerJoin("local_account", "local_account.actor_id", "registration.participant_id")
    .select([
      "local_account.email as email",
      "activity.public_code as public_code",
      "activity.title as title",
    ])
    .where("registration.id", "=", registrationId)
    .executeTakeFirst();
  if (row === undefined || row.email === null || row.email.trim() === "") return null;
  return { email: row.email, publicCode: row.public_code, activityTitle: row.title };
}

export async function listApprovedParticipantRecipients(
  db: Kysely<Database>,
  activityId: string,
): Promise<readonly NotificationRecipient[]> {
  const rows = await db
    .selectFrom("registration")
    .innerJoin("activity", "activity.id", "registration.activity_id")
    .innerJoin("local_account", "local_account.actor_id", "registration.participant_id")
    .select([
      "local_account.email as email",
      "activity.public_code as public_code",
      "activity.title as title",
    ])
    .where("registration.activity_id", "=", activityId)
    .where("registration.status", "=", "approved")
    .where("local_account.email", "is not", null)
    .execute();
  return rows.flatMap((row) => {
    if (row.email === null || row.email.trim() === "") return [];
    return [{ email: row.email, publicCode: row.public_code, activityTitle: row.title }];
  });
}
