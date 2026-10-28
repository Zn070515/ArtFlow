import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { fetchPublicVote, redeemTicket } from "../api/vote.js";
import { VotePage } from "./vote.js";

vi.mock("@tanstack/react-router", () => ({
  useParams: () => ({ sessionId: "vote-closed" }),
}));

vi.mock("../api/vote.js", () => ({
  fetchPublicVote: vi.fn(),
  redeemTicket: vi.fn(),
  submitVote: vi.fn(),
  ensureBrowserIdentity: vi.fn(),
}));

const fetchPublicVoteMock = vi.mocked(fetchPublicVote);
const redeemTicketMock = vi.mocked(redeemTicket);

describe("VotePage", () => {
  beforeEach(() => {
    window.history.replaceState(window.history.state, document.title, "/vote/vote-closed#ticket=issued-credential");
    fetchPublicVoteMock.mockResolvedValue({
      activityId: "activity-1",
      activityTitle: "Closed ticket vote",
      sessionId: "vote-closed",
      status: "closed",
      selectionType: "single",
      maxSelections: 1,
      identityPolicy: "ticket",
      candidates: [],
      voted: false,
      ticketReady: false,
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("does not redeem a ticket from a closed voting session", async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={queryClient}>
        <VotePage />
      </QueryClientProvider>,
    );

    expect(await screen.findByText("投票已结束。")).toBeInTheDocument();
    await waitFor(() => expect(redeemTicketMock).not.toHaveBeenCalled());
  });

  it("uses a two-area Portal workspace for an open ballot", async () => {
    fetchPublicVoteMock.mockResolvedValue({
      activityId: "activity-1",
      activityTitle: "Open ticket vote",
      sessionId: "vote-open",
      status: "open",
      selectionType: "single",
      maxSelections: 1,
      identityPolicy: "anonymous",
      candidates: [{ optionId: "option-1", candidateId: "alice" }],
      voted: false,
      ticketReady: true,
    });
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={queryClient}>
        <VotePage />
      </QueryClientProvider>,
    );

    expect(await screen.findByRole("radio", { name: "alice" })).toBeInTheDocument();
    expect(document.querySelector(".vote-workspace")).not.toBeNull();
    expect(document.querySelector(".vote-action-panel")).not.toBeNull();
    expect(screen.getByRole("button", { name: "投票" })).toHaveClass("primary-button");
    expect(screen.getByRole("button", { name: "投票" })).not.toHaveClass("button-primary");
  });
});
