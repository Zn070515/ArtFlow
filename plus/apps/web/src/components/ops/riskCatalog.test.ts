import { describe, expect, it } from "vitest";

import {
  deriveRiskRow,
  deriveRiskSummary,
  describeRisk,
  type RiskActivity,
} from "./riskCatalog.js";

function activity(status: RiskActivity["status"], capabilities: readonly string[] = ["registration", "competition"]): RiskActivity {
  return {
    id: "act-1",
    title: "春季赛",
    publicCode: "SPRING-1",
    status,
    enabledCapabilities: capabilities,
  };
}

describe("risk catalog", () => {
  it("marks pending registration as a warning with the registration anchor", () => {
    const item = describeRisk("REGISTRATION_REVIEW_PENDING", activity("active"), 3);
    expect(item).toMatchObject({
      code: "REGISTRATION_REVIEW_PENDING",
      count: 3,
      severity: "warning",
      target: { kind: "anchor", id: "registration" },
    });
  });

  it("does not treat a non-final roster as a blocker", () => {
    const item = describeRisk("ROSTER_NOT_FINAL", activity("active"));
    expect(item?.severity).toBe("warning");
    expect(item?.target).toEqual({ kind: "anchor", id: "roster" });
  });

  it("blocks only an active stale result", () => {
    const active = describeRisk("RESULT_STALE", activity("active"));
    expect(active?.severity).toBe("critical");
    expect(active?.target).toEqual({ kind: "live" });

    const closed = describeRisk("RESULT_STALE", activity("closed"));
    expect(closed?.severity).toBe("warning");
    expect(closed?.target).toEqual({ kind: "public-results" });
    expect(closed?.actionLabel).toBe("查看赛果");
  });

  it("keeps release pending a warning", () => {
    expect(describeRisk("RESULT_RELEASE_PENDING", activity("active"))?.severity).toBe("warning");
  });

  it("shows only pre-event items on draft and only post-event items on closed", () => {
    expect(describeRisk("ROSTER_NOT_FINAL", activity("draft"))).not.toBeNull();
    expect(describeRisk("RESULT_STALE", activity("draft"))).toBeNull();
    expect(describeRisk("REGISTRATION_REVIEW_PENDING", activity("closed"))).toBeNull();
    expect(describeRisk("ARCHIVE_MISSING", activity("closed"))).not.toBeNull();
  });

  it("does not show archived activities", () => {
    expect(describeRisk("ROSTER_NOT_FINAL", activity("archived"))).toBeNull();
  });

  it("keeps an unknown code visible", () => {
    const item = describeRisk("NEW_CODE", activity("active"));
    expect(item).toMatchObject({ code: "NEW_CODE", title: "NEW_CODE", area: "other", severity: "warning" });
  });

  it("derives row statuses and summary", () => {
    const blocked = deriveRiskRow(activity("active"), [{ code: "RESULT_STALE" }]);
    const attention = deriveRiskRow(activity("active"), [{ code: "REGISTRATION_REVIEW_PENDING", count: 1 }]);
    const preparing = deriveRiskRow(activity("draft"), [{ code: "ROSTER_NOT_FINAL" }]);
    const closed = deriveRiskRow(activity("closed"), [{ code: "ARCHIVE_MISSING" }]);
    const ready = deriveRiskRow(activity("active"), []);

    expect([blocked.status, attention.status, preparing.status, closed.status, ready.status]).toEqual([
      "blocked", "attention", "preparing", "closed", "ready",
    ]);
    expect(deriveRiskSummary([blocked, attention, preparing, closed, ready])).toEqual({
      blocked: 1, attention: 1, preparing: 1, ready: 1, closed: 1,
    });
  });
});
