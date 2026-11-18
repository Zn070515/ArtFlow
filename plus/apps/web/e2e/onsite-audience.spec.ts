import { expect, test } from "@playwright/test";

test("on-site audience sees now/next, the announcement and named vote candidates", async ({ page }) => {
  await page.goto("/e/E2E-ONSITE");
  await expect(page.getByRole("heading", { name: "E2E 现场十佳" })).toBeVisible();
  await expect(page.getByText("周然").first()).toBeVisible();
  await expect(page.getByText("下一个：陈默")).toBeVisible();
  await expect(page.getByText("第 8 位选手请到后台候场")).toBeVisible();
  await expect(page.getByText("开场提醒")).toBeVisible();
  await expect(page.getByText("在哪里入场？")).toBeVisible();
  await expect(page.getByRole("link", { name: "节目册" })).toBeVisible();
  await expect(page.locator(".event-participants")).toContainText("林晓");
  await expect(page.getByRole("link", { name: /投票进行中/ })).toBeVisible();
  await expect(page.locator('meta[property="og:title"]')).toHaveAttribute("content", /E2E 现场十佳/);
  await expect(page.getByRole("button", { name: "加入日历" })).toBeVisible();

  await page.getByRole("link", { name: /投票进行中/ }).click();
  await expect(page).toHaveURL(/\/vote\/act_e2e_onsite-vote$/);
  await expect(page.getByText("林晓")).toBeVisible();
  await expect(page.getByText("周然")).toBeVisible();
  await expect(page.getByText("陈默")).toBeVisible();
});

test("a closed event hides the live card and the vote action", async ({ page }) => {
  await page.goto("/e/E2E-ONSITE-CLOSED");
  await expect(page.getByRole("heading", { name: "E2E 现场十佳（已结束）" })).toBeVisible();
  await expect(page.locator(".event-now")).toHaveCount(0);
  await expect(page.getByRole("link", { name: /去投票/ })).toHaveCount(0);
  await expect(page.getByRole("link", { name: "查看赛果" }).first()).toBeVisible();
});
