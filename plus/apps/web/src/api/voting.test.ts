import { afterEach, describe, expect, it, vi } from "vitest";

import { revokeResultRelease, unlockStageResult } from "./voting.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

function stubFetch(payload: unknown = {}): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => payload,
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("voting client", () => {
  it("revokes a result release by id", async () => {
    const fetchMock = stubFetch();

    await revokeResultRelease("act-1", "release-1", "撤回");

    const [path, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(path).toBe("/api/activities/act-1/publishing/releases/release-1/revoke");
    expect(init.method).toBe("POST");
    expect(new Headers(init.headers as HeadersInit).get("idempotency-key")).toEqual(
      expect.stringContaining("publish-revoke-"),
    );
    expect(JSON.parse(String(init.body))).toEqual({ scope: "publishing", note: "撤回" });
  });

  it("unlocks a confirmed stage result", async () => {
    const fetchMock = stubFetch();

    await unlockStageResult("act-1", "final", 3, "解锁");

    const [path, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(path).toBe("/api/activities/act-1/publishing/stage-results/final/unlock");
    expect(init.method).toBe("POST");
    expect(new Headers(init.headers as HeadersInit).get("idempotency-key")).toEqual(
      expect.stringContaining("publish-unlock-"),
    );
    expect(JSON.parse(String(init.body))).toEqual({
      scope: "publishing",
      expectedCandidateRevision: 3,
      note: "解锁",
    });
  });
});
