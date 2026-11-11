import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { VotingCard } from "./VotingCard.js";

const confirmVoteResultMock = vi.hoisted(() => vi.fn());
const fetchPublishingStateMock = vi.hoisted(() => vi.fn());
const fetchVotingSessionsMock = vi.hoisted(() => vi.fn());
const fetchExecutionsMock = vi.hoisted(() => vi.fn());
const previewVoteResultMock = vi.hoisted(() => vi.fn());

vi.mock("../../realtime/useRealtimeTopic.js", () => ({
  useRealtimeTopic: () => ({ fallback: false }),
}));

vi.mock("../../api/voting.js", () => ({
  closeExecution: vi.fn(),
  closeVoteSession: vi.fn(),
  confirmVoteResult: confirmVoteResultMock,
  fetchExecutions: fetchExecutionsMock,
  fetchPublishingState: fetchPublishingStateMock,
  fetchVotingSessions: fetchVotingSessionsMock,
  openVoteSession: vi.fn(),
  previewVoteResult: previewVoteResultMock,
  releaseVoteResult: vi.fn(),
  startExecution: vi.fn(),
}));

describe("VotingCard stage selection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fetchVotingSessionsMock.mockResolvedValue({
      activityId: "activity-1",
      sessions: [{
        id: "vote-1",
        status: "closed",
        revision: 1,
        mode: "formal",
        candidateCount: 1,
        candidates: [],
        live: null,
      }],
    });
    fetchExecutionsMock.mockResolvedValue([{
      id: "publishing-1",
      activityId: "activity-1",
      definitionVersion: 1,
      scope: "publishing",
      mode: "formal",
      status: "running",
      revision: 1,
    }]);
    fetchPublishingStateMock.mockResolvedValue({
      stages: [{ key: "final_podium", label: "正式赛果" }],
    });
    previewVoteResultMock.mockResolvedValue({
      sessionId: "vote-1",
      sessionRevision: 1,
      mode: "formal",
      totalBallots: 2,
      status: "ready",
      inputFingerprint: "fp-vote",
      decisions: [{ rank: 1, contestantId: "singer-a", score: "100.00", count: 2, unit: "percent" }],
    });
    confirmVoteResultMock.mockResolvedValue({ candidateRevision: 1 });
  });

  it("confirms an audience tally into the declared 正式赛果 stage", async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
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

    fireEvent.click(await screen.findByRole("button", { name: "预览结果" }));
    expect(await screen.findByText("将写入阶段「正式赛果」。")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "确认赛果" }));

    await vi.waitFor(() => {
      expect(confirmVoteResultMock).toHaveBeenCalledWith(
        "activity-1",
        "final_podium",
        expect.objectContaining({ inputFingerprint: "fp-vote" }),
      );
    });
  });
});
