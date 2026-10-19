export interface RateLimitInput {
  readonly key: string;
  readonly limit: number;
  readonly windowMs: number;
}

export interface RateLimiter {
  allow(input: RateLimitInput): Promise<boolean> | boolean;
}

interface WindowCounter {
  readonly startedAt: number;
  count: number;
}

/** Process-local fallback; a gateway/distributed limiter can implement the same contract. */
export class MemoryRateLimiter implements RateLimiter {
  private readonly counters = new Map<string, WindowCounter>();

  allow(input: RateLimitInput): boolean {
    const now = Date.now();
    const current = this.counters.get(input.key);
    if (current === undefined || now - current.startedAt >= input.windowMs) {
      this.counters.set(input.key, { startedAt: now, count: 1 });
      return true;
    }
    if (current.count >= input.limit) return false;
    current.count += 1;
    return true;
  }
}
