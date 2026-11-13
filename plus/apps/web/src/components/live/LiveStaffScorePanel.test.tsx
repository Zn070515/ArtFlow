import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const submitStaffScoreMock = vi.hoisted(() => vi.fn());

vi.mock("../../api/live.js", () => ({
  describeLiveError: (error: unknown, fallback: string) =>
    error instanceof Error ? error.message : fallback,
  submitStaffScore: submitStaffScoreMock,
}));

import type { LiveRound, LiveState } from "../../api/live.js";
import { LiveStaffScorePanel } from "./LiveStaffScorePanel.js";

const state: LiveState = {
  activity: {
    id: "activity-1",
    publicCode: "SPRING-1",
    title: "春季现场",
    status: "active",
    revision: 2,
    enabledCapabilities: ["competition"],
    activeDefinitionVersion: 1,
  },
  config: {
    rounds: [],
    rubric: { criteria: [{ key: "total", weight: 1, maximum: 100, minimum: 0 }] },
    tiePolicy: "hold",
  },
  session: null,
  rounds: [],
  participantIds: ["singer-a"],
  participantNames: { "singer-a": "林晓雨" },
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
  seats: [{ id: "seat-1", judgeId: "judge-1", seatKey: "seat-1", state: "assigned", revision: 1 }],
  performances: [{
    id: "performance-1",
    contestantId: "singer-a",
    sequence: 1,
    state: "open",
    contextVersion: 1,
    scoreCount: 0,
    expectedJudges: 1,
  }],
  ranking: null,
};

describe("LiveStaffScorePanel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("submits a rapid staff score for the selected seat", async () => {
    submitStaffScoreMock.mockResolvedValue({});
    render(<LiveStaffScorePanel state={state} live={live} onChanged={vi.fn()} />);
    fireEvent.change(screen.getByLabelText("评委席位"), { target: { value: "seat-1" } });
    fireEvent.change(screen.getByLabelText("total（0–100）"), { target: { value: "88" } });
    fireEvent.click(screen.getByRole("button", { name: "提交补录" }));
    await waitFor(() => expect(submitStaffScoreMock).toHaveBeenCalledWith({
      activityId: "activity-1",
      roundKey: "round-1",
      performanceId: "performance-1",
      panelSnapshotId: "panel-1",
      seatId: "seat-1",
      contextVersion: 1,
      criteria: { total: 88 },
      notes: "",
      source: "staff_rapid",
    }));
  });

  it("requires a source reference and reason for paper entry", async () => {
    submitStaffScoreMock.mockResolvedValue({});
    render(<LiveStaffScorePanel state={state} live={live} onChanged={vi.fn()} />);
    fireEvent.change(screen.getByLabelText("评委席位"), { target: { value: "seat-1" } });
    fireEvent.change(screen.getByLabelText("评分来源"), { target: { value: "paper_dr" } });
    fireEvent.change(screen.getByLabelText("total（0–100）"), { target: { value: "91" } });
    fireEvent.click(screen.getByRole("button", { name: "提交补录" }));
    expect(await screen.findByText("代录与纸面录入必须填写来源和说明。")).toBeInTheDocument();
    expect(submitStaffScoreMock).not.toHaveBeenCalled();
  });
});
