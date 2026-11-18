import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import type { ActivityAnalyticsResponse } from "../../api/analytics.js";
import { ActivityAnalyticsCard } from "./ActivityAnalyticsCard.js";

const analytics: ActivityAnalyticsResponse = {
  activity: { id: "activity-1", title: "春季现场", status: "active", enabledCapabilities: ["registration"] },
  registration: { total: 3, byStatus: { approved: 2, submitted: 1 } },
  materialChecks: { total: 2, byStatus: { approved: 1, missing: 1 }, requiredNotApproved: 1 },
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
  attention: [{ code: "REGISTRATION_REVIEW_PENDING", severity: "warning", count: 1 }],
};

describe("ActivityAnalyticsCard", () => {
  it("renders aggregate cards and the shared risk copy", () => {
    render(<ActivityAnalyticsCard analytics={analytics} />);

    expect(screen.getByRole("heading", { name: "准备度与活动统计" })).toBeInTheDocument();
    expect(screen.getByText("报名总数")).toBeInTheDocument();
    expect(screen.getByText("3")).toBeInTheDocument();
    expect(screen.getByText("报名待审核")).toBeInTheDocument();
    expect(screen.getByText(/审核后才能定稿名单/)).toBeInTheDocument();
  });

  it("hides pre-event items on a closed activity", () => {
    render(
      <ActivityAnalyticsCard
        analytics={{
          ...analytics,
          activity: { ...analytics.activity, status: "closed" },
          attention: [
            { code: "REGISTRATION_REVIEW_PENDING", severity: "warning", count: 1 },
            { code: "ARCHIVE_MISSING", severity: "warning" },
          ],
        }}
      />,
    );

    expect(screen.queryByText("报名待审核")).not.toBeInTheDocument();
    expect(screen.getByText("尚未归档")).toBeInTheDocument();
  });

  it("keeps an unknown attention code visible", () => {
    render(
      <ActivityAnalyticsCard
        analytics={{
          ...analytics,
          attention: [{ code: "NEW_CODE", severity: "warning" }],
        }}
      />,
    );

    expect(screen.getByText("NEW_CODE")).toBeInTheDocument();
    expect(screen.getByText(/未识别的运营注意项/)).toBeInTheDocument();
  });

  it("renders a clear empty state", () => {
    render(<ActivityAnalyticsCard analytics={{ ...analytics, attention: [] }} />);

    expect(screen.getByText("当前没有由聚合事实生成的注意项。")).toBeInTheDocument();
  });
});
