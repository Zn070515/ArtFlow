import type {
  ExecutionMode,
  ExecutionProjectionState,
} from "@artflow-plus/domain";
import type { Kysely } from "kysely";

import type { Database } from "./types.js";

export interface StoredExecutionProjection {
  readonly activityId: string;
  readonly mode: ExecutionMode;
  readonly lastSequence: number;
  readonly state: ExecutionProjectionState;
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
    updatedAt: toIso(row.updated_at),
  };
}

export async function upsertExecutionProjection(
  trx: Kysely<Database>,
  projection: {
    readonly activityId: string;
    readonly mode: ExecutionMode;
    readonly lastSequence: number;
    readonly state: ExecutionProjectionState;
  },
): Promise<void> {
  await trx
    .insertInto("execution_projection")
    .values({
      activity_id: projection.activityId,
      mode: projection.mode,
      last_sequence: projection.lastSequence,
      state: JSON.stringify(projection.state),
      updated_at: new Date(),
    })
    .onConflict((conflict) =>
      conflict.columns(["activity_id", "mode"]).doUpdateSet({
        last_sequence: projection.lastSequence,
        state: JSON.stringify(projection.state),
        updated_at: new Date(),
      }),
    )
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
