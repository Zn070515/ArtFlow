import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("../../api/live.js", () => ({
  activatePanel: vi.fn(),
  describeLiveError: vi.fn(),
  lockPerformance: vi.fn(),
  lockRound: vi.fn(),
  openPerformance: vi.fn(),
  prepareRound: vi.fn(),
  recordTieDecision: vi.fn(),
  reopenRoundForCorrection: vi.fn(),
  resetRehearsal: vi.fn(),
  resolveRound: vi.fn(),
}));

import { recordTieDecision, type LiveRound, type LiveState } from "../../api/live.js";
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

  it("records a formal tie decision against the current tie group", () => {
    const tied = {
      ...live,
      ranking: {
        ...live.ranking!,
        status: "hold" as const,
        inputFingerprint: "fingerprint-1",
        tieGroups: [{ id: "tie-1", total: "90.00", contestants: ["singer-a", "singer-b"] }],
      },
    };
    const publishing = {
      ...state,
      activity: { ...state.activity, enabledCapabilities: ["publishing", "competition"] },
    };
    render(<LiveRoundPanel state={publishing} live={tied} sessionMode="formal" onChanged={vi.fn()} />);

    fireEvent.change(screen.getByLabelText("裁决原因"), { target: { value: "现场听感" } });
    fireEvent.click(screen.getByRole("button", { name: "裁决同分" }));

    expect(recordTieDecision).toHaveBeenCalledWith("activity-1", "round-1", "tie-1", {
      rankingSnapshotId: "ranking-1",
      inputFingerprint: "fingerprint-1",
      contestants: ["singer-a", "singer-b"],
      order: ["singer-a", "singer-b"],
      reason: "现场听感",
    });
  });

  it("sends a ready rehearsal ranking to Ops instead of publishing it", () => {
    const publishing = {
      ...state,
      activity: { ...state.activity, enabledCapabilities: ["publishing"] },
    };
    render(<LiveRoundPanel state={publishing} live={live} sessionMode="rehearsal" onChanged={vi.fn()} />);

    expect(screen.getByText(/排练排名不能公示/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "前往 Ops 核定并公示" })).toHaveAttribute("href", "/ops/activity-1");
  });
});
