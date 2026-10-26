import { afterEach, describe, expect, it, vi } from "vitest";

import { claimJudgeSeat, submitJudgeScore } from "./judge.js";
import { judgeEntryUrl } from "./live.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("judge client", () => {
  it("claims a seat with the capability instead of the raw token in the URL", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ activityId: "act-1", seatId: "seat-1", seatKey: "seat-1", sessionId: "s-1", expiresAt: "2099-01-01T00:00:00Z" }),
    });
    vi.stubGlobal("fetch", fetchMock);

    await claimJudgeSeat("ABC123", "AF1.J.1.token");

    const [path, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(path).toBe("/api/judge-entry/claim");
    expect(init.method).toBe("POST");
    expect(new Headers(init.headers as HeadersInit).get("idempotency-key")).toEqual(expect.any(String));
    expect(JSON.parse(String(init.body))).toEqual({ publicCode: "ABC123", capability: "AF1.J.1.token" });
  });

  it("submits a direct judge score for the resolved performance window", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 201,
      json: async () => ({ total: "91.00" }),
    });
    vi.stubGlobal("fetch", fetchMock);

    await submitJudgeScore({
      activityId: "act-1",
      roundKey: "round-1",
      performanceId: "performance-1",
      panelSnapshotId: "panel-1",
      seatId: "seat-1",
      contextVersion: 2,
      criteria: { 演唱技巧: 90, 舞台表现: 92, 情感表达: 91 },
      notes: "稳定",
      scope: "judging",
    });

    const [path, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(path).toBe("/api/activities/act-1/competition/rounds/round-1/scores");
    expect(JSON.parse(String(init.body))).toMatchObject({
      scope: "judging",
      source: "direct_judge",
      performanceId: "performance-1",
      panelSnapshotId: "panel-1",
      seatId: "seat-1",
      contextVersion: 2,
      notes: "稳定",
    });
  });

  it("builds the judge entry URL with an encoded capability", () => {
    expect(judgeEntryUrl("ABC 123", "AF1.J.1.a+b/c")).toBe(
      "http://localhost:3000/judge/ABC%20123?capability=AF1.J.1.a%2Bb%2Fc",
    );
  });
});
