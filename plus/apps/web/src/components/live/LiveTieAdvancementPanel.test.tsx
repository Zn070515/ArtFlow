import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { LiveRound, LiveState, RoundScoresResponse } from "../../api/live.js";

const fetchRoundScoresMock = vi.hoisted(() => vi.fn());
const decideTieMock = vi.hoisted(() => vi.fn(async () => ({})));
const finalizeAdvancementMock = vi.hoisted(() => vi.fn(async () => ({})));
const describeLiveErrorMock = vi.hoisted(() =>
  vi.fn((_error: unknown, fallback: string) => fallback),
);

vi.mock("../../api/live.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../api/live.js")>();
  return {
    ...actual,
    fetchRoundScores: fetchRoundScoresMock,
    decideTie: decideTieMock,
    finalizeAdvancement: finalizeAdvancementMock,
    describeLiveError: describeLiveErrorMock,
  };
});

import { LiveTieAdvancementPanel } from "./LiveTieAdvancementPanel.js";

const formalSession: NonNullable<LiveState["session"]> = {
  id: "session-1",
  activityId: "activity-1",
  definitionVersion: 1,
  contentHash: "hash",
  scope: "judging",
  mode: "formal",
  status: "running",
  revision: 0,
  openedAt: "2026-11-13T10:00:00.000Z",
};

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
    tiePolicy: "review",
  },
  session: formalSession,
  rounds: [],
  participantIds: ["singer-a", "singer-b", "singer-c"],
  participantNames: { "singer-a": "甲", "singer-b": "乙", "singer-c": "丙" },
};

const live: LiveRound = {
  config: {
    key: "final",
    judgeCount: 1,
    minimumJudges: 1,
    completion: "all",
    advanceCount: 1,
    scoringMethod: "average",
  },
  round: {
    id: "round-1",
    roundKey: "final",
    state: "locked",
    revision: 3,
    scoreVersion: 3,
    judgeCount: 1,
    minimumJudges: 1,
    currentPanelId: "panel-1",
  },
  panel: null,
  seats: [],
  performances: [],
  ranking: null,
};

const tieRanking = {
  id: "ranking-1",
  revision: 1,
  status: "hold" as const,
  inputFingerprint: "fp-1",
  rows: [
    { contestantId: "singer-a", total: "90.00", judgeCount: 1 },
    { contestantId: "singer-b", total: "90.00", judgeCount: 1 },
    { contestantId: "singer-c", total: "80.00", judgeCount: 1 },
  ],
  tieGroups: [{ id: "tie-1", total: "90.00", contestants: ["singer-a", "singer-b"] }],
};

function scores(overrides: Partial<RoundScoresResponse> = {}): RoundScoresResponse {
  return {
    round: { key: "final", state: "locked", revision: 3, scoreVersion: 3, advanceCount: 1 },
    session: { id: "session-1", mode: "formal", scope: "judging" },
    ranking: tieRanking,
    advancement: null,
    performances: [],
    facts: [],
    ...overrides,
  };
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
  const onChanged = vi.fn();
  const view = render(
    <QueryClientProvider client={queryClient}>
      <LiveTieAdvancementPanel
        activityId="act-1"
        live={options.live ?? live}
        state={options.state ?? state}
        onChanged={onChanged}
      />
    </QueryClientProvider>,
  );
  return { ...view, onChanged };
}

describe("LiveTieAdvancementPanel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("only allows tie and advancement decisions in formal mode", async () => {
    fetchRoundScoresMock.mockResolvedValue(scores());
    renderPanel({
      state: { ...state, session: { ...formalSession, mode: "rehearsal" } },
    });

    expect(await screen.findByText("仅正式模式可以裁决平局或定稿晋级。")).toBeVisible();
    expect(screen.queryByRole("button", { name: "记录裁决" })).toBeNull();
    expect(screen.queryByRole("button", { name: "晋级定稿" })).toBeNull();
  });

  it("records a crossing tie with the ranking snapshot and local order", async () => {
    fetchRoundScoresMock.mockResolvedValue(scores());
    const { onChanged } = renderPanel();

    fireEvent.change(await screen.findByLabelText("裁决原因"), {
      target: { value: "现场裁决" },
    });
    fireEvent.click(screen.getByRole("button", { name: "记录裁决" }));

    await waitFor(() => {
      expect(decideTieMock).toHaveBeenCalledWith("act-1", "final", {
        tieId: "tie-1",
        rankingSnapshotId: "ranking-1",
        inputFingerprint: "fp-1",
        contestants: ["singer-a", "singer-b"],
        order: ["singer-a", "singer-b"],
        reason: "现场裁决",
      });
    });
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
  });

  it("finalizes advancement with the current ranking revision", async () => {
    fetchRoundScoresMock.mockResolvedValue(scores({
      ranking: { ...tieRanking, status: "ready", tieGroups: [] },
    }));
    renderPanel();

    const button = await screen.findByRole("button", { name: "晋级定稿" });
    expect(button).toBeEnabled();
    fireEvent.click(button);

    await waitFor(() => {
      expect(finalizeAdvancementMock).toHaveBeenCalledWith("act-1", "final", 1);
    });
  });

  it("warns when the advancement fingerprint is stale", async () => {
    fetchRoundScoresMock.mockResolvedValue(scores({
      ranking: { ...tieRanking, status: "ready", tieGroups: [] },
      advancement: {
        id: "advancement-1",
        revision: 2,
        status: "auto",
        inputFingerprint: "fp-old",
        decisions: [
          { contestantId: "singer-a", advanced: true },
          { contestantId: "singer-b", advanced: false },
          { contestantId: "singer-c", advanced: false },
        ],
      },
    }));
    renderPanel();

    expect(await screen.findByRole("alert")).toHaveTextContent("晋级名单已过期，请重新定稿。");
  });
});
