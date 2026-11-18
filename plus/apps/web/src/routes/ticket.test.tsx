import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const useQueryMock = vi.hoisted(() => vi.fn());
const useMutationMock = vi.hoisted(() => vi.fn());
const lookupTicketMock = vi.hoisted(() => vi.fn());
const currentMock = vi.hoisted(() => vi.fn());
const voteMock = vi.hoisted(() => vi.fn());
const qrMock = vi.hoisted(() => vi.fn());

vi.mock("@tanstack/react-query", () => ({
  useQuery: useQueryMock,
  useMutation: useMutationMock,
}));
vi.mock("../api/tickets-public.js", () => ({
  lookupTicket: lookupTicketMock,
  fetchPublicCurrent: currentMock,
  fetchPublicVoteEntry: voteMock,
}));
vi.mock("qrcode", () => ({ toDataURL: qrMock }));

import { ApiError } from "../api/client.js";
import { TicketPage } from "./ticket.js";

const lookup = {
  ticket: {
    publicCode: "TICKET-1",
    state: "issued" as const,
    credentialVersion: 1,
    issuedAt: "2026-04-18T10:00:00.000Z",
  },
  activity: {
    publicCode: "LIVE-1",
    title: "电子票活动",
    status: "active" as const,
    startsAt: "2026-04-18T19:00:00.000Z",
    endsAt: null,
    venue: "剧场",
    organizer: "学生会",
  },
  links: { event: "/e/LIVE-1", results: "/results/LIVE-1" },
};

describe("TicketPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useMutationMock.mockImplementation(({ mutationFn }: {
      readonly mutationFn: (value: string) => Promise<unknown>;
    }) => ({ mutateAsync: mutationFn, isPending: false }));
    useQueryMock.mockImplementation(({ queryKey }: { readonly queryKey: readonly unknown[] }) => {
      if (queryKey[0] === "public-current") {
        return {
          data: {
            activity: { publicCode: "LIVE-1", title: "电子票活动", status: "active" },
            current: { order: 2, slotLabel: "第一轮", title: "第一首", note: "", startsAt: null },
            next: [{ order: 3, slotLabel: "第一轮", title: "第二首", note: "", startsAt: null }],
          },
          error: null,
          isPending: false,
        };
      }
      if (queryKey[0] === "public-vote-entry") {
        return { data: { sessionId: "vote-1", status: "open" }, error: null, isPending: false };
      }
      return { data: undefined, error: null, isPending: false };
    });
    lookupTicketMock.mockResolvedValue(lookup);
    qrMock.mockResolvedValue("data:image/png;base64,qr");
  });

  it("renders the ticket, QR, current program and vote link from the fragment", async () => {
    window.history.replaceState({}, "", "/t#ticket=T.PUBLIC.1.sig");
    render(<TicketPage />);
    expect(await screen.findByRole("heading", { name: "电子票活动" })).toBeInTheDocument();
    expect(await screen.findByAltText("入场二维码")).toHaveAttribute(
      "src",
      "data:image/png;base64,qr",
    );
    expect(screen.getByText(/票号 TICKET-1/)).toBeInTheDocument();
    expect(screen.getByText(/当前：第一首/)).toBeInTheDocument();
    const vote = screen.getByRole("link", { name: /去投票/ });
    expect(vote.getAttribute("href")).toContain("/vote/vote-1#ticket=");
  });

  it("shows a manual credential form without a fragment", async () => {
    window.history.replaceState({}, "", "/t");
    render(<TicketPage />);
    expect(screen.getByLabelText("入场凭证")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("入场凭证"), { target: { value: "T.MANUAL.1.sig" } });
    fireEvent.click(screen.getByRole("button", { name: "查看票据" }));
    await waitFor(() => expect(lookupTicketMock).toHaveBeenCalledWith("T.MANUAL.1.sig"));
  });

  it("shows the revoked state", async () => {
    window.history.replaceState({}, "", "/t#ticket=T.REVOKED.1.sig");
    lookupTicketMock.mockRejectedValue(new ApiError(410, "TICKET_REVOKED", "revoked"));
    render(<TicketPage />);
    expect(await screen.findByText("票据已撤销，请联系主办方。")).toBeInTheDocument();
  });
});
