import { createHash, randomUUID } from "node:crypto";

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

export interface SaveActivityOptions {
  expectedRevision: number;
  commandId: string;
  eventType: string;
  eventPayload?: unknown;
}

/**
 * The one write path: compare-and-swap on revision, then the receipt and the
 * outbox event in the same transaction. A stale caller gets a domain error,
 * never a silent overwrite.
 */
export async function saveActivityWithRevision(
  db: Kysely<Database>,
  activity: Activity,
  options: SaveActivityOptions,
): Promise<Activity> {
  return db.transaction().execute(async (trx) => {
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
      .where("revision", "=", options.expectedRevision)
      .returningAll()
      .executeTakeFirst();

    if (row === undefined) {
      throw new StaleRevisionError(activity.id);
    }

    const response = JSON.stringify({
      status: activity.status,
      revision: activity.revision,
    });
    await trx
      .insertInto("command_receipt")
      .values({
        command_id: options.commandId,
        activity_id: activity.id,
        capability: "engine",
        command_type: "activity",
        payload_hash: createHash("sha256").update(response).digest("hex"),
        scope: null,
        result: response,
        http_status: 200,
      })
      .execute();

    await trx
      .insertInto("outbox")
      .values({
        event_id: randomUUID(),
        event_type: options.eventType,
        occurred_at: new Date().toISOString(),
        activity_id: activity.id,
        aggregate_type: "activity",
        aggregate_id: activity.id,
        capability: "engine",
        revision: activity.revision,
        mode: null,
        scope: null,
        payload: JSON.stringify(
          options.eventPayload ?? {
            activityId: activity.id,
            revision: activity.revision,
          },
        ),
        attempts: 0,
        last_error: null,
      })
      .execute();

    return rowToActivity(row);
  });
}
