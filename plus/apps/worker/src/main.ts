import { readWorkerConfig, startWorker } from "./worker.js";

async function main(): Promise<void> {
  const config = readWorkerConfig();
  const handle = await startWorker(config);
  let stopping = false;

  const shutdown = (reason: string): void => {
    if (stopping) return;
    stopping = true;
    console.log(JSON.stringify({ event: "worker.stopping", reason }));
    void handle
      .stop()
      .then(() => {
        console.log(JSON.stringify({ event: "worker.stopped" }));
        process.exit(0);
      })
      .catch((error: unknown) => {
        console.error(JSON.stringify({ event: "worker.stopFailed", error: String(error) }));
        process.exit(1);
      });
  };

  process.once("SIGINT", () => shutdown("SIGINT"));
  process.once("SIGTERM", () => shutdown("SIGTERM"));

  const fatal = (event: string) => (error: unknown): void => {
    console.error(JSON.stringify({ event, error: String(error) }));
    shutdown(event);
  };
  process.on("unhandledRejection", fatal("worker.unhandledRejection"));
  process.on("uncaughtException", fatal("worker.uncaughtException"));

  console.log(
    JSON.stringify({
      event: "worker.started",
      relayIntervalMs: config.relayIntervalMs,
      shutdownTimeoutMs: config.shutdownTimeoutMs,
    }),
  );
}

void main().catch((error: unknown) => {
  console.error(JSON.stringify({ event: "worker.startFailed", error: String(error) }));
  process.exit(1);
});
