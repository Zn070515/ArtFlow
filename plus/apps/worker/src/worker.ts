import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import { closeDb, createDb, migrate } from "@artflow-plus/db";
import {
  assertReleaseProvenance,
  relayOutboxOnce,
  startRelayLoop,
  type RelayLoopStop,
} from "@artflow-plus/runtime";
import { PgBoss } from "pg-boss";

export const RELAY_QUEUE = "outbox-relay";
export const RELAY_DEAD_QUEUE = "outbox-relay-dead";
export const DEFAULT_RELAY_INTERVAL_MS = 250;
export const DEFAULT_SHUTDOWN_TIMEOUT_MS = 10_000;
export const DEFAULT_READY_FILE = "/tmp/artflow-worker-ready";

export interface WorkerConfig {
  readonly connectionString: string;
  readonly schema?: string;
  readonly relayIntervalMs: number;
  readonly shutdownTimeoutMs: number;
  readonly readyFile: string;
}

export interface WorkerHandle {
  readonly stop: () => Promise<void>;
}

function positiveInteger(
  raw: string | undefined,
  name: string,
  fallback: number,
  minimum: number,
): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < minimum) {
    throw new Error(`${name} must be an integer >= ${minimum}.`);
  }
  return value;
}

export function readWorkerConfig(env: NodeJS.ProcessEnv = process.env): WorkerConfig {
  const connectionString = env.ARTFLOW_PLUS_DATABASE_URL;
  if (connectionString === undefined || connectionString.trim() === "") {
    throw new Error("ARTFLOW_PLUS_DATABASE_URL is required.");
  }
  const schema = env.ARTFLOW_PLUS_DB_SCHEMA?.trim();
  return {
    connectionString,
    ...(schema === undefined || schema === "" ? {} : { schema }),
    relayIntervalMs: positiveInteger(
      env.ARTFLOW_PLUS_WORKER_RELAY_INTERVAL_MS,
      "ARTFLOW_PLUS_WORKER_RELAY_INTERVAL_MS",
      DEFAULT_RELAY_INTERVAL_MS,
      10,
    ),
    shutdownTimeoutMs: positiveInteger(
      env.ARTFLOW_PLUS_WORKER_SHUTDOWN_TIMEOUT_MS,
      "ARTFLOW_PLUS_WORKER_SHUTDOWN_TIMEOUT_MS",
      DEFAULT_SHUTDOWN_TIMEOUT_MS,
      1_000,
    ),
    readyFile: env.ARTFLOW_PLUS_WORKER_READY_FILE?.trim() || DEFAULT_READY_FILE,
  };
}

/** Retries are bounded so a broken projection cannot spin forever. */
export function relayQueueOptions(): {
  readonly retryLimit: number;
  readonly retryDelay: number;
  readonly retryBackoff: boolean;
  readonly retryDelayMax: number;
  readonly expireInSeconds: number;
  readonly retentionSeconds: number;
  readonly deleteAfterSeconds: number;
  readonly deadLetter: string;
} {
  return {
    retryLimit: 5,
    retryDelay: 10,
    retryBackoff: true,
    retryDelayMax: 300,
    expireInSeconds: 60,
    retentionSeconds: 7 * 24 * 60 * 60,
    deleteAfterSeconds: 24 * 60 * 60,
    deadLetter: RELAY_DEAD_QUEUE,
  };
}

/**
 * Bounded wait used by shutdown. Returns true when the work settled before the
 * deadline; a false result is logged and the process may be force-exited by the
 * entrypoint.
 */
export async function drainWithTimeout(work: Promise<unknown>, timeoutMs: number): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), timeoutMs);
    timer.unref?.();
  });
  const settled = work.then(
    () => true as const,
    () => true as const,
  );
  const result = await Promise.race([settled, timeout]);
  if (timer !== undefined) clearTimeout(timer);
  return result;
}

async function stopRelay(loop: RelayLoopStop, timeoutMs: number): Promise<void> {
  loop();
  const drained = await drainWithTimeout(loop.drain(), timeoutMs);
  if (!drained) {
    console.error(JSON.stringify({ event: "worker.relayDrainTimeout", timeoutMs }));
  }
}

export async function startWorker(config: WorkerConfig): Promise<WorkerHandle> {
  assertReleaseProvenance();
  const db = createDb({
    connectionString: config.connectionString,
    ...(config.schema === undefined ? {} : { schema: config.schema }),
  });
  await migrate(db);

  const boss = new PgBoss({ connectionString: config.connectionString, schema: "pgboss" });
  boss.on("error", (error) => {
    console.error(JSON.stringify({ event: "worker.pgBossError", error: String(error) }));
  });
  await boss.start();
  try {
    // The dead-letter queue has no retries of its own; it is the terminal store.
    await boss.createQueue(RELAY_DEAD_QUEUE, {
      retryLimit: 0,
      expireInSeconds: 60,
      deleteAfterSeconds: 7 * 24 * 60 * 60,
    });
    await boss.createQueue(RELAY_QUEUE, relayQueueOptions());
    await boss.updateQueue(RELAY_QUEUE, relayQueueOptions());
    // Cron is minute-granular: this is the recovery backstop, not the latency path.
    await boss.schedule(RELAY_QUEUE, "* * * * *", {});
    await boss.work(RELAY_QUEUE, { batchSize: 1 }, async () => {
      await relayOutboxOnce(db);
    });

    const stopLoop = startRelayLoop(() => relayOutboxOnce(db), {
      intervalMs: config.relayIntervalMs,
      onError: (error) => {
        console.error(JSON.stringify({ event: "worker.relayError", error: String(error) }));
      },
    });

    await mkdir(dirname(config.readyFile), { recursive: true });
    await writeFile(config.readyFile, `${process.pid}\n`, "utf8");

    let stopping: Promise<void> | null = null;
    const stop = (): Promise<void> => {
      stopping ??= (async () => {
        await rm(config.readyFile, { force: true });
        await stopRelay(stopLoop, config.shutdownTimeoutMs);
        const stopped = await drainWithTimeout(
          boss.stop({ graceful: true, timeout: Math.ceil(config.shutdownTimeoutMs / 1000) }),
          config.shutdownTimeoutMs + 1_000,
        );
        if (!stopped) {
          console.error(JSON.stringify({ event: "worker.pgBossStopTimeout" }));
        }
        const closed = await drainWithTimeout(closeDb(db), 5_000);
        if (!closed) {
          console.error(JSON.stringify({ event: "worker.dbCloseTimeout" }));
        }
      })();
      return stopping;
    };
    return { stop };
  } catch (error) {
    await boss.stop({ graceful: false }).catch(() => undefined);
    await closeDb(db).catch(() => undefined);
    throw error;
  }
}
