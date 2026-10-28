import type { Database } from "@artflow-plus/db";
import { sql } from "kysely";
import type { Kysely } from "kysely";

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

/** PostgreSQL-backed fixed-window limiter for multi-process deployments. */
export class PostgresRateLimiter implements RateLimiter {
  private calls = 0;

  constructor(private readonly db: Kysely<Database>) {}

  async allow(input: RateLimitInput): Promise<boolean> {
    if (!Number.isSafeInteger(input.limit) || input.limit < 1) return false;
    if (!Number.isSafeInteger(input.windowMs) || input.windowMs < 1) return false;

    const nowMs = Date.now();
    const windowStartMs = Math.floor(nowMs / input.windowMs) * input.windowMs;
    const windowStartedAt = new Date(windowStartMs);
    const expiresAt = new Date(windowStartMs + input.windowMs);
    this.calls += 1;
    if (this.calls % 256 === 0) {
      await this.db
        .deleteFrom("rate_limit_bucket")
        .where("expires_at", "<=", new Date(nowMs))
        .execute();
    }

    const row = await this.db
      .insertInto("rate_limit_bucket")
      .values({
        key: input.key,
        window_started_at: windowStartedAt,
        window_ms: input.windowMs,
        count: 1,
        expires_at: expiresAt,
      })
      .onConflict((conflict) => conflict
        .columns(["key", "window_started_at"])
        .doUpdateSet({ count: sql<number>`rate_limit_bucket.count + 1` })
        .where("rate_limit_bucket.count", "<", input.limit))
      .returning("count")
      .executeTakeFirst();
    return row !== undefined;
  }
}
