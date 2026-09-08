import { expect, test } from "@playwright/test";

test("ticket scan is a read-only entry page", async ({ page }) => {
  const response = await page.goto("/tickets/scan/");

  expect(response).not.toBeNull();
  expect(response?.status()).toBe(200);
  await expect(page).toHaveTitle(/票据扫码/);
  expect(page.url()).not.toContain("#");
  await expect(page.locator("body")).not.toContainText("secret_digest");
});

test("ticket redeem is body-only and returns a generic bounded failure", async ({ request }) => {
  const rawCredential = "e2e-ticket-secret";
  const queryAttempt = await request.get(`/tickets/redeem/?secret=${rawCredential}`);
  expect(queryAttempt.status()).toBe(405);
  expect(await queryAttempt.text()).not.toContain(rawCredential);

  const invalid = await request.post("/tickets/redeem/", {
    data: { secret: rawCredential },
  });
  expect(invalid.status()).toBe(400);
  expect(invalid.headers()["cache-control"]).toContain("no-store");
  expect(await invalid.text()).not.toContain(rawCredential);
});
