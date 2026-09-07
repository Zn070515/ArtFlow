import { expect, test } from "@playwright/test";

test("the running web service exposes a healthy browser-reachable endpoint", async ({ page }) => {
  const response = await page.goto("/healthz/");

  expect(response).not.toBeNull();
  expect(response?.status()).toBe(200);
  await expect(page.locator("body")).toHaveText('{"status": "ok"}');
});
