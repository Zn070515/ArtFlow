import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ApiError } from "../../api/client.js";
import type { LiveRound, LiveState, RoundScoresResponse } from "../../api/live.js";

const fetchRoundScoresMock = vi.hoisted(() => vi.fn());
const openScoreCorrectionMock = vi.hoisted(() => vi.fn(async () => ({})));
const editScoreFactMock = vi.hoisted(() => vi.fn(async () => ({})));
const closeScoreCorrectionMock = vi.hoisted(() => vi.fn(async () => ({})));
const recalculateAfterCorrectionMock = vi.hoisted(() => vi.fn(async () => ({})));
const describeLiveErrorMock = vi.hoisted(() =>
  vi.fn((_error: unknown, fallback: string) => fallback),
);

vi.mock("../../api/live.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../api/live.js")>();
  return {
    ...actual,
    fetchRoundScores: fetchRoundScoresMock,
    openScoreCorrection: openScoreCorrectionMock,
    editScoreFact: editScoreFactMock,
    closeScoreCorrection: closeScoreCorrectionMock,
    recalculateAfterCorrection: recalculateAfterCorrectionMock,
    describeLiveError: describeLiveErrorMock,
  };
});

import { LiveExceptionPanel } from "./LiveExceptionPanel.js";

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
    rubric: { criteria: [{ key: "total", weight: 1, maximum: 100 }] },
    tiePolicy: "hold",
  },
  session: {
    id: "session-1",
    activityId: "activity-1",
    definitionVersion: 1,
    contentHash: "hash",
    scope: "judging",
    mode: "formal",
    status: "running",
    revision: 0,
    openedAt: "2026-11-13T10:00:00.000Z",
  },
  rounds: [],
  participantIds: ["singer-a"],
  participantNames: { "singer-a": "林晓雨" },
};

const twoCriterionState: LiveState = {
  ...state,
  config: {
    ...state.config,
    rubric: {
      criteria: [
        { key: "total", weight: 1, maximum: 100 },
        { key: "artistry", weight: 1, maximum: 10 },
      ],
    },
  },
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
    state: "locked",
    contextVersion: 1,
    scoreCount: 1,
    expectedJudges: 1,
  }],
  ranking: null,
};

const baseFact = {
  id: "fact-1",
  performanceId: "performance-1",
  contestantId: "singer-a",
  judgeId: "judge-1",
  seatId: "seat-1",
  source: "direct_judge" as const,
  total: "90.00",
  criteria: { total: 90 },
  notes: "",
  version: 3,
  contextVersion: 1,
  panelSnapshotId: "panel-1",
  correction: null,
};

function scores(overrides: Partial<RoundScoresResponse> = {}): RoundScoresResponse {
  return {
    round: {
      key: "round-1",
      state: "scoring",
      revision: 1,
      scoreVersion: 1,
      advanceCount: 1,
    },
    session: { id: "session-1", mode: "formal", scope: "judging" },
    ranking: null,
    advancement: null,
    performances: [{
      id: "performance-1",
      contestantId: "singer-a",
      sequence: 1,
      state: "locked",
      contextVersion: 1,
    }],
    facts: [baseFact],
    ...overrides,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function renderPanel(options: {
  readonly live?: LiveRound;
  readonly state?: LiveState;
} = {}) {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
  const element = (liveValue: LiveRound) => (
    <QueryClientProvider client={queryClient}>
      <LiveExceptionPanel
        activityId="act-1"
        live={liveValue}
        state={options.state ?? state}
        onChanged={vi.fn()}
      />
    </QueryClientProvider>
  );
  const view = render(element(options.live ?? live));
  return {
    ...view,
    rerenderWithLive(nextLive: LiveRound): void {
      view.rerender(element(nextLive));
    },
  };
}

describe("LiveExceptionPanel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("blocks correction when the round is locked", async () => {
    fetchRoundScoresMock.mockResolvedValue(scores());
    renderPanel({
      live: { ...live, round: { ...live.round!, state: "locked" } },
    });

    expect(await screen.findByText(/打开评分更正窗口/)).toBeVisible();
    expect(screen.queryByRole("button", { name: "开修正" })).toBeNull();
  });

  it("uses the short locked message outside formal mode", async () => {
    fetchRoundScoresMock.mockResolvedValue(scores());
    renderPanel({
      live: { ...live, round: { ...live.round!, state: "locked" } },
      state: {
        ...state,
        session: {
          id: "session-1",
          activityId: "activity-1",
          definitionVersion: 1,
          contentHash: "hash",
          scope: "judging",
          mode: "rehearsal",
          status: "running",
          revision: 0,
          openedAt: "2026-11-13T10:00:00.000Z",
        },
      },
    });

    expect(await screen.findByText("轮次已锁定。")).toBeVisible();
    expect(screen.queryByText(/打开评分更正窗口/)).toBeNull();
  });

  it("shows a retry block when the scores fail to load", async () => {
    fetchRoundScoresMock.mockRejectedValueOnce(new Error("boom"));
    renderPanel();

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "评分事实加载失败，请稍后重试。",
    );
    expect(screen.getByRole("button", { name: "重试" })).toBeVisible();
  });

  it("blocks correction when no judging session is running", async () => {
    fetchRoundScoresMock.mockResolvedValue(scores({ session: null }));
    renderPanel();

    expect(await screen.findByText("当前没有运行中的评分会话。")).toBeVisible();
    expect(screen.queryByRole("button", { name: "开修正" })).toBeNull();
  });

  it("opens a correction with the typed reason", async () => {
    fetchRoundScoresMock.mockResolvedValue(scores());
    renderPanel();

    fireEvent.click(await screen.findByRole("button", { name: "开修正" }));
    fireEvent.change(screen.getByLabelText("修正原因"), { target: { value: "看错分" } });
    fireEvent.click(screen.getByRole("button", { name: "确认开修正" }));

    await waitFor(() => {
      expect(openScoreCorrectionMock).toHaveBeenCalledWith("act-1", "round-1", {
        performanceId: "performance-1",
        scoreFactId: "fact-1",
        panelSnapshotId: "panel-1",
        reason: "看错分",
      });
    });
  });

  it("saves edited criteria with the correction id and expected version", async () => {
    fetchRoundScoresMock.mockResolvedValue(scores({
      facts: [{
        ...baseFact,
        correction: {
          id: "correction-1",
          state: "open",
          baseVersion: 1,
          reason: "看错分",
          revision: 0,
        },
      }],
    }));
    renderPanel();

    const total = await screen.findByLabelText("total");
    fireEvent.change(total, { target: { value: "95" } });
    fireEvent.click(screen.getByRole("button", { name: "保存修正" }));

    await waitFor(() => {
      expect(editScoreFactMock).toHaveBeenCalledWith("act-1", "round-1", {
        scoreFactId: "fact-1",
        performanceId: "performance-1",
        panelSnapshotId: "panel-1",
        seatId: "seat-1",
        contextVersion: 1,
        expectedVersion: 3,
        criteria: { total: 95 },
        reason: "看错分",
        correctionId: "correction-1",
      });
    });
  });

  it("sends every rubric key and keeps the untouched criterion", async () => {
    fetchRoundScoresMock.mockResolvedValue(scores({
      facts: [{
        ...baseFact,
        criteria: { total: 90, artistry: 8 },
        correction: {
          id: "correction-1",
          state: "open",
          baseVersion: 1,
          reason: "看错分",
          revision: 0,
        },
      }],
    }));
    renderPanel({ state: twoCriterionState });

    fireEvent.change(await screen.findByLabelText("total"), { target: { value: "95" } });
    fireEvent.click(screen.getByRole("button", { name: "保存修正" }));

    await waitFor(() => {
      expect(editScoreFactMock).toHaveBeenCalledWith("act-1", "round-1", {
        scoreFactId: "fact-1",
        performanceId: "performance-1",
        panelSnapshotId: "panel-1",
        seatId: "seat-1",
        contextVersion: 1,
        expectedVersion: 3,
        criteria: { total: 95, artistry: 8 },
        reason: "看错分",
        correctionId: "correction-1",
      });
    });
  });

  it("rejects out-of-range criteria before submitting", async () => {
    fetchRoundScoresMock.mockResolvedValue(scores({
      facts: [{
        ...baseFact,
        correction: {
          id: "correction-1",
          state: "open",
          baseVersion: 1,
          reason: "看错分",
          revision: 0,
        },
      }],
    }));
    renderPanel();

    fireEvent.change(await screen.findByLabelText("total"), { target: { value: "101" } });
    fireEvent.click(screen.getByRole("button", { name: "保存修正" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("不能大于");
    expect(editScoreFactMock).not.toHaveBeenCalled();
  });

  it("maps a correction command error to a Chinese alert", async () => {
    fetchRoundScoresMock.mockResolvedValue(scores());
    openScoreCorrectionMock.mockRejectedValueOnce(
      new ApiError(409, "RESULT_CONSUMED", "result consumed"),
    );
    renderPanel();

    fireEvent.click(await screen.findByRole("button", { name: "开修正" }));
    fireEvent.change(screen.getByLabelText("修正原因"), { target: { value: "看错分" } });
    fireEvent.click(screen.getByRole("button", { name: "确认开修正" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "该赛段结果已确认，请先解锁赛果。",
    );
  });

  it("resets criteria drafts when the correction changes", async () => {
    fetchRoundScoresMock.mockResolvedValueOnce(scores({
      facts: [{
        ...baseFact,
        criteria: { total: 90 },
        correction: {
          id: "correction-1",
          state: "open",
          baseVersion: 1,
          reason: "看错分",
          revision: 0,
        },
      }],
    }));
    const view = renderPanel();

    fireEvent.change(await screen.findByLabelText("total"), { target: { value: "80" } });
    expect((screen.getByLabelText("total") as HTMLInputElement).value).toBe("80");

    fetchRoundScoresMock.mockResolvedValue(scores({
      facts: [{
        ...baseFact,
        criteria: { total: 70 },
        correction: {
          id: "correction-2",
          state: "open",
          baseVersion: 2,
          reason: "重新修正",
          revision: 0,
        },
      }],
    }));
    view.rerenderWithLive({ ...live, round: { ...live.round!, revision: 2 } });

    await waitFor(() => {
      expect((screen.getByLabelText("total") as HTMLInputElement).value).toBe("70");
    });
  });

  it("keeps a typed draft across a pending revision refetch and prunes changed corrections", async () => {
    const first = scores({
      facts: [
        {
          ...baseFact,
          correction: {
            id: "correction-1",
            state: "open",
            baseVersion: 1,
            reason: "A",
            revision: 0,
          },
        },
        {
          ...baseFact,
          id: "fact-2",
          performanceId: "performance-2",
          contestantId: "singer-b",
          seatId: "seat-2",
          criteria: { total: 60 },
          correction: {
            id: "correction-2",
            state: "open",
            baseVersion: 1,
            reason: "B",
            revision: 0,
          },
        },
      ],
      performances: [
        {
          id: "performance-1",
          contestantId: "singer-a",
          sequence: 1,
          state: "locked",
          contextVersion: 1,
        },
        {
          id: "performance-2",
          contestantId: "singer-b",
          sequence: 2,
          state: "locked",
          contextVersion: 1,
        },
      ],
    });
    const pending = deferred<RoundScoresResponse>();
    fetchRoundScoresMock.mockResolvedValueOnce(first);
    fetchRoundScoresMock.mockReturnValueOnce(pending.promise);

    const view = renderPanel();
    await screen.findByTestId("score-fact-fact-2");
    const inputForB = () =>
      within(screen.getByTestId("score-fact-fact-2")).getByLabelText("total") as HTMLInputElement;

    fireEvent.change(inputForB(), { target: { value: "55" } });
    expect(inputForB().value).toBe("55");

    view.rerenderWithLive({ ...live, round: { ...live.round!, revision: 2 } });
    expect(inputForB().value).toBe("55");

    pending.resolve(scores({
      facts: [
        {
          ...baseFact,
          correction: {
            id: "correction-1",
            state: "open",
            baseVersion: 1,
            reason: "A",
            revision: 0,
          },
        },
        {
          ...baseFact,
          id: "fact-2",
          performanceId: "performance-2",
          contestantId: "singer-b",
          seatId: "seat-2",
          criteria: { total: 20 },
          correction: {
            id: "correction-3",
            state: "open",
            baseVersion: 2,
            reason: "B",
            revision: 0,
          },
        },
      ],
      performances: [
        {
          id: "performance-1",
          contestantId: "singer-a",
          sequence: 1,
          state: "locked",
          contextVersion: 1,
        },
        {
          id: "performance-2",
          contestantId: "singer-b",
          sequence: 2,
          state: "locked",
          contextVersion: 1,
        },
      ],
    }));

    await waitFor(() => {
      expect(inputForB().value).toBe("20");
    });
  });

  it("closes a revised correction", async () => {
    fetchRoundScoresMock.mockResolvedValue(scores({
      facts: [{
        ...baseFact,
        correction: {
          id: "correction-1",
          state: "revised",
          baseVersion: 1,
          reason: "看错分",
          revision: 1,
        },
      }],
    }));
    renderPanel();

    fireEvent.click(await screen.findByRole("button", { name: "关闭修正" }));

    await waitFor(() => {
      expect(closeScoreCorrectionMock).toHaveBeenCalledWith("act-1", "round-1", {
        scoreFactId: "fact-1",
        correctionId: "correction-1",
        panelSnapshotId: "panel-1",
        performanceId: "performance-1",
      });
    });
  });

  it("recalculates a closed correction and prompts for ranking", async () => {
    fetchRoundScoresMock.mockResolvedValue(scores({
      facts: [{
        ...baseFact,
        correction: {
          id: "correction-1",
          state: "closed",
          baseVersion: 1,
          reason: "看错分",
          revision: 2,
        },
      }],
    }));
    renderPanel();

    fireEvent.click(await screen.findByRole("button", { name: "重算" }));

    await waitFor(() => {
      expect(recalculateAfterCorrectionMock).toHaveBeenCalledWith("act-1", "round-1", {
        scoreFactId: "fact-1",
        correctionId: "correction-1",
        panelSnapshotId: "panel-1",
        performanceId: "performance-1",
      });
    });
    expect(
      await screen.findByText("重算完成，请点击「生成排名」更新排名。"),
    ).toBeVisible();
  });
});
