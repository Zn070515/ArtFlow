import { expect, test } from "@playwright/test";

test("embed widget renders without the portal shell", async ({ page }) => {
  await page.goto("/embed/E2E-ONSITE");
  await expect(page.getByRole("heading", { name: "E2E 现场十佳" })).toBeVisible();
  await expect(page.getByText("周然")).toBeVisible();
  await expect(page.getByText("下一个：陈默")).toBeVisible();
  await expect(page.locator(".site-header")).toHaveCount(0);
  await expect(page.locator(".site-footer")).toHaveCount(0);
  await expect(page.getByRole("link", { name: "查看完整活动 →" })).toHaveAttribute("target", "_top");
});

test("closed embed shows the latest results", async ({ page }) => {
  await page.goto("/embed/E2E-ONSITE-CLOSED");
  await expect(page.locator(".embed-results")).toBeVisible();
  await expect(page.getByText("林晓")).toBeVisible();
});
