import type { Kysely } from "kysely";

import type { Database } from "./types.js";

export async function listNotificationReadKeys(
  db: Kysely<Database>,
  actorId: string,
  keys: readonly string[],
): Promise<ReadonlySet<string>> {
  if (keys.length === 0) return new Set();
  const rows = await db
    .selectFrom("participant_notification_read")
    .select("notification_key")
    .where("actor_id", "=", actorId)
    .where("notification_key", "in", [...keys])
    .execute();
  return new Set(rows.map((row) => row.notification_key));
}

export async function markNotificationKeysRead(
  db: Kysely<Database>,
  actorId: string,
  keys: readonly string[],
): Promise<void> {
  if (keys.length === 0) return;
  await db
    .insertInto("participant_notification_read")
    .values(keys.map((key) => ({ actor_id: actorId, notification_key: key })))
    .onConflict((conflict) => conflict.columns(["actor_id", "notification_key"]).doNothing())
    .execute();
}
