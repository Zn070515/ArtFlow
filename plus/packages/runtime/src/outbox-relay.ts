import type { Database } from "@artflow-plus/db";
import {
  claimPendingEvents,
  deleteExecutionProjection,
  getExecutionProjection,
  markPublished,
  readExecutionHistory,
  recordFailure,
  upsertExecutionProjection,
} from "@artflow-plus/db";
import type { ExecutionMode, RuntimeEvent } from "@artflow-plus/domain";
import {
  applyExecutionEvent,
  emptyExecutionProjection,
  EXECUTION_SESSION_CLOSED,
  EXECUTION_SESSION_STARTED,
} from "@artflow-plus/domain";
import type { Kysely, Transaction } from "kysely";

export interface RelayOptions {
  readonly batchSize?: number;
  readonly maxAttempts?: number;
}

export interface RelayResult {
  readonly claimed: number;
  readonly applied: number;
  readonly failed: number;
}

function executionMode(event: RuntimeEvent): ExecutionMode | null {
  if (
    event.type !== EXECUTION_SESSION_STARTED &&
    event.type !== EXECUTION_SESSION_CLOSED
  ) {
    return null;
  }
  return event.mode ?? null;
}

async function applyToProjection(
  trx: Transaction<Database>,
  event: RuntimeEvent,
  mode: ExecutionMode,
): Promise<void> {
  const projection = await getExecutionProjection(trx, event.activityId, mode);
  if (projection !== null && projection.lastSequence >= event.sequence) {
    return;
  }
  const state =
    projection?.state ?? emptyExecutionProjection(event.activityId, mode);
  const next = applyExecutionEvent(state, event);
  await upsertExecutionProjection(trx, {
    activityId: event.activityId,
    mode,
    lastSequence: event.sequence,
    state: next,
  });
}

/**
 * One relay pass. Events are claimed with SKIP LOCKED, applied in sequence
 * order, and marked published in the same transaction as the projection
 * update. A failing event stops the batch; later events never overtake it.
 */
export async function relayOutboxOnce(
  db: Kysely<Database>,
  options: RelayOptions = {},
): Promise<RelayResult> {
  const batchSize = Math.min(Math.max(options.batchSize ?? 100, 1), 1000);
  const maxAttempts = Math.max(options.maxAttempts ?? 5, 1);

  return db.transaction().execute(async (trx) => {
    const events = await claimPendingEvents(trx, batchSize);
    let applied = 0;
    let failed = 0;
    for (const event of events) {
      try {
        const mode = executionMode(event);
        if (mode !== null) {
          await applyToProjection(trx, event, mode);
        }
        await markPublished(trx, event.sequence);
        applied += 1;
      } catch (error) {
        failed += 1;
        await recordFailure(
          trx,
          event.sequence,
          error instanceof Error ? error.message : String(error),
          maxAttempts,
        );
        break;
      }
    }
    return { claimed: events.length, applied, failed };
  });
}

export interface RebuildResult {
  readonly state: ReturnType<typeof emptyExecutionProjection>;
  readonly lastSequence: number;
}

/** Rebuilds one activity/mode projection from the event log (recovery). */
export async function rebuildExecutionProjection(
  db: Kysely<Database>,
  activityId: string,
  mode: ExecutionMode,
): Promise<RebuildResult> {
  return db.transaction().execute(async (trx) => {
    await deleteExecutionProjection(trx, activityId, mode);
    const events = await readExecutionHistory(trx, activityId, mode);
    let state = emptyExecutionProjection(activityId, mode);
    let lastSequence = 0;
    for (const event of events) {
      // Capability facts share the event log but do not advance this
      // projection's watermark; only execution-session events do.
      if (
        event.type !== EXECUTION_SESSION_STARTED &&
        event.type !== EXECUTION_SESSION_CLOSED
      ) {
        continue;
      }
      state = applyExecutionEvent(state, event);
      lastSequence = event.sequence;
    }
    await upsertExecutionProjection(trx, {
      activityId,
      mode,
      lastSequence,
      state,
    });
    return { state, lastSequence };
  });
}
