import type { Database } from "@artflow-plus/db";
import {
  blockExecutionProjection,
  blockLiveState,
  claimPendingEventsForPartition,
  clearExecutionProjectionBlock,
  deleteLiveState,
  deleteExecutionProjection,
  getExecutionProjection,
  getLiveState,
  listPendingPartitions,
  markPublished,
  readExecutionHistory,
  readEventsSince,
  recordFailure,
  retryEvent,
  tryLockPartition,
  upsertExecutionProjection,
  upsertLiveState,
} from "@artflow-plus/db";
import type { ExecutionMode, RuntimeEvent } from "@artflow-plus/domain";
import {
  applyExecutionEvent,
  emptyExecutionProjection,
  EXECUTION_SESSION_CLOSED,
  EXECUTION_SESSION_STARTED,
} from "@artflow-plus/domain";
import type { Kysely, Transaction } from "kysely";

import { applyVotingLiveEvent } from "./live-projection.js";
import type { VotingLiveState } from "./live-projection.js";

export interface RelayOptions {
  readonly batchSize?: number;
  readonly maxAttempts?: number;
  readonly partitionLimit?: number;
}

export interface RelayResult {
  readonly claimed: number;
  readonly applied: number;
  readonly failed: number;
  readonly blockedPartitions: number;
  readonly lockedPartitions: number;
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

function partitionKey(activityId: string | null, mode: string | null): string {
  return `${activityId ?? "legacy"}:${mode ?? "engine"}`;
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

function isVotingLiveEvent(event: RuntimeEvent): boolean {
  return event.type === "VoteSessionOpened" || event.type === "BallotSubmitted" || event.type === "VoteSessionClosed";
}

async function applyToLiveProjection(
  trx: Transaction<Database>,
  event: RuntimeEvent,
): Promise<void> {
  if (!isVotingLiveEvent(event)) return;
  const current = await getLiveState(trx, event.activityId, "vote_session", event.aggregateId);
  const next = applyVotingLiveEvent(current?.state as Parameters<typeof applyVotingLiveEvent>[0] ?? null, event);
  if (next !== null) {
    await upsertLiveState(trx, {
      activityId: event.activityId,
      aggregateType: "vote_session",
      aggregateId: event.aggregateId,
      lastSequence: event.sequence,
      state: next,
    });
  }
}

/**
 * One relay pass over projection partitions. A partition is (activity, mode):
 * an advisory transaction lock serializes it, so event N+1 can never be
 * applied before N. Different partitions still run concurrently. A dead
 * letter blocks its partition instead of letting later events overtake it.
 */
export async function relayOutboxOnce(
  db: Kysely<Database>,
  options: RelayOptions = {},
): Promise<RelayResult> {
  const batchSize = Math.min(Math.max(options.batchSize ?? 100, 1), 1000);
  const maxAttempts = Math.max(options.maxAttempts ?? 5, 1);
  const partitionLimit = Math.min(Math.max(options.partitionLimit ?? 50, 1), 500);

  return db.transaction().execute(async (trx) => {
    const partitions = await listPendingPartitions(trx, partitionLimit);
    let claimed = 0;
    let applied = 0;
    let failed = 0;
    let blockedPartitions = 0;
    let lockedPartitions = 0;

    for (const partition of partitions) {
      if (
        !(await tryLockPartition(
          trx,
          partitionKey(partition.activityId, partition.mode),
        ))
      ) {
        lockedPartitions += 1;
        continue;
      }

      if (partition.activityId === null) {
        // Legacy/malformed rows have no projection partition; drain them so
        // they cannot starve the relay.
        const events = await claimPendingEventsForPartition(
          trx,
          null,
          partition.mode,
          batchSize,
        );
        claimed += events.length;
        for (const event of events) {
          await markPublished(trx, event.sequence);
          applied += 1;
        }
        continue;
      }

      if (partition.mode !== null) {
        const projection = await getExecutionProjection(
          trx,
          partition.activityId,
          partition.mode as ExecutionMode,
        );
        if (projection?.status === "blocked") {
          blockedPartitions += 1;
          continue;
        }
      }

      const events = await claimPendingEventsForPartition(
        trx,
        partition.activityId,
        partition.mode,
        batchSize,
      );
      claimed += events.length;
      for (const event of events) {
        try {
          const mode = executionMode(event);
          if (mode !== null) {
            await applyToProjection(trx, event, mode);
          }
          if (isVotingLiveEvent(event)) {
            try {
              await applyToLiveProjection(trx, event);
            } catch (error) {
              const message = error instanceof Error ? error.message : String(error);
              await blockLiveState(trx, {
                activityId: event.activityId,
                aggregateType: "vote_session",
                aggregateId: event.aggregateId,
                sequence: event.sequence,
                reason: message,
              });
              // A live projection is derived convenience state. Its failure is
              // visible and recoverable, but it must not reject the authority
              // command or stop the HTTP path.
            }
          }
          await markPublished(trx, event.sequence);
          applied += 1;
        } catch (error) {
          failed += 1;
          const message = error instanceof Error ? error.message : String(error);
          const failure = await recordFailure(
            trx,
            event.sequence,
            message,
            maxAttempts,
          );
          if (
            partition.mode !== null &&
            failure.deadLettered
          ) {
            await blockExecutionProjection(
              trx,
              partition.activityId,
              partition.mode as ExecutionMode,
              event.sequence,
              message,
            );
            blockedPartitions += 1;
          }
          break;
        }
      }
    }

    return { claimed, applied, failed, blockedPartitions, lockedPartitions };
  });
}

export interface RebuildResult {
  readonly state: ReturnType<typeof emptyExecutionProjection>;
  readonly lastSequence: number;
}

export interface RebuildVotingLiveResult {
  readonly state: VotingLiveState | null;
  readonly lastSequence: number;
}

/** Rebuilds one vote-session live projection from the durable event history. */
export async function rebuildVotingLiveProjection(
  db: Kysely<Database>,
  activityId: string,
  sessionId: string,
  mode: ExecutionMode,
): Promise<RebuildVotingLiveResult> {
  return db.transaction().execute(async (trx) => {
    if (!(await tryLockPartition(trx, partitionKey(activityId, mode)))) {
      throw new Error(`Voting live projection ${activityId}/${sessionId} is being updated by the relay; retry the rebuild.`);
    }
    await deleteLiveState(trx, activityId, "vote_session", sessionId);
    let state: VotingLiveState | null = null;
    let cursor = 0;
    let lastSequence = 0;
    for (;;) {
      const events = await readEventsSince(trx, { activityId, after: cursor, limit: 500, mode });
      if (events.length === 0) break;
      for (const event of events) {
        cursor = event.sequence;
        if (!isVotingLiveEvent(event) || event.aggregateId !== sessionId) continue;
        state = applyVotingLiveEvent(state, event);
        lastSequence = event.sequence;
      }
      if (events.length < 500) break;
    }
    if (state !== null) {
      await upsertLiveState(trx, {
        activityId,
        aggregateType: "vote_session",
        aggregateId: sessionId,
        lastSequence,
        state,
      });
    }
    return { state, lastSequence };
  });
}

/**
 * Rebuilds one activity/mode projection from the event log. The forced upsert
 * also clears any previous block; a still-malformed event fails the rebuild
 * transaction and leaves the old projection untouched.
 */
export async function rebuildExecutionProjection(
  db: Kysely<Database>,
  activityId: string,
  mode: ExecutionMode,
): Promise<RebuildResult> {
  return db.transaction().execute(async (trx) => {
    // The relay holds this same transaction-scoped lock while applying a
    // partition. Rebuilding without it could force-write a snapshot that a
    // concurrent relay pass has already superseded, dropping an event that is
    // already marked published and will never be applied again.
    if (!(await tryLockPartition(trx, partitionKey(activityId, mode)))) {
      throw new Error(
        `Projection ${activityId}/${mode} is being updated by the relay; retry the rebuild.`,
      );
    }
    await deleteExecutionProjection(trx, activityId, mode);
    const events = await readExecutionHistory(trx, activityId, mode);
    let state = emptyExecutionProjection(activityId, mode);
    let lastSequence = 0;
    for (const event of events) {
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
      force: true,
    });
    return { state, lastSequence };
  });
}

/**
 * Operator recovery: retry the exact event that blocked the partition and
 * clear the block. The next relay pass re-applies it; if it still fails, the
 * partition blocks again rather than skipping forward.
 */
export async function retryBlockedProjection(
  db: Kysely<Database>,
  activityId: string,
  mode: ExecutionMode,
): Promise<boolean> {
  return db.transaction().execute(async (trx) => {
    const projection = await getExecutionProjection(trx, activityId, mode);
    if (
      projection === null ||
      projection.status !== "blocked" ||
      projection.blockedSequence === undefined
    ) {
      return false;
    }
    await retryEvent(trx, projection.blockedSequence);
    await clearExecutionProjectionBlock(trx, activityId, mode);
    return true;
  });
}
