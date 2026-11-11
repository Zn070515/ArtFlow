import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    testTimeout: 20_000,
    // Contract tests create and drop disposable schemas. Kysely's migrator
    // introspects every schema, so parallel files can race a DROP SCHEMA.
    fileParallelism: false,
  },
});
