import { describe, expect, it } from "vitest";

import type { LiveRound, LiveState } from "../../api/live.js";
import { deriveLiveCommand } from "./liveCommandModel.js";

function round(overrides: Partial<LiveRound> = {}): LiveRound {
  return {
    config: {
      key: "round-1",
      judgeCount: 2,
      minimumJudges: 1,
      completion: "all",
      advanceCount: 1,
      scoringMethod: "average",
    },
    round: {
      id: "round-row-1",
      roundKey: "round-1",
      state: "scoring",
      revision: 1,
      scoreVersion: 1,
      judgeCount: 2,
      minimumJudges: 1,
      currentPanelId: "panel-1",
    },
    panel: {
      id: "panel-1",
      roundId: "round-row-1",
      version: 1,
      state: "active",
      expectedJudges: 2,
      minimumJudges: 1,
      contextVersion: 1,
      current: true,
    },
    seats: [
      { id: "seat-1", judgeId: "judge-1", seatKey: "seat-1", state: "assigned", revision: 1 },
      { id: "seat-2", judgeId: "judge-2", seatKey: "seat-2", state: "assigned", revision: 1 },
    ],
    performances: [
      {
        id: "perf-1",
        contestantId: "c1",
        sequence: 1,
        state: "open",
        contextVersion: 1,
        scoreCount: 1,
        expectedJudges: 2,
      },
      {
        id: "perf-2",
        contestantId: "c2",
        sequence: 2,
        state: "not_opened",
        contextVersion: 1,
        scoreCount: 0,
        expectedJudges: 2,
      },
    ],
    ranking: null,
    ...overrides,
  };
}

function state(overrides: Partial<LiveState> = {}): LiveState {
  return {
    activity: {
      id: "act-1",
      publicCode: "LIVE-1",
      title: "现场",
      status: "active",
      revision: 1,
      enabledCapabilities: ["competition"],
      activeDefinitionVersion: 1,
    },
    config: { rounds: [], rubric: { criteria: [] }, tiePolicy: "review" },
    session: {
      id: "session-1",
      activityId: "act-1",
      definitionVersion: 1,
      contentHash: "hash",
      scope: "judging",
      mode: "rehearsal",
      status: "running",
      revision: 1,
      openedAt: "2026-11-18T00:00:00.000Z",
    },
    rounds: [round()],
    participantIds: ["c1", "c2"],
    participantNames: { c1: "林晓", c2: "周一" },
    ...overrides,
  };
}

describe("deriveLiveCommand", () => {
  it("reports no session without inventing a mode", () => {
    const view = deriveLiveCommand(state({
      session: null,
      rounds: [round({ round: null, performances: [], panel: null, seats: [] })],
    }));
    expect(view).toMatchObject({ session: "none", mode: null, phase: "no_session" });
    expect(view.next).toBeNull();
  });

  it("points at the next performance while a round waits to start", () => {
    const view = deriveLiveCommand(state({
      rounds: [round({
        round: { ...round().round!, state: "prepared" },
        performances: round().performances.map((performance) => ({ ...performance, state: "not_opened" })),
      })],
    }));
    expect(view.phase).toBe("awaiting_start");
    expect(view.current).toBeNull();
    expect(view.next).toMatchObject({ kind: "performance", sequence: 1, participantId: "c1" });
  });

  it("uses only the open performance as current and includes the score progress", () => {
    const view = deriveLiveCommand(state());
    expect(view.phase).toBe("scoring");
    expect(view.current).toMatchObject({ sequence: 1, participantId: "c1", scoreCount: 1, expectedJudges: 2 });
    expect(view.next).toMatchObject({ kind: "performance", sequence: 2, participantId: "c2" });
    expect(view.seats).toEqual({ assigned: 2, expected: 2, minimum: 1 });
    expect(view.readyToScore).toBe(true);
  });

  it("requires the current panel and the minimum seats before claiming ready", () => {
    const view = deriveLiveCommand(state({
      rounds: [round({ seats: round().seats.map((seat) => ({ ...seat, state: "proposed" })), panel: { ...round().panel!, current: false } })],
    }));
    expect(view.readyToScore).toBe(false);
  });

  it("reports all performances scored instead of a stale current", () => {
    const view = deriveLiveCommand(state({
      rounds: [round({ performances: round().performances.map((performance) => ({ ...performance, state: "locked" })) })],
    }));
    expect(view.phase).toBe("round_scored");
    expect(view.current).toBeNull();
    expect(view.next).toBeNull();
  });

  it("blocks the next round behind a hold or an unresolved ranking", () => {
    const view = deriveLiveCommand(state({
      rounds: [
        round({
          round: { ...round().round!, state: "locked" },
          ranking: {
            id: "ranking-1",
            status: "hold",
            rows: [],
            inputFingerprint: "fp",
            tieGroups: [],
            revision: 1,
            sourceScoreVersion: 1,
          },
        }),
        round({ config: { ...round().config, key: "round-2" } }),
      ],
    }));
    expect(view.phase).toBe("round_hold");
    expect(view.next).toMatchObject({ kind: "blocked" });
  });

  it("points at an unprepared next round after the current round is resolved", () => {
    const view = deriveLiveCommand(state({
      rounds: [
        round({
          round: { ...round().round!, state: "locked" },
          ranking: {
            id: "ranking-1",
            status: "ready",
            rows: [],
            inputFingerprint: "fp",
            tieGroups: [],
            revision: 1,
            sourceScoreVersion: 1,
          },
        }),
        round({ config: { ...round().config, key: "round-2" }, round: null, panel: null, seats: [], performances: [] }),
      ],
    }));
    expect(view.phase).toBe("round_resolved");
    expect(view.next).toMatchObject({ kind: "round", label: "准备第 2 轮" });
  });

  it("reports completion when every round is resolved", () => {
    const view = deriveLiveCommand(state({
      rounds: [round({ round: { ...round().round!, state: "resolved" } })],
    }));
    expect(view).toMatchObject({ phase: "completed", current: null, next: null });
  });

  it("makes a closed activity read-only", () => {
    const view = deriveLiveCommand(state({
      activity: { ...state().activity, status: "closed" },
    }));
    expect(view.phase).toBe("inactive");
    expect(view.current).toBeNull();
    expect(view.next).toBeNull();
  });
});
