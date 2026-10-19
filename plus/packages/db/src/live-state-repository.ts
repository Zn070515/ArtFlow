import type { Kysely, Selectable } from "kysely";

import type { Database, LiveStateRow } from "./types.js";

function iso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : value;
}

export interface StoredLiveState {
  readonly activityId: string;
  readonly aggregateType: string;
  readonly aggregateId: string;
  readonly lastSequence: number;
  readonly state: unknown;
  readonly status: "running" | "blocked";
  readonly blockedSequence?: number;
  readonly blockedReason?: string;
  readonly updatedAt: string;
}

function map(row: Selectable<LiveStateRow>): StoredLiveState {
  const blockedSequence = row.blocked_sequence === null ? undefined : Number(row.blocked_sequence);
  return {
    activityId: row.activity_id,
    aggregateType: row.aggregate_type,
    aggregateId: row.aggregate_id,
    lastSequence: Number(row.last_sequence),
    state: typeof row.state === "string" ? JSON.parse(row.state) as unknown : row.state,
    status: row.status as StoredLiveState["status"],
    ...(blockedSequence === undefined ? {} : { blockedSequence }),
    ...(row.blocked_reason === null ? {} : { blockedReason: row.blocked_reason }),
    updatedAt: iso(row.updated_at),
  };
}

export async function getLiveState(
  db: Kysely<Database>,
  activityId: string,
  aggregateType: string,
  aggregateId: string,
): Promise<StoredLiveState | null> {
  const row = await db.selectFrom("live_state").selectAll().where("activity_id", "=", activityId).where("aggregate_type", "=", aggregateType).where("aggregate_id", "=", aggregateId).executeTakeFirst();
  return row === undefined ? null : map(row);
}

export async function upsertLiveState(
  trx: Kysely<Database>,
  input: { readonly activityId: string; readonly aggregateType: string; readonly aggregateId: string; readonly lastSequence: number; readonly state: unknown },
): Promise<void> {
  await trx.insertInto("live_state").values({
    activity_id: input.activityId,
    aggregate_type: input.aggregateType,
    aggregate_id: input.aggregateId,
    last_sequence: input.lastSequence,
    state: JSON.stringify(input.state),
    status: "running",
    blocked_sequence: null,
    blocked_reason: null,
  }).onConflict((conflict) => conflict.columns(["activity_id", "aggregate_type", "aggregate_id"]).doUpdateSet({
    last_sequence: input.lastSequence,
    state: JSON.stringify(input.state),
    status: "running",
    blocked_sequence: null,
    blocked_reason: null,
    updated_at: new Date(),
  }).where("live_state.last_sequence", "<", String(input.lastSequence))).execute();
}

export async function blockLiveState(
  trx: Kysely<Database>,
  input: { readonly activityId: string; readonly aggregateType: string; readonly aggregateId: string; readonly sequence: number; readonly reason: string },
): Promise<void> {
  const current = await getLiveState(trx, input.activityId, input.aggregateType, input.aggregateId);
  await trx.insertInto("live_state").values({
    activity_id: input.activityId,
    aggregate_type: input.aggregateType,
    aggregate_id: input.aggregateId,
    last_sequence: current?.lastSequence ?? 0,
    state: JSON.stringify(current?.state ?? {}),
    status: "blocked",
    blocked_sequence: input.sequence,
    blocked_reason: input.reason,
  }).onConflict((conflict) => conflict.columns(["activity_id", "aggregate_type", "aggregate_id"]).doUpdateSet({
    status: "blocked",
    blocked_sequence: input.sequence,
    blocked_reason: input.reason,
    updated_at: new Date(),
  })).execute();
}

export async function deleteLiveState(
  trx: Kysely<Database>,
  activityId: string,
  aggregateType: string,
  aggregateId: string,
): Promise<void> {
  await trx.deleteFrom("live_state")
    .where("activity_id", "=", activityId)
    .where("aggregate_type", "=", aggregateType)
    .where("aggregate_id", "=", aggregateId)
    .execute();
}
