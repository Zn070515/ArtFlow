import { closeDb, createDb, migrate } from "@artflow-plus/db";
import { assertReleaseProvenance, PostgresRateLimiter, relayOutboxOnce, startRelayLoop } from "@artflow-plus/runtime";

import { buildApp } from "./app.js";

async function main(): Promise<void> {
  const connectionString = process.env.ARTFLOW_PLUS_DATABASE_URL;
  if (connectionString === undefined || connectionString.trim() === "") {
    throw new Error("ARTFLOW_PLUS_DATABASE_URL is required.");
  }
  assertReleaseProvenance();
  const schema = process.env.ARTFLOW_PLUS_DB_SCHEMA;
  const schemaOption = schema === undefined || schema === "" ? {} : { schema };
  // Migrations get their own short-lived pool without interactive query
  // timeouts: a legitimate index build must not be cancelled by the guard that
  // protects request traffic.
  const migrationDb = createDb({
    connectionString,
    ...schemaOption,
    max: 1,
    statementTimeoutMs: 0,
    lockTimeoutMs: 0,
  });
  try {
    await migrate(migrationDb);
  } finally {
    await closeDb(migrationDb);
  }
  const db = createDb({ connectionString, ...schemaOption });

  const isProduction = process.env.NODE_ENV === "production" || process.env.APP_ENV === "production";
  const app = await buildApp({
    db,
    logger: {
      level: process.env.ARTFLOW_PLUS_LOG_LEVEL ?? "info",
    },
    ...(isProduction ? { rateLimiter: new PostgresRateLimiter(db) } : {}),
  });
  const port = Number(process.env.PORT ?? 3000);
  const host = process.env.HOST ?? "127.0.0.1";
  await app.listen({ port, host });

  // Single-process deployments and the E2E suite need the live projection to move
  // without a separate worker. Production keeps this off and runs apps/worker.
  const inlineRelay = process.env.ARTFLOW_PLUS_INLINE_RELAY === "1"
    ? startRelayLoop(() => relayOutboxOnce(db), {
        intervalMs: 250,
        onError: (error) => console.error("inline outbox relay:", error),
      })
    : null;

  const shutdown = async (): Promise<void> => {
    inlineRelay?.();
    await app.close();
    await closeDb(db);
  };
  process.once("SIGINT", () => {
    void shutdown().then(() => process.exit(0));
  });
  process.once("SIGTERM", () => {
    void shutdown().then(() => process.exit(0));
  });
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
