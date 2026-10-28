import type { ActivityAnalyticsFacts } from "@artflow-plus/db";
import type { Activity } from "@artflow-plus/domain";
import { describe, expect, it } from "vitest";

import { buildActivityAnalyticsView } from "../src/analytics-service.js";

const activity: Activity = {
  id: "activity-1",
  title: "春季现场",
  status: "closed",
  revision: 2,
  enabledCapabilities: ["registration", "materials", "competition", "voting", "publishing", "archive"],
  activeDefinitionVersion: 1,
};

const facts: ActivityAnalyticsFacts = {
  registration: { total: 4, byStatus: { approved: 2, need_supplement: 1, submitted: 1 } },
  materialChecks: {
    total: 4,
    byStatus: { approved: 2, missing: 1, needs_supplement: 1 },
    requiredNotApproved: 1,
  },
  roster: { status: "unknown", approvedCount: null, revision: 1 },
  competition: {
    rounds: { total: 2, byState: { locked: 1, scoring: 1 }, locked: 1 },
    performances: { total: 2, byState: { locked: 1, open: 1 }, locked: 1 },
    scoreFacts: { total: 4, current: 2 },
  },
  voting: { sessions: { total: 1, byStatus: { open: 1 } }, validBallots: 3 },
  publishing: {
    stageResults: {
      total: 1,
      byStatus: { confirmed: 1 },
      stale: 1,
      confirmedWithoutActiveRelease: 1,
    },
    resultReleases: { total: 0, byStatus: {} },
  },
  archive: { totalPackages: 0, currentPackages: 0 },
};

describe("activity analytics attention", () => {
  it("derives deterministic attention codes without changing authority", () => {
    const view = buildActivityAnalyticsView(activity, facts);

    expect(view.activity).toEqual({
      id: "activity-1",
      title: "春季现场",
      status: "closed",
      enabledCapabilities: ["registration", "materials", "competition", "voting", "publishing", "archive"],
    });
    expect(view.attention).toEqual([
      { code: "REGISTRATION_REVIEW_PENDING", severity: "warning", count: 2 },
      { code: "REQUIRED_MATERIALS_PENDING", severity: "warning", count: 1 },
      { code: "ROSTER_NOT_FINAL", severity: "warning" },
      { code: "FORMAL_VOTE_OPEN", severity: "warning", count: 1 },
      { code: "COMPETITION_ROUND_NOT_LOCKED", severity: "warning", count: 1 },
      { code: "RESULT_STALE", severity: "warning", count: 1 },
      { code: "RESULT_RELEASE_PENDING", severity: "warning", count: 1 },
      { code: "ARCHIVE_MISSING", severity: "warning" },
    ]);
  });

  it("does not invent attention for disabled capabilities or draft archival", () => {
    const view = buildActivityAnalyticsView(
      { ...activity, status: "draft", enabledCapabilities: [] },
      {
        ...facts,
        registration: { total: 2, byStatus: { submitted: 2 } },
        materialChecks: { total: 1, byStatus: { missing: 1 }, requiredNotApproved: 1 },
        voting: { sessions: { total: 1, byStatus: { open: 1 } }, validBallots: 1 },
      },
    );

    expect(view.attention).toEqual([]);
  });
});
