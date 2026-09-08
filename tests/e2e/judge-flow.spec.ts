import { expect, test } from "@playwright/test";

test("judge terminal never exposes a credential without a QR fragment", async ({ page }) => {
  const response = await page.goto("/judge/terminal/");

  expect(response?.status()).toBe(200);
  await expect(page.locator("[data-status]")).toHaveText(/二维码/);
  await expect(page.locator("[data-round]")).toBeVisible();
  await expect(page.locator("[data-performance-label]")).toBeVisible();
  await expect(page.locator("[data-singer]")).toBeVisible();
  await expect(page.locator("[data-song]")).toBeVisible();
  await expect(page.locator("[data-performance-state]")).toBeVisible();
  await expect(page.locator("[data-submit]")).toBeDisabled();
  expect(await page.content()).not.toContain("session_token");
  expect(page.url()).not.toContain("#");
});

test("judge context rejects an unauthenticated browser request generically", async ({ request }) => {
  const response = await request.get("/judge/context/");

  expect(response.status()).toBe(401);
  expect(await response.json()).toEqual({
    detail: "评委请求未被接受。",
    reason_code: "INVALID_JUDGE_SESSION",
  });
  expect(response.headers()["cache-control"]).toContain("no-store");
});

test("judge score rejects cross-origin bearer attempts without echoing the credential", async ({ request }) => {
  const rawCredential = "judge-browser-secret";
  const response = await request.post("/judge/score/", {
    data: {},
    headers: { Authorization: `Bearer ${rawCredential}`, Origin: "https://evil.example" },
  });

  expect(response.status()).toBe(403);
  expect(await response.text()).not.toContain(rawCredential);
});
