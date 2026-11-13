import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const fetchArchiveStateMock = vi.hoisted(() => vi.fn());

vi.mock("../../api/archive.js", () => ({
  fetchArchiveState: fetchArchiveStateMock,
  archiveFileUrl: (activityId: string, version?: number) =>
    `/api/activities/${activityId}/archive/file${version === undefined ? "" : `?version=${version}`}`,
}));

import { ArchiveCard } from "./ArchiveCard.js";

function renderCard(canManage = true): void {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <ArchiveCard activityId="activity-1" canManage={canManage} />
    </QueryClientProvider>,
  );
}

describe("ArchiveCard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fetchArchiveStateMock.mockResolvedValue({
      activity: { id: "activity-1", title: "春季现场", status: "archived" },
      packages: [{
        id: "archive-1",
        activityId: "activity-1",
        version: 2,
        sizeBytes: 2048,
        sha256: "abc",
        note: "",
        sealedAt: "2026-11-13T10:00:00.000Z",
        sealedBy: "staff",
        isCurrent: true,
      }],
    });
  });

  it("lists archived packages with a versioned download link", async () => {
    renderCard();
    expect(await screen.findByTestId("archive-card")).toBeInTheDocument();
    expect(screen.getByText(/版本 2/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /下载/ })).toHaveAttribute(
      "href",
      "/api/activities/activity-1/archive/file?version=2",
    );
  });

  it("renders nothing without archive.manage", () => {
    renderCard(false);
    expect(screen.queryByTestId("archive-card")).toBeNull();
    expect(fetchArchiveStateMock).not.toHaveBeenCalled();
  });
});
