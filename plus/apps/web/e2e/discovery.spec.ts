import { expect, test } from "@playwright/test";

test("public directory lists opted-in events and searches", async ({ page }) => {
  await page.goto("/events");
  await expect(page.getByRole("heading", { name: "找到下一场活动。" })).toBeVisible();
  await expect(page.getByRole("link", { name: "E2E 现场十佳", exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: "2026 院十佳" })).toBeVisible();

  await page.getByLabel("搜索活动").fill("现场");
  await expect(page.getByRole("link", { name: "E2E 现场十佳", exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: "2026 院十佳" })).toHaveCount(0);

  await page.getByRole("link", { name: "E2E 现场十佳", exact: true }).click();
  await expect(page).toHaveURL(/\/e\/E2E-ONSITE$/);
  await expect(page.locator(".event-page")).toBeVisible();
  await expect(page.getByRole("heading", { name: "E2E 现场十佳", exact: true })).toBeVisible();
});

test("landing links to the public directory", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("link", { name: "浏览全部活动 →" }).click();
  await expect(page).toHaveURL(/\/events$/);
  await expect(page.getByRole("heading", { name: "找到下一场活动。" })).toBeVisible();
});
