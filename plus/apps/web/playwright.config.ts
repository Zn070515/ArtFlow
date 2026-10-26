import { defineConfig, devices } from "@playwright/test";

const databaseUrl = process.env.ARTFLOW_PLUS_DATABASE_URL;
if (databaseUrl === undefined || databaseUrl.trim() === "") {
  throw new Error("Set ARTFLOW_PLUS_DATABASE_URL before running the web E2E suite.");
}

const apiPort = 3100;
const webPort = 4173;
const apiUrl = `http://127.0.0.1:${apiPort}`;
const webUrl = `http://127.0.0.1:${webPort}`;
const channel = process.env.PLAYWRIGHT_CHANNEL as "msedge" | "chrome" | undefined;

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  forbidOnly: process.env.CI === "true",
  retries: process.env.CI === "true" ? 2 : 0,
  reporter: process.env.CI === "true" ? "github" : "list",
  use: {
    baseURL: webUrl,
    trace: "on-first-retry",
  },
  projects: [{
    name: "chromium",
    use: { ...devices["Desktop Chrome"], ...(channel === undefined ? {} : { channel }) },
  }],
  webServer: [
    {
      command: "pnpm --filter @artflow-plus/api seed:e2e && pnpm --filter @artflow-plus/api start",
      url: `${apiUrl}/healthz`,
      timeout: 120_000,
      reuseExistingServer: false,
      env: {
        ARTFLOW_PLUS_DATABASE_URL: databaseUrl,
        ARTFLOW_PLUS_DB_SCHEMA: "artflow_e2e",
        PORT: String(apiPort),
        HOST: "127.0.0.1",
      },
    },
    {
      command: `pnpm --filter @artflow-plus/web exec vite --host 127.0.0.1 --port ${webPort} --strictPort`,
      url: webUrl,
      timeout: 120_000,
      reuseExistingServer: false,
      env: {
        VITE_API_TARGET: apiUrl,
      },
    },
  ],
});
