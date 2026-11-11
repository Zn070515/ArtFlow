import type { Activity, ActivityStatus } from "@artflow-plus/domain";
import type { Kysely, Selectable } from "kysely";

import { canonicalActivityPublicCode, createActivityPublicCode } from "./public-code.js";
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

const PUBLIC_CODE_ATTEMPTS = 5;

function isPublicCodeConflict(error: unknown): boolean {
  const seen = new Set<unknown>();
  let current: unknown = error;
  while (typeof current === "object" && current !== null && !seen.has(current)) {
    seen.add(current);
    const candidate = current as {
      code?: unknown;
      constraint?: unknown;
      detail?: unknown;
      message?: unknown;
      cause?: unknown;
    };
    const constraint = typeof candidate.constraint === "string" ? candidate.constraint : "";
    const detail = typeof candidate.detail === "string" ? candidate.detail : "";
    const message = typeof candidate.message === "string" ? candidate.message : "";
    if (
      candidate.code === "23505" &&
      (constraint === "activity_public_code_key" ||
        detail.includes("(public_code)") ||
        message.includes("activity_public_code_key"))
    ) {
      return true;
    }
    current = candidate.cause;
  }
  return false;
}

export async function insertActivity(
  db: Kysely<Database>,
  activity: Activity,
  allocatePublicCode: () => string = createActivityPublicCode,
): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < PUBLIC_CODE_ATTEMPTS; attempt += 1) {
    const publicCode = canonicalActivityPublicCode(allocatePublicCode());
    try {
      await db
        .insertInto("activity")
        .values({
          id: activity.id,
          public_code: publicCode,
          title: activity.title,
          status: activity.status,
          revision: activity.revision,
          enabled_capabilities: JSON.stringify([...activity.enabledCapabilities]),
          active_definition_version: activity.activeDefinitionVersion,
        })
        .execute();
      return;
    } catch (error) {
      if (!isPublicCodeConflict(error) || attempt === PUBLIC_CODE_ATTEMPTS - 1) throw error;
      lastError = error;
    }
  }
  throw lastError instanceof Error ? lastError : new Error("Could not allocate a unique activity public code.");
}

export interface StoredActivitySummary {
  readonly id: string;
  readonly publicCode: string;
  readonly title: string;
  readonly status: ActivityStatus;
  readonly revision: number;
  readonly enabledCapabilities: readonly string[];
  readonly activeDefinitionVersion: number;
}

function summary(row: ActivitySelectRow): StoredActivitySummary {
  return {
    id: row.id,
    publicCode: row.public_code,
    title: row.title,
    status: row.status as ActivityStatus,
    revision: row.revision,
    enabledCapabilities:
      typeof row.enabled_capabilities === "string"
        ? (JSON.parse(row.enabled_capabilities) as string[])
        : row.enabled_capabilities,
    activeDefinitionVersion: row.active_definition_version,
  };
}

export async function listActivities(
  db: Kysely<Database>,
): Promise<readonly StoredActivitySummary[]> {
  const rows = await db.selectFrom("activity").selectAll().orderBy("title").orderBy("id").execute();
  return rows.map(summary);
}

export async function getActivitySummary(
  db: Kysely<Database>,
  activityId: string,
): Promise<StoredActivitySummary | null> {
  const row = await db.selectFrom("activity").selectAll().where("id", "=", activityId).executeTakeFirst();
  return row === undefined ? null : summary(row);
}

export async function getActivityByPublicCode(
  db: Kysely<Database>,
  publicCode: string,
): Promise<StoredActivitySummary | null> {
  const row = await db
    .selectFrom("activity")
    .selectAll()
    .where("public_code", "=", canonicalActivityPublicCode(publicCode))
    .executeTakeFirst();
  return row === undefined ? null : summary(row);
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
