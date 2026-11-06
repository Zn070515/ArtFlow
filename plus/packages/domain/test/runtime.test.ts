import fc from "fast-check";
import { expect, it } from "vitest";

import {
  applyExecutionEvent,
  applyExecutionEvents,
  emptyExecutionProjection,
} from "../src/index.js";
import type { ExecutionMode, RuntimeEvent } from "../src/index.js";

function event(
  sequence: number,
  type: string,
  mode: ExecutionMode,
  payload: unknown,
): RuntimeEvent {
  return {
    sequence,
    eventId: `evt-${sequence}`,
    type,
    occurredAt: "2026-10-19T10:00:00Z",
    activityId: "act-1",
    capability: "engine",
    aggregateId: "session-1",
    revision: 0,
    mode,
    scope: "stage",
    payload,
  };
}

function started(
  sequence: number,
  mode: ExecutionMode,
  sessionId = "session-1",
  scope = "stage",
): RuntimeEvent {
  return {
    ...event(sequence, "ExecutionSessionStarted", mode, {
      sessionId,
      definitionVersion: 1,
      contentHash: "hash-1",
      scope,
      mode,
      openedAt: "2026-10-19T10:00:00Z",
    }),
    aggregateId: sessionId,
    scope,
  };
}

function closed(
  sequence: number,
  mode: ExecutionMode,
  sessionId = "session-1",
  scope = "stage",
): RuntimeEvent {
  return {
    ...event(sequence, "ExecutionSessionClosed", mode, {
      sessionId,
      closedAt: "2026-10-19T11:00:00Z",
      revision: 1,
    }),
    aggregateId: sessionId,
    scope,
  };
}

it("a started event adds a running session", () => {
  const state = applyExecutionEvent(
    emptyExecutionProjection("act-1", "formal"),
    started(1, "formal"),
  );
  expect(state.sessions["session-1"]).toMatchObject({
    id: "session-1",
    scope: "stage",
    mode: "formal",
    status: "running",
  });
  expect(state.runningScopes).toEqual(["stage"]);
});

it("a closed event removes the running session", () => {
  const opened = applyExecutionEvent(
    emptyExecutionProjection("act-1", "formal"),
    started(1, "formal"),
  );
  const state = applyExecutionEvent(opened, closed(2, "formal"));
  expect(state.sessions["session-1"]?.status).toBe("closed");
  expect(state.sessions["session-1"]?.closedAt).toBe("2026-10-19T11:00:00Z");
  expect(state.runningScopes).toEqual([]);
});

it("events from another mode never enter the projection", () => {
  const formal = applyExecutionEvent(
    emptyExecutionProjection("act-1", "formal"),
    started(1, "rehearsal"),
  );
  expect(formal.sessions).toEqual({});
  expect(formal.runningScopes).toEqual([]);
});

it("a duplicate started event is idempotent", () => {
  const once = applyExecutionEvent(
    emptyExecutionProjection("act-1", "formal"),
    started(1, "formal"),
  );
  const twice = applyExecutionEvent(once, started(1, "formal"));
  expect(twice).toEqual(once);
});

it("a close for an unknown session is ignored", () => {
  const state = emptyExecutionProjection("act-1", "formal");
  expect(applyExecutionEvent(state, closed(1, "formal", "missing"))).toEqual(state);
});

it("non-execution events leave the projection unchanged", () => {
  const state = emptyExecutionProjection("act-1", "formal");
  const other = event(1, "DefinitionReleased", "formal", {});
  expect(applyExecutionEvent(state, other)).toEqual(state);
});

it("replaying a sequence equals applying each event", () => {
  const first = applyExecutionEvent(
    emptyExecutionProjection("act-1", "formal"),
    started(1, "formal", "a"),
  );
  const second = applyExecutionEvent(first, started(2, "formal", "b", "stage-b"));
  const third = applyExecutionEvent(second, closed(3, "formal", "a"));
  expect(applyExecutionEvents(emptyExecutionProjection("act-1", "formal"), [
    started(1, "formal", "a"),
    started(2, "formal", "b", "stage-b"),
    closed(3, "formal", "a"),
  ])).toEqual(third);
});

it("property: a running scope always maps to a running session", () => {
  fc.assert(
    fc.property(
      fc.array(fc.boolean(), { minLength: 1, maxLength: 30 }),
      (steps) => {
        let state = emptyExecutionProjection("act-1", "formal");
        steps.forEach((open, index) => {
          const id = `s-${index}`;
          state = applyExecutionEvent(
            state,
            open
              ? started(index + 1, "formal", id, `scope-${index}`)
              : closed(index + 1, "formal", id, `scope-${index}`),
          );
          for (const scope of state.runningScopes) {
            const running = Object.values(state.sessions).filter(
              (session) => session.scope === scope && session.status === "running",
            );
            expect(running).toHaveLength(1);
          }
        });
      },
    ),
  );
});
