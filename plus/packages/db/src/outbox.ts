import type { ExecutionMode, RuntimeEvent } from "@artflow-plus/domain";
import { sql, type Kysely, type Selectable } from "kysely";

import type { Database, OutboxRow } from "./types.js";

export interface AppendEventInput {
  readonly eventId: string;
  readonly type: string;
  readonly occurredAt: string;
  readonly activityId: string;
  readonly aggregateType: string;
  readonly aggregateId: string;
  readonly capability: string;
  readonly revision: number;
  readonly mode?: ExecutionMode;
  readonly scope?: string;
  readonly actorId?: string;
  readonly actorType?: string;
  readonly payload: unknown;
}

function parseJson(value: unknown): unknown {
  return typeof value === "string" ? (JSON.parse(value) as unknown) : value;
}

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : value;
}

function toRuntimeEvent(row: Selectable<OutboxRow>): RuntimeEvent {
  return {
    sequence: Number(row.id),
    eventId: row.event_id,
    type: row.event_type,
    occurredAt: toIso(row.occurred_at),
    activityId: row.activity_id ?? "",
    capability: row.capability ?? "engine",
    aggregateId: row.aggregate_id ?? "",
    revision: row.revision ?? 0,
    ...(row.mode === null ? {} : { mode: row.mode as ExecutionMode }),
    ...(row.scope === null ? {} : { scope: row.scope }),
    ...(row.actor_id === null ? {} : { actorId: row.actor_id }),
    ...(row.actor_type === null ? {} : { actorType: row.actor_type }),
    payload: parseJson(row.payload),
  };
}

/** Appends an event in the same transaction as the fact it describes. */
export async function appendEvent(
  trx: Kysely<Database>,
  event: AppendEventInput,
): Promise<number> {
  const row = await trx
    .insertInto("outbox")
    .values({
      event_id: event.eventId,
      event_type: event.type,
      occurred_at: event.occurredAt,
      activity_id: event.activityId,
      aggregate_type: event.aggregateType,
      aggregate_id: event.aggregateId,
      capability: event.capability,
      revision: event.revision,
      mode: event.mode ?? null,
      scope: event.scope ?? null,
      actor_id: event.actorId ?? null,
      actor_type: event.actorType ?? null,
      payload: JSON.stringify(event.payload),
      attempts: 0,
      last_error: null,
    })
    .returning("id")
    .executeTakeFirstOrThrow();
  return Number(row.id);
}

export interface ReadEventsOptions {
  readonly activityId: string;
  readonly after: number;
  readonly limit: number;
  readonly mode?: ExecutionMode;
}

/**
 * Read path for recovery. Activity-level engine events (mode NULL) are included
 * in a mode feed; execution facts are strictly partitioned by mode.
 */
export async function readEventsSince(
  db: Kysely<Database>,
  options: ReadEventsOptions,
): Promise<readonly RuntimeEvent[]> {
  let query = db
    .selectFrom("outbox")
    .selectAll()
    .where("activity_id", "=", options.activityId)
    .where("id", ">", String(options.after));
  if (options.mode !== undefined) {
    const mode = options.mode;
    query = query.where((expression) =>
      expression.or([
        expression("mode", "=", mode),
        expression("mode", "is", null),
      ]),
    );
  }
  const rows = await query
    .orderBy("id", "asc")
    .limit(options.limit)
    .execute();
  return rows.map(toRuntimeEvent);
}

export async function headSequence(
  db: Kysely<Database>,
  activityId: string,
  mode?: ExecutionMode,
  eventTypes?: readonly string[],
): Promise<number> {
  let query = db
    .selectFrom("outbox")
    .select(sql<string | null>`max(id)`.as("head"))
    .where("activity_id", "=", activityId);
  if (mode !== undefined) {
    const selected = mode;
    query = query.where((expression) =>
      expression.or([
        expression("mode", "=", selected),
        expression("mode", "is", null),
      ]),
    );
  }
  if (eventTypes !== undefined && eventTypes.length > 0) {
    query = query.where("event_type", "in", [...eventTypes]);
  }
  const row = await query.executeTakeFirst();
  return row?.head === null || row?.head === undefined ? 0 : Number(row.head);
}

export interface PendingPartition {
  readonly activityId: string | null;
  readonly mode: string | null;
}

/**
 * A projection partition is (activity, mode). The relay locks a partition
 * before claiming its events, so two relays can never apply event N+1 before
 * event N. Different partitions may still run concurrently. Healthy
 * partitions come first: the relay skips blocked ones, and letting those fill
 * the limit would starve every other partition once enough are blocked.
 */
export async function listPendingPartitions(
  db: Kysely<Database>,
  limit: number,
): Promise<readonly PendingPartition[]> {
  const result = await sql<{
    activity_id: string | null;
    mode: string | null;
  }>`
    select o.activity_id, o.mode
      from outbox o
      left join execution_projection p
        on p.activity_id = o.activity_id
       and p.mode = o.mode
     where o.published_at is null
       and o.dead_lettered_at is null
     group by o.activity_id, o.mode, p.status
     order by coalesce(p.status = 'blocked', false), min(o.id)
     limit ${limit}
  `.execute(db);
  return result.rows.map((row) => ({
    activityId: row.activity_id,
    mode: row.mode,
  }));
}

/** Transaction-scoped advisory lock; released on commit or rollback. */
export async function tryLockPartition(
  trx: Kysely<Database>,
  key: string,
): Promise<boolean> {
  const result = await sql<{ locked: boolean }>`
    select pg_try_advisory_xact_lock(hashtext(${key})) as locked
  `.execute(trx);
  return result.rows[0]?.locked === true;
}

export async function claimPendingEventsForPartition(
  trx: Kysely<Database>,
  activityId: string | null,
  mode: string | null,
  limit: number,
): Promise<readonly RuntimeEvent[]> {
  let query = trx
    .selectFrom("outbox")
    .selectAll()
    .where("published_at", "is", null)
    .where("dead_lettered_at", "is", null);
  query =
    activityId === null
      ? query.where("activity_id", "is", null)
      : query.where("activity_id", "=", activityId);
  query =
    mode === null ? query.where("mode", "is", null) : query.where("mode", "=", mode);
  const rows = await query
    .orderBy("id", "asc")
    .limit(limit)
    .forUpdate()
    .skipLocked()
    .execute();
  return rows.map(toRuntimeEvent);
}

/** Clears a dead letter so the next relay retries the exact event. */
export async function retryEvent(
  trx: Kysely<Database>,
  sequence: number,
): Promise<void> {
  await trx
    .updateTable("outbox")
    .set({
      published_at: null,
      dead_lettered_at: null,
      attempts: 0,
      last_error: null,
    })
    .where("id", "=", String(sequence))
    .execute();
}

export async function markPublished(
  trx: Kysely<Database>,
  sequence: number,
): Promise<void> {
  await trx
    .updateTable("outbox")
    .set({ published_at: new Date(), last_error: null })
    .where("id", "=", String(sequence))
    .execute();
}

export interface FailureResult {
  readonly attempts: number;
  readonly deadLettered: boolean;
}

export async function recordFailure(
  trx: Kysely<Database>,
  sequence: number,
  message: string,
  maxAttempts: number,
): Promise<FailureResult> {
  const row = await trx
    .updateTable("outbox")
    .set({
      attempts: sql<number>`attempts + 1`,
      last_error: message,
      dead_lettered_at: sql<Date | null>`
        case
          when attempts + 1 >= ${maxAttempts} then now()
          else dead_lettered_at
        end
      `,
    })
    .where("id", "=", String(sequence))
    .returning(["attempts", "dead_lettered_at"])
    .executeTakeFirstOrThrow();
  return {
    attempts: row.attempts,
    deadLettered: row.dead_lettered_at !== null,
  };
}

/** Full ordered history for one activity/mode, used by projection rebuild. */
export async function readExecutionHistory(
  db: Kysely<Database>,
  activityId: string,
  mode: ExecutionMode,
): Promise<readonly RuntimeEvent[]> {
  const rows = await db
    .selectFrom("outbox")
    .selectAll()
    .where("activity_id", "=", activityId)
    .where("mode", "=", mode)
    .orderBy("id", "asc")
    .execute();
  return rows.map(toRuntimeEvent);
}
