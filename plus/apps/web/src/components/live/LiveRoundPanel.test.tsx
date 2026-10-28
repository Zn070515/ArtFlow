import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("../../api/live.js", () => ({
  activatePanel: vi.fn(),
  describeLiveError: vi.fn(),
  lockPerformance: vi.fn(),
  lockRound: vi.fn(),
  openPerformance: vi.fn(),
  prepareRound: vi.fn(),
  reopenRoundForCorrection: vi.fn(),
  resetRehearsal: vi.fn(),
  resolveRound: vi.fn(),
}));

import type { LiveRound, LiveState } from "../../api/live.js";
import { LiveRoundPanel } from "./LiveRoundPanel.js";

const state: LiveState = {
  activity: {
    id: "activity-1",
    publicCode: "SPRING-1",
    title: "春季现场",
    status: "active",
    revision: 2,
    enabledCapabilities: ["ticketing"],
    activeDefinitionVersion: 1,
  },
  config: {
    rounds: [],
    rubric: { criteria: [] },
    tiePolicy: "hold",
  },
  session: null,
  rounds: [],
  participantIds: ["singer-a"],
};

const live: LiveRound = {
  config: {
    key: "round-1",
    judgeCount: 1,
    minimumJudges: 1,
    completion: "all",
    advanceCount: 1,
    scoringMethod: "sum",
  },
  round: {
    id: "round-1",
    roundKey: "round-1",
    state: "scoring",
    revision: 1,
    scoreVersion: 1,
    judgeCount: 1,
    minimumJudges: 1,
    currentPanelId: "panel-1",
  },
  panel: {
    id: "panel-1",
    roundId: "round-1",
    version: 1,
    state: "active",
    expectedJudges: 1,
    minimumJudges: 1,
    contextVersion: 1,
    current: true,
  },
  seats: [{
    id: "seat-1",
    judgeId: "judge-1",
    seatKey: "seat-1",
    state: "assigned",
    revision: 1,
  }],
  performances: [{
    id: "performance-1",
    contestantId: "singer-a",
    sequence: 1,
    state: "open",
    contextVersion: 1,
    scoreCount: 1,
    expectedJudges: 1,
  }],
  ranking: {
    id: "ranking-1",
    status: "ready",
    rows: [{ contestantId: "singer-a", total: "90.00", judgeCount: 1 }],
    tieGroups: [],
    revision: 1,
    sourceScoreVersion: 1,
  },
};

describe("LiveRoundPanel", () => {
  it("keeps round actions visible and wraps operational tables for narrow screens", () => {
    render(<LiveRoundPanel state={state} live={live} sessionMode="formal" onChanged={vi.fn()} />);

    expect(document.querySelector(".live-round-actions")).not.toBeNull();
    expect(document.querySelectorAll(".console-table-wrap")).toHaveLength(2);
    expect(screen.getByRole("button", { name: "锁轮" })).toBeVisible();
    expect(screen.getByRole("button", { name: "生成排名" })).toBeVisible();
  });
});
