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
  readonly windowMs: number;
  count: number;
}

/** Process-local fallback; a gateway/distributed limiter can implement the same contract. */
export class MemoryRateLimiter implements RateLimiter {
  private readonly counters = new Map<string, WindowCounter>();
  private calls = 0;

  allow(input: RateLimitInput): boolean {
    const now = Date.now();
    this.calls += 1;
    // Keys include attacker-controlled values (usernames, public codes, IPs); without
    // a sweep the map would grow for the lifetime of the process.
    if (this.counters.size > 1_024 && this.calls % 256 === 0) this.sweep(now);
    const current = this.counters.get(input.key);
    if (current === undefined || now - current.startedAt >= input.windowMs) {
      this.counters.set(input.key, { startedAt: now, windowMs: input.windowMs, count: 1 });
      return true;
    }
    if (current.count >= input.limit) return false;
    current.count += 1;
    return true;
  }

  sweep(now = Date.now()): void {
    for (const [key, counter] of this.counters) {
      if (now - counter.startedAt >= counter.windowMs) this.counters.delete(key);
    }
  }

  get size(): number {
    return this.counters.size;
  }
}
