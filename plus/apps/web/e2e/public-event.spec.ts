import { expect, test } from "@playwright/test";

test("anonymous visitor reads the event home and its public sections", async ({ page }) => {
  await page.goto("/e/E2E-DEMO");
  await expect(page.getByRole("heading", { name: "2026 院十佳" })).toBeVisible();
  await expect(page.getByText("春日声场")).toBeVisible();
  await expect(page.getByText("大学生活动中心剧场")).toBeVisible();
  await expect(page.getByText("林晓").first()).toBeVisible();
  await expect(page.getByText("初赛抽签结果已公布", { exact: false })).toBeVisible();
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth),
  ).toBe(false);
});

test("organizer edits the public profile and sees it on the public page", async ({ page }) => {
  await page.goto("/login");
  await page.getByLabel("用户名").fill("e2e-ops");
  await page.getByLabel("密码").fill("e2e-ops-password");
  await page.getByRole("button", { name: "登录" }).click();
  await expect(page).toHaveURL(/\/workspace$/);

  await page.goto("/studio/act-e2e-demo/public");
  await page.getByLabel("标语").fill("新标语");
  await page.getByRole("button", { name: "保存" }).click();
  await expect(page.getByText("已保存")).toBeVisible();

  await page.goto("/e/E2E-DEMO");
  await expect(page.getByText("新标语")).toBeVisible();
});
