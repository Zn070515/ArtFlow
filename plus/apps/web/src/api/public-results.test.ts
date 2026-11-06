import { afterEach, describe, expect, it, vi } from "vitest";

import { fetchPublicResults, PublicResultsNotFound } from "./public-results.js";

const payload = {
  activity: { publicCode: "ABC123" },
  activityTitle: "2026 院十佳",
  results: [],
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("fetchPublicResults", () => {
  it("returns the selector payload", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => payload,
    }));
    await expect(fetchPublicResults("ABC123")).resolves.toEqual(payload);
  });

  it("maps 404 to PublicResultsNotFound", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: false,
      status: 404,
      json: async () => ({ code: "NOT_FOUND" }),
    }));
    await expect(fetchPublicResults("NOPE")).rejects.toBeInstanceOf(PublicResultsNotFound);
  });

  it("throws a retryable error for server failures", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      json: async () => ({}),
    }));
    await expect(fetchPublicResults("ABC123")).rejects.toThrow("500");
  });
});
