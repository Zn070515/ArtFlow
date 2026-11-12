import { expect, test } from "@playwright/test";

test("Studio creates, releases, and runs a definition", async ({ page }) => {
  const title = `E2E Studio ${Date.now()}`;

  await page.goto("/login");
  await page.getByLabel("用户名").fill("e2e-ops");
  await page.getByLabel("密码").fill("e2e-ops-password");
  await page.getByRole("button", { name: "登录" }).click();
  await expect(page).toHaveURL(/\/workspace$/);

  await page.goto("/studio");
  await page.getByRole("link", { name: "新建活动" }).click();
  await expect(page).toHaveURL(/\/studio\/new$/);
  await page.getByLabel("活动标题").fill(title);
  await page.getByRole("button", { name: "创建活动" }).click();
  await expect(page).toHaveURL(/\/studio\/act/);
  await expect(page.getByRole("heading", { name: title, exact: true })).toBeVisible();

  await page.getByRole("button", { name: "激活活动" }).click();
  await expect(page.getByText(/STUDIO · active/)).toBeVisible();

  await page.getByRole("button", { name: "编译定义" }).click();
  await expect(page.getByText(/编译成功/)).toBeVisible();

  await page.getByRole("button", { name: "发布当前编译" }).click();
  await expect(page.locator(".active-badge").first()).toBeVisible();

  await page.getByLabel("Mode").selectOption("rehearsal");
  await page.getByRole("button", { name: "启动会话" }).click();
  await page.getByRole("button", { name: "确认启动 rehearsal 会话" }).click();
  await expect(page.getByText(/rehearsal · running/)).toBeVisible();
  await page.getByRole("button", { name: "关闭" }).first().click();
  await expect(page.getByText(/rehearsal · closed/)).toBeVisible();

  // A list row must navigate to the detail route (regression: rows rendered
  // the right href but clicks did not change the URL).
  await page.goto("/studio");
  await page.getByRole("link", { name: title, exact: true }).click();
  await expect(page).toHaveURL(/\/studio\/act/);

  await page.goto("/live");
  await page.getByRole("link", { name: title, exact: true }).click();
  await expect(page).toHaveURL(/\/live\/act/);
});
