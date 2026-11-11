import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ResultLifecycleCard, type ResultLifecycleActivity } from "./ResultLifecycleCard.js";

const previewPodiumMock = vi.hoisted(() => vi.fn());
const recomputePodiumMock = vi.hoisted(() => vi.fn());
const confirmStageResultMock = vi.hoisted(() => vi.fn());
const releaseStageResultMock = vi.hoisted(() => vi.fn());
const closeActivityMock = vi.hoisted(() => vi.fn());
const archiveActivityMock = vi.hoisted(() => vi.fn());
const fetchPublishingDetailMock = vi.hoisted(() => vi.fn());
const fetchArchiveStateMock = vi.hoisted(() => vi.fn());
const downloadArchiveFileMock = vi.hoisted(() => vi.fn());
const fetchExecutionsMock = vi.hoisted(() => vi.fn());
const startExecutionMock = vi.hoisted(() => vi.fn());
const closeExecutionMock = vi.hoisted(() => vi.fn());

vi.mock("../../api/results.js", () => ({
  previewPodium: previewPodiumMock,
  recomputePodium: recomputePodiumMock,
  confirmStageResult: confirmStageResultMock,
  releaseStageResult: releaseStageResultMock,
  closeActivity: closeActivityMock,
  archiveActivity: archiveActivityMock,
  fetchPublishingDetail: fetchPublishingDetailMock,
  fetchArchiveState: fetchArchiveStateMock,
  downloadArchiveFile: downloadArchiveFileMock,
}));

vi.mock("../../api/voting.js", () => ({
  fetchExecutions: fetchExecutionsMock,
  startExecution: startExecutionMock,
  closeExecution: closeExecutionMock,
}));

const activity: ResultLifecycleActivity = {
  id: "activity-1",
  publicCode: "SPRING-1",
  status: "active",
  revision: 4,
  hasCompetition: true,
  hasPublishing: true,
  hasArchive: true,
  canManageResults: true,
  canManageCompetition: true,
  canManageSessions: true,
  canClose: true,
  canArchive: true,
};

function renderCard(value: ResultLifecycleActivity = activity): void {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <ResultLifecycleCard activity={value} />
    </QueryClientProvider>,
  );
}

describe("ResultLifecycleCard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fetchExecutionsMock.mockResolvedValue([
      {
        id: "session-publishing",
        activityId: "activity-1",
        definitionVersion: 1,
        scope: "publishing",
        mode: "formal",
        status: "running",
        revision: 2,
      },
    ]);
    fetchPublishingDetailMock.mockResolvedValue({
      stages: [{ key: "final_podium", label: "正式赛果" }],
      stageResults: [],
      releases: [],
    });
    fetchArchiveStateMock.mockResolvedValue({ packages: [] });
    previewPodiumMock.mockResolvedValue({
      status: "candidate",
      placements: [{ place: 1, contestantId: "singer-a", total: "267.00" }],
      inputFingerprint: "fp-podium",
      roundIds: ["round-final"],
      blockedReason: null,
    });
    recomputePodiumMock.mockResolvedValue({ status: "candidate", revision: 1, inputFingerprint: "fp-podium" });
    confirmStageResultMock.mockResolvedValue({ candidateRevision: 7 });
    releaseStageResultMock.mockResolvedValue({});
    closeActivityMock.mockResolvedValue({ revision: 5, status: "closed" });
    archiveActivityMock.mockResolvedValue({ package: { version: 1 } });
  });

  it("confirms the judge podium on the declared final_podium stage and publishes it", async () => {
    renderCard();

    expect(await screen.findByText("将写入阶段「正式赛果」。")).toBeInTheDocument();
    const confirmButton = await screen.findByRole("button", { name: "核定赛果" });
    await vi.waitFor(() => expect(confirmButton).toBeEnabled());
    fireEvent.click(confirmButton);

    await vi.waitFor(() => {
      expect(confirmStageResultMock).toHaveBeenCalledWith("activity-1", "final_podium", {
        expectedSourceRevision: 1,
        expectedInputFingerprint: "fp-podium",
      });
    });
    expect(recomputePodiumMock).toHaveBeenCalledWith("activity-1", {
      scope: "publishing",
      roundIds: ["round-final"],
      expectedInputFingerprint: "fp-podium",
    });

    fireEvent.change(screen.getByLabelText("发布备注"), { target: { value: "正式公示" } });
    const releaseButton = screen.getByRole("button", { name: "公示" });
    await vi.waitFor(() => expect(releaseButton).toBeEnabled());
    fireEvent.click(releaseButton);
    await vi.waitFor(() => {
      expect(releaseStageResultMock).toHaveBeenCalledWith("activity-1", "final_podium", 7, "正式公示");
    });
  });

  it("closes an idle activity and archives it once the activity is closed", async () => {
    fetchExecutionsMock.mockResolvedValue([]);
    renderCard();
    fireEvent.click(await screen.findByRole("button", { name: "关闭活动" }));
    await vi.waitFor(() => {
      expect(closeActivityMock).toHaveBeenCalledWith("activity-1", 4);
    });
  });

  it("archives a closed activity with the current revision", async () => {
    fetchExecutionsMock.mockResolvedValue([]);
    renderCard({ ...activity, status: "closed", revision: 5 });
    fireEvent.change(await screen.findByLabelText("归档说明"), { target: { value: "赛后归档" } });
    fireEvent.click(screen.getByRole("button", { name: "归档" }));
    await vi.waitFor(() => {
      expect(archiveActivityMock).toHaveBeenCalledWith("activity-1", 5, "赛后归档");
    });
  });
});
