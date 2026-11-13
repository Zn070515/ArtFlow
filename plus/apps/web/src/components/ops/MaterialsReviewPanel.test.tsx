import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { RegistrationDetail } from "../../api/registrations.js";

const reviewMaterialMock = vi.hoisted(() => vi.fn());

vi.mock("../../api/registrations.js", () => ({
  reviewMaterial: reviewMaterialMock,
}));

import { MaterialsReviewPanel } from "./MaterialsReviewPanel.js";

const detail: RegistrationDetail = {
  activity: { id: "activity-1", title: "歌手赛", status: "active", publicCode: "SING" },
  registration: {
    id: "registration-1",
    activityId: "activity-1",
    participantId: "participant-1",
    questionnaireVersion: "v1",
    questionnaireHash: "hash",
    status: "submitted",
    answers: { name: "选手甲" },
    revision: 2,
  },
  questionnaire: { version: "v1", questions: [], fileSlots: [] },
  materials: [
    {
      id: "material-1",
      questionKey: "audio",
      originalName: "song.mp3",
      contentType: "audio/mpeg",
      byteLength: 1024,
      status: "submitted",
      contentReady: false,
      revision: 1,
    },
  ],
};

function renderPanel(canManage = true): void {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <MaterialsReviewPanel detail={detail} canManage={canManage} onReviewed={vi.fn()} />
    </QueryClientProvider>,
  );
}

describe("MaterialsReviewPanel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("blocks approval until the material bytes are stored", async () => {
    renderPanel();
    expect(await screen.findByTestId("materials-review-panel")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "通过" })).toBeDisabled();
  });

  it("requests a supplement with the material revision", async () => {
    reviewMaterialMock.mockResolvedValue({ ...detail.materials[0], status: "needs_supplement" });
    renderPanel();
    await screen.findByTestId("materials-review-panel");
    fireEvent.change(screen.getByLabelText("材料审核意见"), { target: { value: "请重新上传" } });
    fireEvent.click(screen.getByRole("button", { name: "需补充" }));
    await waitFor(() => expect(reviewMaterialMock).toHaveBeenCalledWith(
      "activity-1",
      "registration-1",
      "material-1",
      expect.any(String),
      { expectedRevision: 1, status: "needs_supplement", note: "请重新上传" },
    ));
  });
});
