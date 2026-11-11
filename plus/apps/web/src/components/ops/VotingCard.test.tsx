import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const startExecutionMock = vi.hoisted(() => vi.fn());
const fetchExecutionsMock = vi.hoisted(() => vi.fn());
const fetchVotingSessionsMock = vi.hoisted(() => vi.fn());

vi.mock("../../api/voting.js", () => ({
  fetchVotingSessions: fetchVotingSessionsMock,
  fetchExecutions: fetchExecutionsMock,
  fetchPublishingState: vi.fn(),
  startExecution: startExecutionMock,
  closeExecution: vi.fn(),
  openVoteSession: vi.fn(),
  closeVoteSession: vi.fn(),
  previewVoteResult: vi.fn(),
  confirmVoteResult: vi.fn(),
  releaseVoteResult: vi.fn(),
}));

vi.mock("../../realtime/useRealtimeTopic.js", () => ({
  useRealtimeTopic: () => ({ fallback: false }),
}));

import { VotingCard } from "./VotingCard.js";

function renderCard(): void {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <VotingCard
        activityId="activity-1"
        canManageVotes
        canManageResults={false}
        canManageSessions
      />
    </QueryClientProvider>,
  );
}

function startButton(scope: string): HTMLButtonElement {
  const row = screen.getByText(`${scope} 会话`).closest("div");
  const button = row?.querySelector("button");
  if (button === null || button === undefined) throw new Error(`missing ${scope} start button`);
  return button;
}

describe("VotingCard execution start", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fetchVotingSessionsMock.mockResolvedValue({ activityId: "activity-1", sessions: [] });
    fetchExecutionsMock.mockResolvedValue([]);
    startExecutionMock.mockResolvedValue({ id: "session-1", mode: "rehearsal", status: "running", revision: 0 });
  });

  it("starts voting in rehearsal unless formal is confirmed", async () => {
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    renderCard();

    const mode = await screen.findByRole("combobox", { name: "启动模式" });
    expect(mode).toHaveValue("rehearsal");
    fireEvent.click(startButton("voting"));
    await waitFor(() => expect(startExecutionMock).toHaveBeenCalledWith("activity-1", "voting", "rehearsal"));
    expect(confirm).not.toHaveBeenCalled();

    startExecutionMock.mockClear();
    fireEvent.change(mode, { target: { value: "formal" } });
    fireEvent.click(startButton("publishing"));
    expect(confirm).toHaveBeenCalled();
    expect(startExecutionMock).not.toHaveBeenCalled();

    confirm.mockReturnValue(true);
    fireEvent.click(startButton("publishing"));
    await waitFor(() => expect(startExecutionMock).toHaveBeenCalledWith("activity-1", "publishing", "formal"));
    confirm.mockRestore();
  });
});
