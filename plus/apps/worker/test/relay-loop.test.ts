import { afterEach, expect, it, vi } from "vitest";

import { startRelayLoop } from "@artflow-plus/runtime";

afterEach(() => {
  vi.useRealTimers();
});

it("runs the relay on every interval and stops cleanly", async () => {
  vi.useFakeTimers();
  let calls = 0;
  const stop = startRelayLoop(
    async () => {
      calls += 1;
    },
    { intervalMs: 100 },
  );
  await vi.advanceTimersByTimeAsync(350);
  expect(calls).toBe(3);
  stop();
  await vi.advanceTimersByTimeAsync(300);
  expect(calls).toBe(3);
});

it("never overlaps a slow relay pass", async () => {
  vi.useFakeTimers();
  let calls = 0;
  let release: (() => void) | undefined;
  const stop = startRelayLoop(
    () =>
      new Promise<void>((resolve) => {
        calls += 1;
        release = resolve;
      }),
    { intervalMs: 100 },
  );
  await vi.advanceTimersByTimeAsync(350);
  expect(calls).toBe(1);
  release?.();
  await vi.advanceTimersByTimeAsync(100);
  expect(calls).toBe(2);
  stop();
});

it("reports relay failures without stopping the loop", async () => {
  vi.useFakeTimers();
  const errors: unknown[] = [];
  let calls = 0;
  const stop = startRelayLoop(
    async () => {
      calls += 1;
      throw new Error("database unavailable");
    },
    { intervalMs: 100, onError: (error) => errors.push(error) },
  );
  await vi.advanceTimersByTimeAsync(250);
  expect(calls).toBe(2);
  expect(errors).toHaveLength(2);
  stop();
});
