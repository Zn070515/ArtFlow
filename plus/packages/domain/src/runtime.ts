import type { ExecutionMode } from "./model.js";
import { deepFreeze } from "./model.js";

/**
 * The read side of the execution runtime. Events are immutable facts from the
 * outbox; this module only turns them into a projection. It performs no IO and
 * never invents a session that the event did not carry.
 */
export interface RuntimeEvent {
  /** Outbox sequence; also the polling cursor. */
  readonly sequence: number;
  readonly eventId: string;
  readonly type: string;
  readonly occurredAt: string;
  readonly activityId: string;
  readonly capability: string;
  readonly aggregateId: string;
  readonly revision: number;
  readonly mode?: ExecutionMode;
  readonly scope?: string;
  readonly payload: unknown;
}

export interface ExecutionSessionStartedPayload {
  readonly sessionId: string;
  readonly definitionVersion: number;
  readonly contentHash: string;
  readonly scope: string;
  readonly mode: ExecutionMode;
  readonly openedAt: string;
}

export interface ExecutionSessionClosedPayload {
  readonly sessionId: string;
  readonly closedAt: string;
  readonly revision: number;
}

export interface ExecutionSessionView {
  readonly id: string;
  readonly definitionVersion: number;
  readonly contentHash: string;
  readonly scope: string;
  readonly mode: ExecutionMode;
  readonly status: "running" | "closed";
  readonly revision: number;
  readonly openedAt: string;
  readonly closedAt?: string;
}

export interface ExecutionProjectionState {
  readonly activityId: string;
  readonly mode: ExecutionMode;
  readonly sessions: Readonly<Record<string, ExecutionSessionView>>;
  readonly runningScopes: readonly string[];
}

/** A capability-owned projection handler. The engine never names a capability. */
export interface ProjectionHandler<State = unknown> {
  readonly eventType: string;
  initial(): State;
  apply(state: State, event: RuntimeEvent): State;
}

export const EXECUTION_SESSION_STARTED = "ExecutionSessionStarted";
export const EXECUTION_SESSION_CLOSED = "ExecutionSessionClosed";

export function emptyExecutionProjection(
  activityId: string,
  mode: ExecutionMode,
): ExecutionProjectionState {
  return deepFreeze({
    activityId,
    mode,
    sessions: {},
    runningScopes: [],
  });
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function requiredString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`Execution event payload is missing ${key}.`);
  }
  return value;
}

function requiredNumber(record: Record<string, unknown>, key: string): number {
  const value = record[key];
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new Error(`Execution event payload is missing integer ${key}.`);
  }
  return value;
}

function runningScopes(sessions: Readonly<Record<string, ExecutionSessionView>>): string[] {
  return [
    ...new Set(
      Object.values(sessions)
        .filter((session) => session.status === "running")
        .map((session) => session.scope),
    ),
  ].sort();
}

/**
 * Applies one execution event. Events for another activity or mode are ignored
 * so formal, rehearsal and test state can never be mixed by a careless caller.
 * Malformed events throw: the worker records the failure and retries/dead-letters
 * instead of silently dropping authority.
 */
export function applyExecutionEvent(
  state: ExecutionProjectionState,
  event: RuntimeEvent,
): ExecutionProjectionState {
  if (event.activityId !== state.activityId) return state;
  if (event.mode !== undefined && event.mode !== state.mode) return state;

  if (event.type === EXECUTION_SESSION_STARTED) {
    const payload = asRecord(event.payload);
    if (payload === null) {
      throw new Error("ExecutionSessionStarted needs an object payload.");
    }
    const sessionId = requiredString(payload, "sessionId");
    const scope = requiredString(payload, "scope");
    const mode = requiredString(payload, "mode") as ExecutionMode;
    if (mode !== state.mode) return state;
    const existing = state.sessions[sessionId];
    if (existing !== undefined) return state;
    const conflict = Object.values(state.sessions).find(
      (session) => session.status === "running" && session.scope === scope,
    );
    if (conflict !== undefined) {
      throw new Error(
        `ExecutionSessionStarted ${sessionId} would put two running sessions in scope ${scope}.`,
      );
    }
    const session: ExecutionSessionView = {
      id: sessionId,
      definitionVersion: requiredNumber(payload, "definitionVersion"),
      contentHash: requiredString(payload, "contentHash"),
      scope,
      mode,
      status: "running",
      revision: 0,
      openedAt: requiredString(payload, "openedAt"),
    };
    const sessions = { ...state.sessions, [sessionId]: session };
    return deepFreeze({
      ...state,
      sessions,
      runningScopes: runningScopes(sessions),
    });
  }

  if (event.type === EXECUTION_SESSION_CLOSED) {
    const payload = asRecord(event.payload);
    if (payload === null) {
      throw new Error("ExecutionSessionClosed needs an object payload.");
    }
    const sessionId = requiredString(payload, "sessionId");
    const existing = state.sessions[sessionId];
    if (existing === undefined || existing.status === "closed") return state;
    const session: ExecutionSessionView = {
      ...existing,
      status: "closed",
      revision: requiredNumber(payload, "revision"),
      closedAt: requiredString(payload, "closedAt"),
    };
    const sessions = { ...state.sessions, [sessionId]: session };
    return deepFreeze({
      ...state,
      sessions,
      runningScopes: runningScopes(sessions),
    });
  }

  return state;
}

export function applyExecutionEvents(
  state: ExecutionProjectionState,
  events: readonly RuntimeEvent[],
): ExecutionProjectionState {
  let current = state;
  for (const event of events) {
    current = applyExecutionEvent(current, event);
  }
  return current;
}
