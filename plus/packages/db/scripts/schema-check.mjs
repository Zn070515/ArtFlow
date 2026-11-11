import { spawnSync } from "node:child_process";

if (!process.env.ARTFLOW_PLUS_DATABASE_URL) {
  console.error("schema:check requires ARTFLOW_PLUS_DATABASE_URL (PostgreSQL).");
  process.exit(1);
}

const result = spawnSync(
  "pnpm",
  ["exec", "vitest", "run", "test/schema-drift.test.ts", "test/schema-generation.test.ts"],
  {
    stdio: "inherit",
    env: { ...process.env, REQUIRE_DB: "1" },
    shell: process.platform === "win32",
  },
);
process.exit(result.status ?? 1);
