import { expect, it } from "vitest";

import { applyVotingLiveEvent } from "../src/index.js";

function event(type: string, payload: unknown, sequence: number) {
  return {
    sequence,
    eventId: `event-${sequence}`,
    type,
    occurredAt: "2026-10-19T18:00:00Z",
    activityId: "activity-1",
    capability: "voting",
    aggregateId: "vote-1",
    revision: sequence,
    mode: "formal" as const,
    scope: "voting",
    payload,
  };
}

it("projects provisional ballot counts and marks them non-authoritative", () => {
  const opened = applyVotingLiveEvent(null, event("VoteSessionOpened", {
    sessionId: "vote-1",
    optionIds: ["option-a", "option-b"],
  }, 1));
  const counted = applyVotingLiveEvent(opened, event("BallotSubmitted", {
    sessionId: "vote-1",
    ballotId: "ballot-1",
    optionIds: ["option-a"],
  }, 2));
  expect(counted).toMatchObject({ counts: { "option-a": 1, "option-b": 0 }, authoritative: false });
  const closed = applyVotingLiveEvent(counted, event("VoteSessionClosed", { sessionId: "vote-1" }, 3));
  expect(closed).toMatchObject({ status: "closed", authoritative: false });
});

it("fails closed when a ballot projection references an unknown option", () => {
  const opened = applyVotingLiveEvent(null, event("VoteSessionOpened", { sessionId: "vote-1", optionIds: ["option-a"] }, 1));
  expect(() => applyVotingLiveEvent(opened, event("BallotSubmitted", { sessionId: "vote-1", optionIds: ["other"] }, 2))).toThrow();
});
