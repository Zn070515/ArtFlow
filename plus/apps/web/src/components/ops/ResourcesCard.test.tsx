import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("../../api/resources.js", () => ({
  fetchResources: vi.fn(async () => ({
    activityId: "act-1",
    definitionVersion: 1,
    resources: [
      { key: "hall", name: "主礼堂", kind: "venue", capacity: 800, notes: "" },
    ],
    bookings: [
      {
        id: "booking-1",
        activityId: "act-1",
        resourceKey: "hall",
        resourceName: "主礼堂",
        title: "彩排",
        note: "",
        startsAt: "2026-11-20T10:00:00.000Z",
        endsAt: "2026-11-20T12:00:00.000Z",
        status: "draft",
        revision: 0,
        createdBy: "staff",
        createdAt: "2026-11-18T10:00:00.000Z",
        updatedAt: "2026-11-18T10:00:00.000Z",
      },
    ],
  })),
  createBooking: vi.fn(),
  confirmBooking: vi.fn(),
  cancelBooking: vi.fn(),
}));

import { ResourcesCard } from "./ResourcesCard.js";

describe("ResourcesCard", () => {
  it("shows resource definitions and draft bookings", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <ResourcesCard activityId="act-1" permissions={["resources.manage"]} />
      </QueryClientProvider>,
    );
    expect(await screen.findByText("资源与排练")).toBeInTheDocument();
    expect((await screen.findAllByText("主礼堂")).length).toBeGreaterThan(0);
    expect(await screen.findByText(/彩排/)).toBeInTheDocument();
    expect(await screen.findByRole("button", { name: "确认" })).toBeInTheDocument();
  });

  it("renders nothing without the permission", () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <ResourcesCard activityId="act-1" permissions={[]} />
      </QueryClientProvider>,
    );
    expect(screen.queryByTestId("resources-card")).toBeNull();
  });
});
