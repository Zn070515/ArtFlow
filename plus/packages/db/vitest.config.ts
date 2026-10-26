import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    testTimeout: 20_000,
    // Every file creates and drops its own schema. Kysely's migrator introspects
    // all schemas, so a concurrent DROP SCHEMA from another file can make that
    // introspection fail with "schema does not exist".
    fileParallelism: false,
  },
});
