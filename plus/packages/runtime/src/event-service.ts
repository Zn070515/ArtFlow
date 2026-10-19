import type { Database } from "@artflow-plus/db";
import {
  getExecutionProjection,
  headSequence,
  readEventsSince,
} from "@artflow-plus/db";
import type {
  ExecutionMode,
  ExecutionProjectionState,
  RuntimeEvent,
} from "@artflow-plus/domain";
import {
  DomainError,
  emptyExecutionProjection,
  EXECUTION_SESSION_CLOSED,
  EXECUTION_SESSION_STARTED,
} from "@artflow-plus/domain";
import type { Kysely } from "kysely";

export interface EventFeed {
  readonly events: readonly RuntimeEvent[];
  readonly nextCursor: number;
  readonly headCursor: number;
}

export interface EventFeedInput {
  readonly activityId: string;
  readonly after: number;
  readonly limit: number;
  readonly mode?: ExecutionMode;
}

/** Authoritative recovery path: clients poll this after any disconnect. */
export async function listEvents(
  db: Kysely<Database>,
  input: EventFeedInput,
): Promise<EventFeed> {
  if (!Number.isInteger(input.after) || input.after < 0) {
    throw new DomainError("INVALID_INPUT", "after must be a non-negative cursor.");
  }
  const limit = Math.min(Math.max(input.limit, 1), 500);
  const events = await readEventsSince(db, {
    activityId: input.activityId,
    after: input.after,
    limit,
    ...(input.mode === undefined ? {} : { mode: input.mode }),
  });
  return {
    events,
    nextCursor: events.at(-1)?.sequence ?? input.after,
    headCursor: await headSequence(db, input.activityId, input.mode),
  };
}

export interface ExecutionState extends ExecutionProjectionState {
  readonly lastSequence: number;
  readonly headSequence: number;
  readonly stale: boolean;
  readonly status: "running" | "blocked";
  readonly blockedSequence?: number;
  readonly blockedReason?: string;
}

export async function getExecutionState(
  db: Kysely<Database>,
  activityId: string,
  mode: ExecutionMode,
): Promise<ExecutionState> {
  const projection = await getExecutionProjection(db, activityId, mode);
  // Only execution events advance this projection; capability facts must not
  // make it look permanently stale.
  const head = await headSequence(db, activityId, mode, [
    EXECUTION_SESSION_STARTED,
    EXECUTION_SESSION_CLOSED,
  ]);
  const state = projection?.state ?? emptyExecutionProjection(activityId, mode);
  const lastSequence = projection?.lastSequence ?? 0;
  return {
    ...state,
    lastSequence,
    headSequence: head,
    stale: head > lastSequence,
    status: projection?.status ?? "running",
    ...(projection?.blockedSequence === undefined
      ? {}
      : { blockedSequence: projection.blockedSequence }),
    ...(projection?.blockedReason === undefined
      ? {}
      : { blockedReason: projection.blockedReason }),
  };
}
