import { beforeEach, describe, expect, it, vi } from "vitest";

const fetchActivityAnalyticsMock = vi.hoisted(() => vi.fn());
const fetchLiveStateMock = vi.hoisted(() => vi.fn());
const fetchOpsActivitiesMock = vi.hoisted(() => vi.fn());
const fetchStudioStateMock = vi.hoisted(() => vi.fn());

vi.mock("./analytics.js", () => ({ fetchActivityAnalytics: fetchActivityAnalyticsMock }));
vi.mock("./live.js", () => ({ fetchLiveState: fetchLiveStateMock }));
vi.mock("./ops.js", () => ({ fetchOpsActivities: fetchOpsActivitiesMock }));
vi.mock("./studio.js", () => ({ fetchStudioState: fetchStudioStateMock }));

import {
  fetchWorkspaceActivities,
  fetchWorkspaceAnalytics,
  fetchWorkspaceLiveState,
  fetchWorkspaceStudioState,
} from "./workspace.js";

describe("workspace API seam", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("reuses existing read clients instead of adding a second URL contract", async () => {
    fetchOpsActivitiesMock.mockResolvedValue([]);
    fetchActivityAnalyticsMock.mockResolvedValue({});
    fetchStudioStateMock.mockResolvedValue({});
    fetchLiveStateMock.mockResolvedValue({});

    await fetchWorkspaceActivities();
    await fetchWorkspaceAnalytics("activity-1");
    await fetchWorkspaceStudioState("activity-1");
    await fetchWorkspaceLiveState("activity-1");

    expect(fetchOpsActivitiesMock).toHaveBeenCalledOnce();
    expect(fetchActivityAnalyticsMock).toHaveBeenCalledWith("activity-1");
    expect(fetchStudioStateMock).toHaveBeenCalledWith("activity-1");
    expect(fetchLiveStateMock).toHaveBeenCalledWith("activity-1");
  });
});
