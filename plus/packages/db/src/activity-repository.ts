import type { Activity, ActivityStatus } from "@artflow-plus/domain";
import type { Kysely, Selectable } from "kysely";

import type { ActivityRow, Database } from "./types.js";

type ActivitySelectRow = Selectable<ActivityRow>;

export class StaleRevisionError extends Error {
  readonly code = "STALE_REVISION";

  constructor(activityId: string) {
    super(`Activity ${activityId} changed since it was read.`);
    this.name = "StaleRevisionError";
  }
}

function rowToActivity(row: ActivitySelectRow): Activity {
  const enabledCapabilities =
    typeof row.enabled_capabilities === "string"
      ? (JSON.parse(row.enabled_capabilities) as string[])
      : row.enabled_capabilities;
  return {
    id: row.id,
    title: row.title,
    status: row.status as ActivityStatus,
    revision: row.revision,
    enabledCapabilities,
    activeDefinitionVersion: row.active_definition_version,
  };
}

export async function insertActivity(db: Kysely<Database>, activity: Activity): Promise<void> {
  await db
    .insertInto("activity")
    .values({
      id: activity.id,
      public_code: activity.id,
      title: activity.title,
      status: activity.status,
      revision: activity.revision,
      enabled_capabilities: JSON.stringify([...activity.enabledCapabilities]),
      active_definition_version: activity.activeDefinitionVersion,
    })
    .execute();
}

export async function getActivity(
  db: Kysely<Database>,
  activityId: string,
): Promise<Activity | null> {
  const row = await db
    .selectFrom("activity")
    .selectAll()
    .where("id", "=", activityId)
    .executeTakeFirst();
  return row === undefined ? null : rowToActivity(row);
}

/** Lock order starts here (CONC-02); callers must re-read after this lock. */
export async function getActivityForUpdate(
  trx: Kysely<Database>,
  activityId: string,
): Promise<Activity | null> {
  const row = await trx
    .selectFrom("activity")
    .selectAll()
    .where("id", "=", activityId)
    .forUpdate()
    .executeTakeFirst();
  return row === undefined ? null : rowToActivity(row);
}

/**
 * CAS update used inside a command transaction. Receipts and outbox rows are
 * written by the command service, not here, so one command has one receipt.
 */
export async function updateActivity(
  trx: Kysely<Database>,
  activity: Activity,
  expectedRevision: number,
): Promise<Activity> {
  const row = await trx
    .updateTable("activity")
    .set({
      title: activity.title,
      status: activity.status,
      revision: activity.revision,
      enabled_capabilities: JSON.stringify([...activity.enabledCapabilities]),
      active_definition_version: activity.activeDefinitionVersion,
    })
    .where("id", "=", activity.id)
    .where("revision", "=", expectedRevision)
    .returningAll()
    .executeTakeFirst();
  if (row === undefined) {
    throw new StaleRevisionError(activity.id);
  }
  return rowToActivity(row);
}
