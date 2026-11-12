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

test("keeps activity identity visible while analytics recovers", async ({ page }) => {
  const analyticsPath = "**/api/activities/*/operations/analytics";
  let failAnalytics = true;
  await page.route(analyticsPath, async (route) => {
    if (failAnalytics) {
      await route.abort();
      return;
    }
    const response = await route.fetch();
    const body = await response.json() as Record<string, unknown>;
    await route.fulfill({
      response,
      json: {
        ...body,
        attention: [{ code: "REGISTRATION_REVIEW_PENDING", severity: "warning", count: 2 }],
      },
    });
  });

  await page.goto("/login");
  await page.getByLabel("用户名").fill("e2e-ops");
  await page.getByLabel("密码").fill("e2e-ops-password");
  await page.getByRole("button", { name: "登录" }).click();
  await expect(page).toHaveURL(/\/workspace$/);

  const card = page.locator(".workspace-activity-card").first();
  await card.getByRole("link", { name: "打开活动工作台" }).click();
  await expect(page.getByRole("heading", { name: "活动进度" })).toBeVisible();
  await expect(page.getByText("运营摘要暂不可用")).toBeVisible();
  await expect(page.getByRole("complementary", { name: "活动快捷操作" })).toBeVisible();

  failAnalytics = false;
  await page.reload();
  await expect(page.getByRole("heading", { name: "活动进度" })).toBeVisible();
  await expect(page.getByText("运营摘要暂不可用")).not.toBeVisible();
  await expect(page.getByRole("heading", { name: "处理报名审核" })).toBeVisible();
  await expect(page.getByText("还有 2 项报名需要处理。")).toBeVisible();
});
