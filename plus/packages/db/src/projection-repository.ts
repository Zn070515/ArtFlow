import type {
  ExecutionMode,
  ExecutionProjectionState,
} from "@artflow-plus/domain";
import { emptyExecutionProjection } from "@artflow-plus/domain";
import { sql, type Kysely } from "kysely";

import type { Database } from "./types.js";

export interface StoredExecutionProjection {
  readonly activityId: string;
  readonly mode: ExecutionMode;
  readonly lastSequence: number;
  readonly state: ExecutionProjectionState;
  readonly status: "running" | "blocked";
  readonly blockedSequence?: number;
  readonly blockedReason?: string;
  readonly updatedAt: string;
}

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : value;
}

export async function getExecutionProjection(
  db: Kysely<Database>,
  activityId: string,
  mode: ExecutionMode,
): Promise<StoredExecutionProjection | null> {
  const row = await db
    .selectFrom("execution_projection")
    .selectAll()
    .where("activity_id", "=", activityId)
    .where("mode", "=", mode)
    .executeTakeFirst();
  if (row === undefined) return null;
  return {
    activityId: row.activity_id,
    mode: row.mode as ExecutionMode,
    lastSequence: Number(row.last_sequence),
    state: row.state as ExecutionProjectionState,
    status: row.status as "running" | "blocked",
    ...(row.blocked_sequence === null
      ? {}
      : { blockedSequence: Number(row.blocked_sequence) }),
    ...(row.blocked_reason === null ? {} : { blockedReason: row.blocked_reason }),
    updatedAt: toIso(row.updated_at),
  };
}

export interface ProjectionUpsert {
  readonly activityId: string;
  readonly mode: ExecutionMode;
  readonly lastSequence: number;
  readonly state: ExecutionProjectionState;
  /** Rebuilds replace the projection wholesale and clear any block. */
  readonly force?: boolean;
}

/**
 * CAS on last_sequence. Even if two writers reach the same partition (they
 * should be serialized by the relay's advisory lock), an older state can never
 * overwrite a newer one.
 */
export async function upsertExecutionProjection(
  trx: Kysely<Database>,
  projection: ProjectionUpsert,
): Promise<boolean> {
  const state = JSON.stringify(projection.state);
  if (projection.force === true) {
    await sql`
      insert into execution_projection
        (activity_id, mode, last_sequence, state, status, blocked_sequence, blocked_reason, updated_at)
      values
        (${projection.activityId}, ${projection.mode}, ${projection.lastSequence},
         ${state}::jsonb, 'running', null, null, now())
      on conflict (activity_id, mode) do update
        set last_sequence = excluded.last_sequence,
            state = excluded.state,
            status = 'running',
            blocked_sequence = null,
            blocked_reason = null,
            updated_at = now()
    `.execute(trx);
    return true;
  }
  const result = await sql`
    insert into execution_projection
      (activity_id, mode, last_sequence, state, status, blocked_sequence, blocked_reason, updated_at)
    values
      (${projection.activityId}, ${projection.mode}, ${projection.lastSequence},
       ${state}::jsonb, 'running', null, null, now())
    on conflict (activity_id, mode) do update
      set last_sequence = excluded.last_sequence,
          state = excluded.state,
          updated_at = now()
      where execution_projection.last_sequence < excluded.last_sequence
  `.execute(trx);
  return (result.numAffectedRows ?? 0n) > 0n;
}

/** A permanently failing event holds the partition at that exact sequence. */
export async function blockExecutionProjection(
  trx: Kysely<Database>,
  activityId: string,
  mode: ExecutionMode,
  sequence: number,
  reason: string,
): Promise<void> {
  const empty = JSON.stringify(emptyExecutionProjection(activityId, mode));
  await sql`
    insert into execution_projection
      (activity_id, mode, last_sequence, state, status, blocked_sequence, blocked_reason, updated_at)
    values
      (${activityId}, ${mode}, 0, ${empty}::jsonb, 'blocked', ${sequence}, ${reason}, now())
    on conflict (activity_id, mode) do update
      set status = 'blocked',
          blocked_sequence = ${sequence},
          blocked_reason = ${reason},
          updated_at = now()
  `.execute(trx);
}

export async function clearExecutionProjectionBlock(
  trx: Kysely<Database>,
  activityId: string,
  mode: ExecutionMode,
): Promise<void> {
  await trx
    .updateTable("execution_projection")
    .set({ status: "running", blocked_sequence: null, blocked_reason: null })
    .where("activity_id", "=", activityId)
    .where("mode", "=", mode)
    .execute();
}

export async function deleteExecutionProjection(
  trx: Kysely<Database>,
  activityId: string,
  mode: ExecutionMode,
): Promise<void> {
  await trx
    .deleteFrom("execution_projection")
    .where("activity_id", "=", activityId)
    .where("mode", "=", mode)
    .execute();
}
