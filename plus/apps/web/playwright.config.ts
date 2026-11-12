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
const isCi = process.env.CI === "true";

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  workers: 1,
  // The shared runner is slower than a local machine: a full 13-test pass has
  // measured ~11 minutes, so a 60s/5s budget times out correct UI waits. Keep
  // local budgets tight and give CI room; one retry stays inside the 20m job.
  timeout: isCi ? 120_000 : 60_000,
  forbidOnly: isCi,
  retries: isCi ? 1 : 0,
  reporter: isCi ? "github" : "list",
  expect: { timeout: isCi ? 15_000 : 5_000 },
  // Visual baselines are maintained as one platform-neutral image; the token
  // sheet uses bundled fonts, so the layout is stable across Chromium hosts.
  snapshotPathTemplate: "{testDir}/{testFilePath}-snapshots/{arg}{ext}",
  use: {
    baseURL: webUrl,
    // The suite only talks to 127.0.0.1. On developer machines with a system
    // proxy (including one that intercepts loopback), Chromium otherwise sends
    // these requests through it and loads hang or return 502.
    launchOptions: { args: ["--no-proxy-server"] },
    trace: "on-first-retry",
    // Business journeys must not depend on a WebGL renderer. The Aurora scene
    // falls back to a static backdrop under reduced motion; visual coverage of
    // the shader belongs in its own smoke test, not in authority E2E.
    reducedMotion: "reduce",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"], ...(channel === undefined ? {} : { channel }) },
      testIgnore: ["**/mobile.spec.ts"],
    },
    {
      name: "mobile",
      // CI installs Chromium only; the device descriptor otherwise defaults to
      // WebKit. Keep the iPhone viewport and touch emulation on Chromium.
      use: { ...devices["iPhone 13"], browserName: "chromium", ...(channel === undefined ? {} : { channel }) },
      testMatch: ["**/mobile.spec.ts"],
    },
  ],
  webServer: [
    {
      command: "pnpm --filter @artflow-plus/api seed:e2e && pnpm --filter @artflow-plus/api start",
      url: `${apiUrl}/healthz`,
      timeout: 120_000,
      reuseExistingServer: false,
      env: {
        ARTFLOW_PLUS_DATABASE_URL: databaseUrl,
        ARTFLOW_PLUS_DB_SCHEMA: "artflow_e2e",
        ARTFLOW_PLUS_INLINE_RELAY: "1",
        // The suite logs in as the same organizer from 127.0.0.1; the default
        // per-IP budget would rate-limit the last specs in a fast local run.
        ARTFLOW_PLUS_AUTH_PUBLIC_LIMIT: "200",
        ARTFLOW_PLUS_AUTH_USER_LIMIT: "200",
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
