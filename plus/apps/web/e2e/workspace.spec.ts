import { expect, test } from "@playwright/test";

test("organizer enters the workspace and continues an activity", async ({ page }) => {
  await page.goto("/login");
  await page.getByLabel("用户名").fill("e2e-ops");
  await page.getByLabel("密码").fill("e2e-ops-password");
  await page.getByRole("button", { name: "登录" }).click();

  await expect(page).toHaveURL(/\/workspace$/);
  await expect(page.getByRole("heading", { name: "活动工作台" })).toBeVisible();

  const card = page.locator(".workspace-activity-card").first();
  await expect(card).toBeVisible();
  await expect(card.getByText("公开码", { exact: true })).toBeVisible();
  await card.getByRole("link", { name: "打开活动工作台" }).click();

  await expect(page).toHaveURL(/\/workspace\/[^/]+$/);
  await expect(page.getByRole("heading", { name: "活动进度" })).toBeVisible();
  await expect(page.getByRole("complementary", { name: "活动快捷操作" })).toBeVisible();

  await page.getByRole("link", { name: "返回活动工作台" }).click();
  await expect(page).toHaveURL(/\/workspace$/);
});
