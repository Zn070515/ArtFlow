import { afterEach, describe, expect, it, vi } from "vitest";

import { MemoryRateLimiter } from "../src/rate-limit.js";

afterEach(() => {
  vi.useRealTimers();
});

describe("MemoryRateLimiter", () => {
  it("sweeps expired windows instead of retaining every key forever", () => {
    vi.useFakeTimers();
    const limiter = new MemoryRateLimiter();
    for (let index = 0; index < 2_000; index += 1) {
      expect(limiter.allow({ key: `rotating-${index}`, limit: 1, windowMs: 1_000 })).toBe(true);
    }
    expect(limiter.size).toBe(2_000);
    vi.setSystemTime(Date.now() + 5_000);
    limiter.sweep();
    expect(limiter.size).toBe(0);
  });

  it("keeps live counters during a sweep", () => {
    vi.useFakeTimers();
    const limiter = new MemoryRateLimiter();
    limiter.allow({ key: "live", limit: 2, windowMs: 10_000 });
    limiter.sweep();
    expect(limiter.size).toBe(1);
    expect(limiter.allow({ key: "live", limit: 2, windowMs: 10_000 })).toBe(true);
    expect(limiter.allow({ key: "live", limit: 2, windowMs: 10_000 })).toBe(false);
  });
});
