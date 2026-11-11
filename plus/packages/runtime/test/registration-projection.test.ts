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

  it("returns a reopened roster to unknown", () => {
    const finalized = applyRegistrationEvent(
      emptyRegistrationProjection("activity-1"),
      {
        ...event("RosterFinalized", { approvedCount: 3, finalizedAt: "2026-11-11T10:00:00Z" }),
        revision: 1,
      },
    );
    expect(finalized.roster).toMatchObject({ status: "final", approvedCount: 3 });

    const reopened = applyRegistrationEvent(finalized, {
      ...event("RosterReopened", { reason: "mistake" }),
      revision: 2,
    });
    expect(reopened.roster).toEqual({ status: "unknown", revision: 2 });
  });
});
