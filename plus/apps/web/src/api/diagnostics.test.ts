import { afterEach, describe, expect, it, vi } from "vitest";

import { fetchRecentEvents } from "./diagnostics.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("diagnostics API client", () => {
  it("reads the recent window by probing the head first", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ events: [], nextCursor: 100, headCursor: 100 }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ events: [], nextCursor: 100, headCursor: 100 }),
      });
    vi.stubGlobal("fetch", fetchMock);

    await fetchRecentEvents("activity-1", 20);

    expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/activities/activity-1/events?limit=1");
    expect(fetchMock.mock.calls[1]?.[0]).toBe("/api/activities/activity-1/events?after=80&limit=20");
  });
});
