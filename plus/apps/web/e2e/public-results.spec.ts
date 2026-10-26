import { expect, test } from "@playwright/test";

test("anonymous visitor opens the official results", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1 })).toContainText("赛果");
  await page.getByLabel("活动公开码").fill("E2E-DEMO");
  await page.getByRole("button", { name: "查看赛果" }).click();

  await expect(page).toHaveURL(/\/results\/E2E-DEMO$/);
  await expect(page.getByRole("heading", { name: "2026 院十佳", exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "2026 院十佳 · 正式赛果" })).toBeVisible();
  await expect(page.getByText("singer-a").first()).toBeVisible();
  await expect(page.getByText("98.30").first()).toBeVisible();
  await expect(page.getByText("冠军")).toBeVisible();
  await expect(page.locator("body")).not.toContainText("fingerprint-not-public");
});

test("unknown public code shows the not-found state", async ({ page }) => {
  await page.goto("/results/NOT-FOUND");
  await expect(page.getByText("没有找到这场活动的结果")).toBeVisible();
});

test("reduced motion keeps the static backdrop and skips WebGL", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/");
  await expect(page.getByTestId("static-backdrop")).toBeVisible();
  await expect(page.locator("canvas")).toHaveCount(0);
});
