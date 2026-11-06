import type { RuntimeEvent } from "@artflow-plus/domain";
import { describe, expect, it } from "vitest";

import {
  applyRegistrationEvent,
  emptyRegistrationProjection,
} from "../src/registration-projection.js";

function event(type: string, payload: unknown): RuntimeEvent {
  return {
    sequence: 1,
    eventId: "event-1",
    type,
    occurredAt: "2026-10-19T12:00:00Z",
    activityId: "activity-1",
    capability: "engine",
    aggregateId: "aggregate-1",
    revision: 0,
    payload,
  };
}

describe("registration projection", () => {
  it("ignores unrelated events without parsing their payload", () => {
    const state = emptyRegistrationProjection("activity-1");
    expect(() => applyRegistrationEvent(state, event("ProbeRecorded", 1))).not.toThrow();
    expect(applyRegistrationEvent(state, event("ProbeRecorded", 1))).toEqual(state);
  });
});
