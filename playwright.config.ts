import { defineConfig, devices } from "@playwright/test";

// The phone widths this audience actually uses. Each is its own project so the VS Code
// Test Explorer lists them separately and any single width can be run or debugged on its
// own. Layout is decided by the CSS viewport width, not the pixel density, so seven
// widths span the range from an original iPhone SE to a Pro Max without pretending to
// simulate every handset on the market.
const PHONE_PROJECTS = [
  { name: "phone-320-se", device: devices["iPhone SE"] },
  { name: "phone-360-android", device: devices["Galaxy S24"] },
  { name: "phone-375-iphone8", device: devices["iPhone 8"] },
  { name: "phone-390-iphone14", device: devices["iPhone 14"] },
  { name: "phone-393-iphone15", device: devices["iPhone 15"] },
  { name: "phone-412-pixel7", device: devices["Pixel 7"] },
  { name: "phone-430-promax", device: devices["iPhone 15 Pro Max"] },
];

export default defineConfig({
  testDir: "tests/e2e",
  outputDir: "test-results/playwright",
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  reporter: "list",
  use: {
    baseURL: process.env.PLAYWRIGHT_BASE_URL ?? "http://127.0.0.1:8000",
    // Keep bearer tokens out of artifacts by default; opt in only for non-sensitive tests.
    trace: "off",
  },
  projects: [
    {
      name: "chromium",
      testIgnore: /mobile-(?:layout|touch)\.spec\.ts/,
      use: { ...devices["Desktop Chrome"] },
    },
    {
      name: "mobile-chromium",
      testMatch: /(?:auth-entry|ticket-boundary)\.spec\.ts/,
      use: { ...devices["Pixel 5"] },
    },
    ...PHONE_PROJECTS.map(({ name, device }) => ({
      name,
      testMatch: /mobile-(?:layout|touch)\.spec\.ts/,
      use: { ...device },
    })),
  ],
});
