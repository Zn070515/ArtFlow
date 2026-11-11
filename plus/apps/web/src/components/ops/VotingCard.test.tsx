import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { VotingSessionsSnapshot } from "@artflow-plus/contracts";

const fetchVotingSessionsMock = vi.hoisted(() => vi.fn());
const fetchExecutionsMock = vi.hoisted(() => vi.fn());
const fetchPublishingStateMock = vi.hoisted(() => vi.fn());
const previewVoteResultMock = vi.hoisted(() => vi.fn());

vi.mock("../../api/voting.js", () => ({
  fetchVotingSessions: fetchVotingSessionsMock,
  fetchExecutions: fetchExecutionsMock,
  fetchPublishingState: fetchPublishingStateMock,
  previewVoteResult: previewVoteResultMock,
  startExecution: vi.fn(),
  closeExecution: vi.fn(),
  openVoteSession: vi.fn(),
  closeVoteSession: vi.fn(),
  confirmVoteResult: vi.fn(),
  releaseVoteResult: vi.fn(),
}));

vi.mock("../../realtime/useRealtimeTopic.js", () => ({
  useRealtimeTopic: () => ({ fallback: false }),
}));

import { VotingCard } from "./VotingCard.js";

const NOTICE = "本场观众票使用浏览器身份，换设备可以再投。";

function snapshot(policy: "browser" | "ticket"): VotingSessionsSnapshot {
  return {
    activityId: "activity-1",
    identityPolicy: policy,
    sessions: [
      {
        id: "vote-1",
        status: "closed",
        mode: "formal",
        identityPolicy: policy,
        revision: 1,
        candidateCount: 1,
        candidates: [{ optionId: "opt-1", candidateId: "林晓雨", ordinal: 0 }],
        live: null,
      },
    ],
  };
}

function renderCard(policy: "browser" | "ticket"): void {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  fetchVotingSessionsMock.mockResolvedValue(snapshot(policy));
  fetchExecutionsMock.mockResolvedValue([]);
  fetchPublishingStateMock.mockResolvedValue({
    stages: [{ key: "vote_result", label: "投票结果" }],
  });
  previewVoteResultMock.mockResolvedValue({
    sessionId: "vote-1",
    sessionRevision: 1,
    mode: "formal",
    totalBallots: 1,
    status: "ready",
    inputFingerprint: "fp",
    decisions: [{ rank: 1, contestantId: "林晓雨", score: "100.00", count: 1, unit: "percent" }],
  });
  render(
    <QueryClientProvider client={queryClient}>
      <VotingCard
        activityId="activity-1"
        canManageVotes
        canManageResults
        canManageSessions
      />
    </QueryClientProvider>,
  );
}

describe("VotingCard identity notice", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("states that a browser ballot can be cast again from another device before open and before publish", async () => {
    renderCard("browser");

    expect(await screen.findByText(NOTICE)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "预览结果" }));
    await waitFor(() => {
      expect(screen.getAllByText(NOTICE)).toHaveLength(2);
    });
    expect(screen.getByRole("button", { name: "发布结果" })).toBeInTheDocument();
  });

  it("does not show the device warning for ticket identity", async () => {
    renderCard("ticket");

    expect(await screen.findByRole("button", { name: "预览结果" })).toBeInTheDocument();
    expect(screen.queryByText(NOTICE)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "预览结果" }));
    expect(await screen.findByRole("button", { name: "发布结果" })).toBeInTheDocument();
    expect(screen.queryByText(NOTICE)).not.toBeInTheDocument();
  });
});
