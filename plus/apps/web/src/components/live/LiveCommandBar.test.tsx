import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import type { LiveRound, LiveState } from "../../api/live.js";
import { LiveCommandBar } from "./LiveCommandBar.js";

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

function renderBar(
  liveState: LiveState = state(),
  permissions: {
    readonly canManageSession?: boolean;
    readonly canManageSetup?: boolean;
    readonly canManageCompetition?: boolean;
    readonly canManageResults?: boolean;
  } = {},
) {
  return render(
    <LiveCommandBar
      state={liveState}
      canManageSession={permissions.canManageSession ?? true}
      canManageSetup={permissions.canManageSetup ?? true}
      canManageCompetition={permissions.canManageCompetition ?? true}
      canManageResults={permissions.canManageResults ?? true}
    />,
  );
}

describe("LiveCommandBar", () => {
  it("shows no session without inventing a mode and offers the start anchor", () => {
    renderBar(state({
      session: null,
      rounds: [round({ round: null, panel: null, seats: [], performances: [] })],
    }));

    const bar = screen.getByTestId("live-command");
    expect(bar).toHaveTextContent("未启动评分会话");
    expect(bar).not.toHaveTextContent("正式");
    expect(within(bar).getByRole("link", { name: "去启动会话" })).toHaveAttribute("href", "#live-session");
  });

  it("renders the current performance, score progress, seats and next", () => {
    renderBar();

    const bar = screen.getByTestId("live-command");
    expect(bar).toHaveTextContent("第 1 轮 · 第 1 位 · 林晓");
    expect(bar).toHaveTextContent("评分 1/2");
    expect(bar).toHaveTextContent("席位 2/2（最低 1）");
    expect(bar).toHaveTextContent("可评分");
    expect(bar).toHaveTextContent("第 1 轮 · 第 2 位");
    expect(within(bar).getByRole("link", { name: "去评分" })).toHaveAttribute("href", "#round-round-1");
    expect(within(bar).getByRole("link", { name: /第 1 轮 · 评分中/ })).toHaveAttribute("href", "#round-round-1");
  });

  it("blocks the next round behind a hold", () => {
    renderBar(state({
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
      ],
    }));

    const bar = screen.getByTestId("live-command");
    expect(bar).toHaveTextContent("HOLD");
    expect(bar).toHaveTextContent("先处理 HOLD/解析排名");
    expect(within(bar).getByRole("link", { name: "去处理 HOLD" })).toHaveAttribute("href", "#live-tie-round-1");
  });

  it("hides the hold action without competition manage permission", () => {
    renderBar(
      state({
        rounds: [round({
          round: { ...round().round!, state: "locked" },
          ranking: {
            id: "ranking-1", status: "hold", rows: [], inputFingerprint: "fp",
            tieGroups: [], revision: 1, sourceScoreVersion: 1,
          },
        })],
      }),
      { canManageCompetition: false },
    );

    expect(screen.queryByRole("link", { name: "去处理 HOLD" })).not.toBeInTheDocument();
    expect(screen.getByTestId("live-command")).toHaveTextContent("HOLD");
  });

  it("shows the result action when every round is resolved", () => {
    renderBar(state({ rounds: [round({ round: { ...round().round!, state: "resolved" } })] }));

    const bar = screen.getByTestId("live-command");
    expect(bar).toHaveTextContent("全部轮次已完成");
    expect(within(bar).getByRole("link", { name: "查看/发布赛果" })).toHaveAttribute("href", "#live-result");
  });

  it("makes a closed activity read-only", () => {
    renderBar(state({ activity: { ...state().activity, status: "closed" } }));

    const bar = screen.getByTestId("live-command");
    expect(bar).toHaveTextContent("活动已结束");
    expect(within(bar).queryByRole("link", { name: "去启动会话" })).not.toBeInTheDocument();
    expect(within(bar).queryByRole("link", { name: "去评分" })).not.toBeInTheDocument();
  });
});
