import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

const closeJudgeEntryMock = vi.hoisted(() => vi.fn());

vi.mock("../../api/live.js", () => ({
  closeSession: vi.fn(),
  closeJudgeEntry: closeJudgeEntryMock,
  describeLiveError: (_error: unknown, fallback: string) => fallback,
  judgeEntryUrl: () => "/judge/NLDC99ZM",
  reissueJudgeEntry: vi.fn(),
  startJudgingSession: vi.fn(),
}));

import type { LiveState } from "../../api/live.js";
import { LiveSessionPanel } from "./LiveSessionPanel.js";

function stateWithSeats(seats: LiveState["rounds"][number]["seats"]): LiveState {
  return {
    activity: {
      id: "activity-1",
      publicCode: "NLDC99ZM",
      title: "春季现场",
      status: "active",
      revision: 1,
      enabledCapabilities: ["competition", "ticketing"],
      activeDefinitionVersion: 1,
    },
    config: { schemaVersion: 1, nodes: [], edges: [], rounds: [] },
    session: {
      id: "session-1",
      activityId: "activity-1",
      definitionVersion: 1,
      contentHash: "hash",
      scope: "judging",
      mode: "rehearsal",
      status: "running",
      revision: 0,
      openedAt: "2026-11-11T10:00:00.000Z",
    },
    rounds: [
      {
        config: {
          key: "final",
          judgeCount: 3,
          minimumJudges: 2,
          completion: "minimum_valid",
          advanceCount: 1,
          scoringMethod: "average",
        },
        round: null,
        panel: null,
        seats,
        performances: [],
        ranking: null,
      },
    ],
    participantIds: [],
    participantNames: {},
  } as unknown as LiveState;
}

describe("LiveSessionPanel", () => {
  it("disables judge entry links until a panel has created seats", () => {
    render(<LiveSessionPanel state={stateWithSeats([])} onChanged={vi.fn()} />);

    expect(screen.getByRole("button", { name: "生成评委入口链接" })).toBeDisabled();
    expect(
      screen.getByText("先在回合里激活评委组；席位就绪前生成的链接无法被评委使用。"),
    ).toBeInTheDocument();
  });

  it("enables judge entry links once seats exist", () => {
    render(
      <LiveSessionPanel
        state={stateWithSeats([
          { id: "seat-1", judgeId: "judge-1", seatKey: "A", state: "assigned", revision: 0 },
        ])}
        onChanged={vi.fn()}
      />,
    );

    expect(screen.getByRole("button", { name: "生成评委入口链接" })).toBeEnabled();
    expect(screen.getByText("重新生成会让之前发出的旧链接失效。")).toBeInTheDocument();
  });

  it("closes the judge entry with a reason", () => {
    closeJudgeEntryMock.mockReset();
    closeJudgeEntryMock.mockResolvedValue(undefined);
    render(
      <LiveSessionPanel
        state={stateWithSeats([
          { id: "seat-1", judgeId: "judge-1", seatKey: "A", state: "assigned", revision: 0 },
        ])}
        onChanged={vi.fn()}
      />,
    );

    const close = screen.getByRole("button", { name: "关闭评委入口" });
    expect(close).toBeDisabled();
    fireEvent.change(screen.getByLabelText("关闭评委入口的原因"), {
      target: { value: "本场评委已全部入场" },
    });
    fireEvent.click(close);

    expect(closeJudgeEntryMock).toHaveBeenCalledWith("activity-1", "本场评委已全部入场");
  });
});
