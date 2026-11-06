import type { ExecutionMode, ExecutionSession } from "@artflow-plus/domain";
import type { Kysely, Selectable } from "kysely";

import { StaleRevisionError } from "./activity-repository.js";
import type { ExecutionSessionRow, Database } from "./types.js";

export interface SessionRecord extends ExecutionSession {
  readonly openedAt: string;
  readonly closedAt?: string;
}

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : value;
}

function toSession(row: Selectable<ExecutionSessionRow>): SessionRecord {
  return {
    id: row.id,
    activityId: row.activity_id,
    definitionVersion: row.definition_version,
    contentHash: row.content_hash,
    scope: row.scope,
    mode: row.mode as ExecutionMode,
    status: row.status as "running" | "closed",
    revision: row.revision,
    openedAt: toIso(row.opened_at),
    ...(row.closed_at === null ? {} : { closedAt: toIso(row.closed_at) }),
  };
}

export async function listSessionRecords(
  db: Kysely<Database>,
  activityId: string,
): Promise<readonly SessionRecord[]> {
  const rows = await db
    .selectFrom("execution_session")
    .selectAll()
    .where("activity_id", "=", activityId)
    .orderBy("opened_at", "asc")
    .execute();
  return rows.map(toSession);
}

export async function listRunningSessions(
  db: Kysely<Database>,
  activityId: string,
): Promise<readonly ExecutionSession[]> {
  const rows = await db
    .selectFrom("execution_session")
    .selectAll()
    .where("activity_id", "=", activityId)
    .where("status", "=", "running")
    .orderBy("opened_at", "asc")
    .execute();
  return rows.map(toSession);
}

export async function getSessionForUpdate(
  trx: Kysely<Database>,
  sessionId: string,
): Promise<SessionRecord | null> {
  const row = await trx
    .selectFrom("execution_session")
    .selectAll()
    .where("id", "=", sessionId)
    .forUpdate()
    .executeTakeFirst();
  return row === undefined ? null : toSession(row);
}

export async function insertSession(
  trx: Kysely<Database>,
  session: ExecutionSession,
  openedAt: string,
): Promise<SessionRecord> {
  const row = await trx
    .insertInto("execution_session")
    .values({
      id: session.id,
      activity_id: session.activityId,
      definition_version: session.definitionVersion,
      content_hash: session.contentHash,
      scope: session.scope,
      mode: session.mode,
      status: session.status,
      revision: session.revision,
      opened_at: openedAt,
      closed_at: null,
    })
    .returningAll()
    .executeTakeFirstOrThrow();
  return toSession(row);
}

/** CAS close; the caller has already locked the activity and this row. */
export async function updateSession(
  trx: Kysely<Database>,
  session: ExecutionSession,
  expectedRevision: number,
  closedAt: string,
): Promise<SessionRecord> {
  const row = await trx
    .updateTable("execution_session")
    .set({
      status: session.status,
      revision: session.revision,
      closed_at: session.status === "closed" ? closedAt : null,
    })
    .where("id", "=", session.id)
    .where("revision", "=", expectedRevision)
    .returningAll()
    .executeTakeFirst();
  if (row === undefined) {
    throw new StaleRevisionError(session.id);
  }
  return toSession(row);
}

export async function findRunningSessionByScope(
  trx: Kysely<Database>,
  activityId: string,
  scope: string,
): Promise<SessionRecord | null> {
  const row = await trx
    .selectFrom("execution_session")
    .selectAll()
    .where("activity_id", "=", activityId)
    .where("scope", "=", scope)
    .where("status", "=", "running")
    .executeTakeFirst();
  return row === undefined ? null : toSession(row);
}
