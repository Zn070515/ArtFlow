import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const fetchTicketingStateMock = vi.hoisted(() => vi.fn());
const issueTicketMock = vi.hoisted(() => vi.fn());
const rotateTicketMock = vi.hoisted(() => vi.fn());
const revokeTicketMock = vi.hoisted(() => vi.fn());
const revokeTicketSessionMock = vi.hoisted(() => vi.fn());

vi.mock("../../api/tickets.js", () => ({
  fetchTicketingState: fetchTicketingStateMock,
  issueTicket: issueTicketMock,
  rotateTicket: rotateTicketMock,
  revokeTicket: revokeTicketMock,
  revokeTicketSession: revokeTicketSessionMock,
}));

import { TicketsCard } from "./TicketsCard.js";

const state = {
  tickets: [
    {
      id: "ticket-1",
      publicCode: "PUBLIC-1",
      state: "issued" as const,
      credentialVersion: 1,
      issuedAt: "2026-11-13T10:00:00.000Z",
    },
  ],
  sessions: [
    {
      id: "session-1",
      ticketId: "ticket-1",
      expiresAt: "2026-11-13T12:00:00.000Z",
    },
  ],
};

function renderCard(canManage = true): void {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  fetchTicketingStateMock.mockResolvedValue(state);
  render(
    <QueryClientProvider client={queryClient}>
      <TicketsCard activityId="activity-1" canManage={canManage} />
    </QueryClientProvider>,
  );
}

describe("TicketsCard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("issues a ticket and shows the one-time credential", async () => {
    issueTicketMock.mockResolvedValue({
      ticket: { ...state.tickets[0], id: "ticket-2", publicCode: "PUBLIC-2" },
      credential: "T.PUBLIC-2.1.signature",
    });
    renderCard();
    await screen.findByTestId("tickets-card");
    fireEvent.click(screen.getByRole("button", { name: "签发新票据" }));
    await waitFor(() => expect(issueTicketMock).toHaveBeenCalledTimes(1));
    expect(await screen.findByText("T.PUBLIC-2.1.signature")).toBeInTheDocument();
  });

  it("requires a reason before revoking a ticket", async () => {
    revokeTicketMock.mockResolvedValue({ ...state.tickets[0], state: "revoked" });
    renderCard();
    await screen.findByTestId("ticket-row");
    const revoke = screen.getByRole("button", { name: "撤销票据" });
    expect(revoke).toBeDisabled();
    fireEvent.change(screen.getByLabelText("撤销说明"), { target: { value: "重复签发" } });
    fireEvent.click(revoke);
    await waitFor(() => expect(revokeTicketMock).toHaveBeenCalledWith(
      "activity-1",
      "ticket-1",
      "重复签发",
      expect.any(String),
    ));
  });

  it("hides write controls without ticket.manage", async () => {
    renderCard(false);
    await screen.findByTestId("tickets-card");
    expect(screen.queryByRole("button", { name: "签发新票据" })).toBeNull();
    expect(screen.queryByRole("button", { name: "撤销票据" })).toBeNull();
    expect(screen.queryByLabelText("撤销说明")).toBeNull();
  });
});
