/**
 * Low-latency relay loop. pg-boss is the recovery/backstop scheduler because
 * cron granularity is one minute; this loop keeps live projections fresh.
 * The relay itself is idempotent and safe to run from both paths.
 */
export interface RelayLoopStop {
  /** Stop scheduling new passes. */
  (): void;
  /** Resolve once the pass that was already running (if any) finishes. */
  drain(): Promise<void>;
}

export function startRelayLoop(
  relay: () => Promise<unknown>,
  options: {
    readonly intervalMs?: number;
    readonly onError?: (error: unknown) => void;
  } = {},
): RelayLoopStop {
  const intervalMs = Math.max(options.intervalMs ?? 250, 10);
  let running = false;
  let stopped = false;
  let inFlight: Promise<void> | null = null;

  const tick = (): void => {
    if (running || stopped) return;
    running = true;
    inFlight = relay()
      .then(
        () => undefined,
        (error: unknown) => {
          options.onError?.(error);
        },
      )
      .finally(() => {
        running = false;
        inFlight = null;
      });
  };

  const timer = setInterval(tick, intervalMs);
  timer.unref?.();

  const stop = (() => {
    stopped = true;
    clearInterval(timer);
  }) as RelayLoopStop;
  stop.drain = async (): Promise<void> => {
    await inFlight;
  };
  return stop;
}
