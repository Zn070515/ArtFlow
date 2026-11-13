import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { LiveState } from "../../api/live.js";

const fetchPublishingState = vi.hoisted(() => vi.fn());
const fetchExecutions = vi.hoisted(() => vi.fn());
const revokeResultRelease = vi.hoisted(() => vi.fn(async () => ({})));
const unlockStageResult = vi.hoisted(() => vi.fn(async () => ({})));

vi.mock("../../api/voting.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../api/voting.js")>();
  return {
    ...actual,
    fetchPublishingState,
    fetchExecutions,
    revokeResultRelease,
    unlockStageResult,
  };
});

import { ResultActions } from "./ResultActions.js";

const state: LiveState = {
  activity: {
    id: "act-1",
    publicCode: "LIVE-1",
    title: "决赛现场",
    status: "active",
    revision: 1,
    enabledCapabilities: ["competition", "publishing"],
    activeDefinitionVersion: 1,
  },
  config: {
    rounds: [],
    rubric: { criteria: [] },
    tiePolicy: "hold",
  },
  session: {
    id: "judging-session-1",
    activityId: "act-1",
    definitionVersion: 1,
    contentHash: "hash",
    scope: "judging",
    mode: "formal",
    status: "running",
    revision: 0,
    openedAt: "2026-11-13T10:00:00Z",
  },
  rounds: [],
  participantIds: [],
  participantNames: {},
};

const publishingSession = {
  id: "publishing-session-1",
  activityId: "act-1",
  definitionVersion: 1,
  contentHash: "hash",
  scope: "publishing",
  mode: "formal",
  status: "running",
  revision: 0,
  openedAt: "2026-11-13T10:00:00Z",
};

function publishingState(releases: readonly Record<string, unknown>[]) {
  return {
    stages: [{ key: "final", label: "决赛" }],
    podiumCandidate: null,
    stageResults: [
      { stageKey: "final", status: "confirmed", candidateRevision: 3, inputFingerprint: "fp" },
    ],
    releases,
    publications: [],
  };
}

const activeRelease = {
  id: "release-1",
  stageKey: "final",
  status: "active",
  note: "初始发布",
  releasedAt: "2026-11-13T10:00:00Z",
};

function renderResultActions() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <ResultActions activityId="act-1" state={state} onChanged={vi.fn()} />
    </QueryClientProvider>,
  );
}

function typeNote(value: string): void {
  fireEvent.change(screen.getByLabelText("发布 / 归档说明"), { target: { value } });
}

describe("ResultActions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fetchExecutions.mockResolvedValue([publishingSession]);
  });

  it("revokes an active release and unlocks a confirmed stage", async () => {
    fetchPublishingState.mockResolvedValue(publishingState([activeRelease]));
    const { container } = renderResultActions();

    await screen.findByRole("button", { name: "解锁赛果" });
    const status = container.querySelector('[data-release-status="active"]');
    expect(status).not.toBeNull();
    expect(status).toHaveTextContent(
      `决赛 · 生效 · ${new Date(activeRelease.releasedAt).toLocaleString("zh-CN")}`,
    );

    typeNote("现场撤回");
    expect(screen.getByRole("button", { name: "发布赛果" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "撤销发布" }));

    await waitFor(() => {
      expect(revokeResultRelease).toHaveBeenCalledWith("act-1", "release-1", "现场撤回");
      expect(screen.getByRole("button", { name: "解锁赛果" })).toBeEnabled();
    });
    fireEvent.click(screen.getByRole("button", { name: "解锁赛果" }));

    await waitFor(() => {
      expect(unlockStageResult).toHaveBeenCalledWith("act-1", "final", 3, "现场撤回");
    });
  });

  it("keeps release enabled on a fresh page with a confirmed stage result", async () => {
    fetchPublishingState.mockResolvedValue(publishingState([]));
    renderResultActions();

    await screen.findByRole("button", { name: "解锁赛果" });
    expect(screen.queryByTestId("release-status")).toBeNull();

    typeNote("重新发布");
    expect(screen.getByRole("button", { name: "发布赛果" })).toBeEnabled();
  });
});
