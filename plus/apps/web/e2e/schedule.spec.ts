import { expect, test } from "@playwright/test";

test("organizer schedules a stage show and publishes the public program", async ({ page }) => {
  const title = `E2E Schedule ${Date.now()}`;

  await page.goto("/login");
  await page.getByLabel("用户名").fill("e2e-ops");
  await page.getByLabel("密码").fill("e2e-ops-password");
  await page.getByRole("button", { name: "登录" }).click();
  await expect(page).toHaveURL(/\/workspace$/);

  await page.goto("/studio/new");
  await page.getByLabel("活动标题").fill(title);
  await page.getByLabel("活动模板").selectOption({ label: "舞台演出 / 节目征集" });
  await page.getByRole("button", { name: "创建活动" }).click();
  await expect(page).toHaveURL(/\/studio\/act/);
  await expect(page.getByRole("heading", { name: title, exact: true })).toBeVisible();

  const meta = (await page.locator(".ui-page-meta").first().textContent()) ?? "";
  const publicCode = meta.match(/公开码 ([A-Za-z0-9-]+)/)?.[1];
  expect(publicCode).toBeTruthy();

  await page.getByRole("button", { name: "激活活动" }).click();
  await page.getByRole("button", { name: "编译定义" }).click();
  await expect(page.getByText(/编译成功/)).toBeVisible();
  await page.getByRole("button", { name: "发布当前编译" }).click();
  await expect(page.getByText("ACTIVE", { exact: true }).first()).toBeVisible();

  const activityId = page.url().split("/").pop();
  expect(activityId).toBeTruthy();
  await page.goto(`/ops/${activityId}`);
  await expect(page.getByTestId("schedule-card")).toBeVisible();

  await page.getByLabel("节目类型").selectOption({ index: 1 });
  await page.getByLabel("节目名称").fill("合唱《夜空中最亮的星》");
  await page.getByRole("button", { name: "添加节目" }).click();
  await expect(page.getByTestId("schedule-entry")).toContainText("合唱");

  await page.getByLabel("备注").fill("首版节目单");
  await page.getByRole("button", { name: "发布节目单" }).click();
  await page.getByRole("dialog", { name: "发布节目单？" }).getByRole("button", { name: "发布" }).click();
  await expect(page.getByText(/第 1 版/)).toBeVisible();

  await page.goto(`/program/${publicCode}`);
  await expect(page.getByRole("heading", { name: title, exact: true })).toBeVisible();
  await expect(page.getByText("合唱《夜空中最亮的星》")).toBeVisible();
});
