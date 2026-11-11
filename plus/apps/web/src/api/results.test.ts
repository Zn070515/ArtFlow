import { afterEach, describe, expect, it, vi } from "vitest";

import { archiveActivity, closeActivity, confirmStageResult, recomputePodium } from "./results.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("results API client", () => {
  it("posts podium confirm, release stage, close, and archive on the declared routes", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ revision: 2, candidateRevision: 3, status: "candidate" }) });
    vi.stubGlobal("fetch", fetchMock);

    await recomputePodium("activity/1", {
      scope: "publishing",
      roundIds: ["round-1"],
      expectedInputFingerprint: "fp",
    });
    await confirmStageResult("activity/1", "final_podium", {
      expectedSourceRevision: 3,
      expectedInputFingerprint: "fp",
    });
    await closeActivity("activity/1", 4);
    await archiveActivity("activity/1", 5, "赛后归档");

    const paths = fetchMock.mock.calls.map((call) => call[0]);
    expect(paths).toEqual([
      "/api/activities/activity%2F1/competition/podium/recompute",
      "/api/activities/activity%2F1/publishing/stage-results/final_podium/confirm",
      "/api/activities/activity%2F1/close",
      "/api/activities/activity%2F1/archive",
    ]);
    expect(JSON.parse(String((fetchMock.mock.calls[1]?.[1] as RequestInit).body))).toMatchObject({
      scope: "publishing",
      expectedSourceRevision: 3,
      expectedInputFingerprint: "fp",
      awards: [],
    });
    expect(JSON.parse(String((fetchMock.mock.calls[3]?.[1] as RequestInit).body))).toEqual({
      expectedRevision: 5,
      note: "赛后归档",
    });
  });
});
