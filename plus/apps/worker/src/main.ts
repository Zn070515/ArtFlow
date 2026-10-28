import { closeDb, createDb, migrate } from "@artflow-plus/db";
import { assertReleaseProvenance, relayOutboxOnce, startRelayLoop } from "@artflow-plus/runtime";
import { PgBoss } from "pg-boss";

const RELAY_QUEUE = "outbox-relay";

async function main(): Promise<void> {
  const connectionString = process.env.ARTFLOW_PLUS_DATABASE_URL;
  if (connectionString === undefined || connectionString.trim() === "") {
    throw new Error("ARTFLOW_PLUS_DATABASE_URL is required.");
  }
  const schema = process.env.ARTFLOW_PLUS_DB_SCHEMA;

  const db = createDb({
    connectionString,
    ...(schema === undefined || schema === "" ? {} : { schema }),
  });
  await migrate(db);
  assertReleaseProvenance();

  const boss = new PgBoss({ connectionString, schema: "pgboss" });
  boss.on("error", (error) => {
    console.error("pg-boss:", error);
  });
  await boss.start();
  await boss.createQueue(RELAY_QUEUE);
  // Cron is minute-granular: this is the recovery backstop, not the latency path.
  await boss.schedule(RELAY_QUEUE, "* * * * *", {});
  await boss.work(RELAY_QUEUE, async () => {
    await relayOutboxOnce(db);
  });

  const stopLoop = startRelayLoop(() => relayOutboxOnce(db), {
    intervalMs: 250,
    onError: (error) => {
      console.error("outbox relay:", error);
    },
  });

  let stopping = false;
  const shutdown = async (): Promise<void> => {
    if (stopping) return;
    stopping = true;
    stopLoop();
    await boss.stop();
    await closeDb(db);
  };
  process.once("SIGINT", () => {
    void shutdown().then(() => process.exit(0));
  });
  process.once("SIGTERM", () => {
    void shutdown().then(() => process.exit(0));
  });

  console.log("ArtFlow-Plus worker started.");
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
