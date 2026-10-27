/**
 * Low-latency relay loop. pg-boss is the recovery/backstop scheduler because
 * cron granularity is one minute; this loop keeps live projections fresh.
 * The relay itself is idempotent and safe to run from both paths.
 */
export function startRelayLoop(
  relay: () => Promise<unknown>,
  options: {
    readonly intervalMs?: number;
    readonly onError?: (error: unknown) => void;
  } = {},
): () => void {
  const intervalMs = Math.max(options.intervalMs ?? 250, 10);
  let running = false;

  const tick = (): void => {
    if (running) return;
    running = true;
    void relay()
      .catch((error: unknown) => {
        options.onError?.(error);
      })
      .finally(() => {
        running = false;
      });
  };

  const timer = setInterval(tick, intervalMs);
  timer.unref?.();
  return () => {
    clearInterval(timer);
  };
}
