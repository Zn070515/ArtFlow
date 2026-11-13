import { afterEach, describe, expect, it, vi } from "vitest";

import { createGroupingStage } from "./grouping.js";

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

describe("grouping client", () => {
  it("posts the source round for an advancement-sourced stage", async () => {
    const fetchMock = stubFetch();

    await createGroupingStage("act-1", "command-1", {
      stageKey: "chorus",
      name: "分组合唱",
      rosterSource: "round_advanced",
      sourceRoundId: "final",
    });

    const [path, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(path).toBe("/api/activities/act-1/grouping/stages");
    expect(init.method).toBe("POST");
    expect(new Headers(init.headers as HeadersInit).get("idempotency-key")).toBe("command-1");
    expect(JSON.parse(String(init.body))).toEqual({
      stageKey: "chorus",
      name: "分组合唱",
      rosterSource: "round_advanced",
      sourceRoundId: "final",
    });
  });

  it("omits the source round for an all-approved stage", async () => {
    const fetchMock = stubFetch();

    await createGroupingStage("act-1", "command-2", {
      stageKey: "chorus",
      name: "分组合唱",
      rosterSource: "all_approved",
    });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toEqual({
      stageKey: "chorus",
      name: "分组合唱",
      rosterSource: "all_approved",
    });
  });
});
