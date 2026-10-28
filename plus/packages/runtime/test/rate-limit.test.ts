import { closeDb, createDb, migrate } from "@artflow-plus/db";
import type { Database } from "@artflow-plus/db";
import { Client } from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { Kysely } from "kysely";

import { MemoryRateLimiter, PostgresRateLimiter } from "../src/rate-limit.js";

const connectionString = process.env.ARTFLOW_PLUS_DATABASE_URL;
if (process.env.REQUIRE_DB === "1" && connectionString === undefined) {
  throw new Error("REQUIRE_DB=1 but ARTFLOW_PLUS_DATABASE_URL is unset.");
}
const schema = `artflow_runtime_rate_limit_${Date.now()}_${process.pid}`;
let db: Kysely<Database>;
let dbA: Kysely<Database>;
let dbB: Kysely<Database>;
let admin: Client;

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

describe.skipIf(!connectionString)("PostgresRateLimiter", () => {
  beforeAll(async () => {
    if (!connectionString) return;
    admin = new Client({ connectionString });
    await admin.connect();
    await admin.query(`CREATE SCHEMA "${schema}"`);
    db = createDb({ connectionString, schema });
    dbA = createDb({ connectionString, schema });
    dbB = createDb({ connectionString, schema });
    await migrate(db);
  });

  afterAll(async () => {
    if (!connectionString) return;
    await closeDb(dbA);
    await closeDb(dbB);
    await closeDb(db);
    await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
    await admin.end();
  });

  it("shares an atomic bucket across two database connections", async () => {
    const first = new PostgresRateLimiter(dbA);
    const second = new PostgresRateLimiter(dbB);
    const results = await Promise.all(
      Array.from({ length: 20 }, (_, index) => (index % 2 === 0 ? first : second).allow({
        key: "shared-rate-limit-test",
        limit: 3,
        windowMs: 60_000,
      })),
    );
    expect(results.filter(Boolean)).toHaveLength(3);
  });
});
