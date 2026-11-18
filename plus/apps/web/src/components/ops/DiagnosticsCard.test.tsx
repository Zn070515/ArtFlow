import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const fetchRecentEventsMock = vi.hoisted(() => vi.fn());
const fetchExecutionStateMock = vi.hoisted(() => vi.fn());
const fetchOutboxHealthMock = vi.hoisted(() => vi.fn());
const retryProjectionMock = vi.hoisted(() => vi.fn());
const rebuildProjectionMock = vi.hoisted(() => vi.fn());

vi.mock("../../api/diagnostics.js", () => ({
  fetchRecentEvents: fetchRecentEventsMock,
  fetchExecutionState: fetchExecutionStateMock,
  fetchOutboxHealth: fetchOutboxHealthMock,
  retryProjection: retryProjectionMock,
  rebuildProjection: rebuildProjectionMock,
}));

import { DiagnosticsCard } from "./DiagnosticsCard.js";

function renderCard(canManage = true): void {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <DiagnosticsCard activityId="activity-1" canManage={canManage} />
    </QueryClientProvider>,
  );
}

describe("DiagnosticsCard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fetchRecentEventsMock.mockResolvedValue({
      events: [{
        sequence: 42,
        type: "RoundLocked",
        occurredAt: "2026-11-13T10:00:00.000Z",
        capability: "competition",
        aggregateId: "round-1",
        revision: 3,
        mode: "formal",
      }],
      nextCursor: 42,
      headCursor: 42,
    });
    fetchExecutionStateMock.mockResolvedValue({
      lastSequence: 40,
      headSequence: 42,
      stale: true,
      status: "running",
    });
    fetchOutboxHealthMock.mockResolvedValue({
      headSequence: 42,
      publishedHeadSequence: 40,
      pendingCount: 2,
    });
  });

  it("shows outbox lag, projection staleness and the latest events", async () => {
    renderCard();
    expect(await screen.findByTestId("diagnostics-card")).toBeInTheDocument();
    expect(await screen.findByText("待发布 2")).toBeInTheDocument();
    expect(await screen.findByText("投影落后")).toBeInTheDocument();
    expect((await screen.findAllByTestId("diagnostic-event-row"))[0]).toHaveTextContent("#42 · RoundLocked · competition · formal");
  });

  it("offers retry and rebuild when the formal projection is blocked", async () => {
    fetchExecutionStateMock.mockResolvedValue({
      lastSequence: 40,
      headSequence: 42,
      stale: true,
      status: "blocked",
      blockedSequence: 41,
      blockedReason: "projection failed",
    });
    retryProjectionMock.mockResolvedValue({ retried: true });
    renderCard();
    expect(await screen.findByText("投影阻塞")).toBeInTheDocument();
    expect(await screen.findByRole("button", { name: "重试投影" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "重建投影" })).toBeInTheDocument();
  });

  it("renders nothing without an operations permission", () => {
    renderCard(false);
    expect(screen.queryByTestId("diagnostics-card")).toBeNull();
    expect(fetchRecentEventsMock).not.toHaveBeenCalled();
  });
});
