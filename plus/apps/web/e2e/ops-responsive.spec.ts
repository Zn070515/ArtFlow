import { expect, test } from "@playwright/test";

test("Ops list keeps a table at 1440 and card rows without horizontal scroll at 390", async ({ page }) => {
  await page.goto("/login");
  await page.getByLabel("用户名").fill("e2e-ops");
  await page.getByLabel("密码").fill("e2e-ops-password");
  await page.getByRole("button", { name: "登录" }).click();
  await expect(page).toHaveURL(/\/workspace$/);

  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/ops");
  await expect(page.getByRole("heading", { name: "活动" })).toBeVisible();
  await expect(page.getByRole("table", { name: "活动列表" })).toBeVisible();
  const desktopHeadPosition = await page.locator(".ui-table thead").evaluate((element) => getComputedStyle(element).position);
  expect(desktopHeadPosition).not.toBe("absolute");

  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.locator('td[data-label="公开码"]').first()).toBeVisible();
  const mobileHeadPosition = await page.locator(".ui-table thead").evaluate((element) => getComputedStyle(element).position);
  expect(mobileHeadPosition).toBe("absolute");
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);
  expect(overflow).toBe(false);
});
