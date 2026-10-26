import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    testTimeout: 20_000,
    // DB-backed files create and drop their own schemas. Kysely's migrator
    // introspects every schema, so a concurrent DROP SCHEMA from a parallel file
    // can make that introspection fail with "schema does not exist".
    fileParallelism: false,
  },
});
