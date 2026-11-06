import { describe, expect, it } from "vitest";

import {
  DEFAULT_READY_FILE,
  DEFAULT_RELAY_INTERVAL_MS,
  DEFAULT_SHUTDOWN_TIMEOUT_MS,
  RELAY_DEAD_QUEUE,
  RELAY_QUEUE,
  drainWithTimeout,
  readWorkerConfig,
  relayQueueOptions,
} from "../src/worker.js";

const baseEnv = {
  ARTFLOW_PLUS_DATABASE_URL: "postgresql://user:pass@127.0.0.1:5433/artflow_plus",
};

describe("worker configuration", () => {
  it("requires a database URL", () => {
    expect(() => readWorkerConfig({})).toThrow(/ARTFLOW_PLUS_DATABASE_URL/);
    expect(() => readWorkerConfig({ ARTFLOW_PLUS_DATABASE_URL: "  " })).toThrow(
      /ARTFLOW_PLUS_DATABASE_URL/,
    );
  });

  it("uses bounded defaults", () => {
    expect(readWorkerConfig(baseEnv)).toEqual({
      connectionString: baseEnv.ARTFLOW_PLUS_DATABASE_URL,
      relayIntervalMs: DEFAULT_RELAY_INTERVAL_MS,
      shutdownTimeoutMs: DEFAULT_SHUTDOWN_TIMEOUT_MS,
      readyFile: DEFAULT_READY_FILE,
    });
  });

  it("parses explicit settings and rejects unsafe values", () => {
    expect(
      readWorkerConfig({
        ...baseEnv,
        ARTFLOW_PLUS_DB_SCHEMA: "tenant_a",
        ARTFLOW_PLUS_WORKER_RELAY_INTERVAL_MS: "500",
        ARTFLOW_PLUS_WORKER_SHUTDOWN_TIMEOUT_MS: "30000",
        ARTFLOW_PLUS_WORKER_READY_FILE: "/tmp/custom-ready",
      }),
    ).toEqual({
      connectionString: baseEnv.ARTFLOW_PLUS_DATABASE_URL,
      schema: "tenant_a",
      relayIntervalMs: 500,
      shutdownTimeoutMs: 30_000,
      readyFile: "/tmp/custom-ready",
    });
    expect(() =>
      readWorkerConfig({ ...baseEnv, ARTFLOW_PLUS_WORKER_RELAY_INTERVAL_MS: "0" }),
    ).toThrow(/RELAY_INTERVAL_MS/);
    expect(() =>
      readWorkerConfig({ ...baseEnv, ARTFLOW_PLUS_WORKER_SHUTDOWN_TIMEOUT_MS: "10.5" }),
    ).toThrow(/SHUTDOWN_TIMEOUT_MS/);
  });
});

describe("worker queue policy", () => {
  it("has bounded retries and a dead-letter queue", () => {
    expect(relayQueueOptions()).toMatchObject({
      retryLimit: 5,
      retryBackoff: true,
      retryDelayMax: 300,
      expireInSeconds: 60,
      deadLetter: RELAY_DEAD_QUEUE,
    });
    expect(RELAY_QUEUE).toBe("outbox-relay");
    expect(RELAY_DEAD_QUEUE).not.toBe(RELAY_QUEUE);
  });
});

describe("drainWithTimeout", () => {
  it("returns true when the work settles", async () => {
    await expect(drainWithTimeout(Promise.resolve("ok"), 100)).resolves.toBe(true);
    await expect(drainWithTimeout(Promise.reject(new Error("boom")), 100)).resolves.toBe(true);
  });

  it("returns false when the work outlives the deadline", async () => {
    const never = new Promise<void>(() => undefined);
    await expect(drainWithTimeout(never, 10)).resolves.toBe(false);
  });
});
