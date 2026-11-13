import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { RegistrationDetail } from "../../api/registrations.js";

const issueSupplementMock = vi.hoisted(() => vi.fn());

vi.mock("../../api/ops.js", () => ({
  issueSupplement: issueSupplementMock,
}));

import { SupplementPanel } from "./SupplementPanel.js";

const detail: RegistrationDetail = {
  activity: { id: "activity-1", title: "歌手赛", status: "active", publicCode: "SING" },
  registration: {
    id: "registration-1",
    activityId: "activity-1",
    participantId: "participant-1",
    questionnaireVersion: "v1",
    questionnaireHash: "hash",
    status: "need_supplement",
    answers: {},
    revision: 3,
  },
  questionnaire: {
    version: "v1",
    questions: [],
    fileSlots: [
      { key: "audio", slot: "audio", purpose: "伴奏", accepts: ["audio/mpeg"] },
    ],
  },
  materials: [],
};

function renderPanel(): void {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <SupplementPanel detail={detail} canManage onIssued={vi.fn()} />
    </QueryClientProvider>,
  );
}

describe("SupplementPanel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("issues a supplement for the selected slot only", async () => {
    issueSupplementMock.mockResolvedValue({
      token: "supplement-token",
      expiresAt: "2026-11-20T10:00:00.000Z",
      allowedKeys: ["audio"],
    });
    renderPanel();
    await screen.findByTestId("supplement-panel");
    const issue = screen.getByRole("button", { name: "发出补交授权" });
    expect(issue).toBeDisabled();
    fireEvent.click(screen.getByRole("checkbox", { name: /伴奏/ }));
    fireEvent.click(issue);
    await waitFor(() => expect(issueSupplementMock).toHaveBeenCalledWith(
      "activity-1",
      "registration-1",
      ["audio"],
      expect.any(String),
    ));
    const link = await screen.findByRole("link", { name: /supplement\?token=supplement-token/ });
    expect(link).toHaveAttribute("href", expect.stringContaining("/supplement?token=supplement-token"));
  });
});
