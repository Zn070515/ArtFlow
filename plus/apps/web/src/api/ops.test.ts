import { afterEach, describe, expect, it, vi } from "vitest";

import { fetchOpsActivities } from "./ops.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("ops activity client", () => {
  it("deduplicates repeated activity projections by id", async () => {
    const activity = {
      id: "act-1",
      publicCode: "ACT-1",
      title: "测试活动",
      status: "active",
      revision: 1,
      enabledCapabilities: ["registration"],
    };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ activities: [activity, { ...activity }] }),
    }));

    await expect(fetchOpsActivities()).resolves.toEqual([activity]);
  });
});
