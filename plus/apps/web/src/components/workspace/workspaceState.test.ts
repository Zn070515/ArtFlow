import { describe, expect, it } from "vitest";

import type { ActivityAnalyticsResponse } from "@artflow-plus/contracts";

import {
  buildWorkspaceProgress,
  pickWorkspaceNextAction,
  type WorkspaceActivity,
  type WorkspaceFacts,
} from "./workspaceState.js";

const activity: WorkspaceActivity = {
  id: "activity-1",
  title: "春季现场",
  publicCode: "SPRING-1",
  status: "active",
  revision: 2,
  enabledCapabilities: ["registration", "competition", "publishing"],
};

const analytics: ActivityAnalyticsResponse = {
  activity: {
    id: activity.id,
    title: activity.title,
    status: "active",
    enabledCapabilities: [...activity.enabledCapabilities],
  },
  registration: { total: 4, byStatus: { submitted: 3, approved: 1 } },
  materialChecks: { total: 0, byStatus: {}, requiredNotApproved: 0 },
  roster: { status: "unknown", approvedCount: null, revision: 1 },
  competition: {
    rounds: { total: 0, byState: {}, locked: 0 },
    performances: { total: 0, byState: {}, locked: 0 },
    scoreFacts: { total: 0, current: 0 },
  },
  voting: { sessions: { total: 0, byStatus: {} }, validBallots: 0 },
  publishing: {
    stageResults: { total: 0, byStatus: {}, stale: 0, confirmedWithoutActiveRelease: 0 },
    resultReleases: { total: 0, byStatus: {} },
  },
  archive: { totalPackages: 0, currentPackages: 0 },
  attention: [],
};

function facts(overrides: Partial<WorkspaceFacts> = {}): WorkspaceFacts {
  return {
    activity,
    analytics,
    studio: null,
    live: null,
    access: { studio: true, ops: true, live: true },
    ...overrides,
  };
}

describe("workspace state mapping", () => {
  it("maps registration attention to the Ops next action", () => {
    const result = pickWorkspaceNextAction(
      facts({
        analytics: { ...analytics, attention: [{ code: "REGISTRATION_REVIEW_PENDING", severity: "warning", count: 3 }] },
      }),
    );

    expect(result).toMatchObject({
      code: "REGISTRATION_REVIEW_PENDING",
      label: "处理报名审核",
      target: "ops",
      count: 3,
    });
  });

  it("maps a locked-roster warning to the Ops progress step", () => {
    const progress = buildWorkspaceProgress(
      facts({
        analytics: { ...analytics, attention: [{ code: "ROSTER_NOT_FINAL", severity: "warning" }] },
      }),
    );

    expect(progress.find((item) => item.key === "review")).toMatchObject({
      state: "attention",
      target: "ops",
    });
  });

  it("does not point to Live when the activity has no Live access", () => {
    const result = pickWorkspaceNextAction(
      facts({
        access: { studio: true, ops: true, live: false },
        analytics: { ...analytics, attention: [{ code: "COMPETITION_ROUND_NOT_LOCKED", severity: "warning", count: 1 }] },
      }),
    );

    expect(result).toBeNull();
  });

  it("uses the active release as the results fallback when there is no attention", () => {
    const result = pickWorkspaceNextAction(
      facts({
        analytics: {
          ...analytics,
          publishing: { ...analytics.publishing, resultReleases: { total: 1, byStatus: { active: 1 } } },
        },
      }),
    );

    expect(result).toMatchObject({ target: "results", label: "查看公开赛果" });
  });

  it("maps an unconfigured draft to setup without inventing a command", () => {
    const result = pickWorkspaceNextAction(
      facts({
        activity: { ...activity, status: "draft", enabledCapabilities: [] },
        analytics: null,
        access: { studio: true, ops: false, live: false },
      }),
    );

    expect(result).toMatchObject({ target: "studio", label: "继续配置活动" });
  });
});
