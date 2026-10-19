import { closeDb, createDb, migrate } from "@artflow-plus/db";

import { buildApp } from "./app.js";

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

  const app = await buildApp({ db });
  const port = Number(process.env.PORT ?? 3000);
  const host = process.env.HOST ?? "127.0.0.1";
  await app.listen({ port, host });

  const shutdown = async (): Promise<void> => {
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
