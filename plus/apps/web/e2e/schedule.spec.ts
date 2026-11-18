import { expect, test } from "@playwright/test";

test("organizer schedules a stage show and publishes the public program", async ({ page }) => {
  const title = `E2E Schedule ${Date.now()}`;

  await page.goto("/login");
  await page.getByLabel("用户名").fill("e2e-ops");
  await page.getByLabel("密码").fill("e2e-ops-password");
  await page.getByRole("button", { name: "登录" }).click();
  await expect(page).toHaveURL(/\/workspace$/);

  await page.goto("/studio/new");
  await page.getByRole("button", { name: /舞台演出/ }).click();
  await page.getByRole("button", { name: "下一步" }).click();
  await page.getByLabel("活动标题").fill(title);
  await page.getByRole("button", { name: "下一步" }).click();
  await page.getByRole("button", { name: "下一步" }).click();
  await page.getByRole("button", { name: "下一步" }).click();
  await page.getByRole("button", { name: "下一步" }).click();
  await expect(page.getByRole("heading", { name: "检查与创建" })).toBeVisible();
  await page.getByRole("button", { name: "创建活动" }).click();
  await expect(page).toHaveURL(/\/studio\/act/);
  await expect(page.getByRole("heading", { name: title, exact: true })).toBeVisible();

  const meta = (await page.locator(".ui-page-meta").first().textContent()) ?? "";
  const publicCode = meta.match(/公开码 ([A-Za-z0-9-]+)/)?.[1];
  expect(publicCode).toBeTruthy();

  await page.getByRole("button", { name: "激活活动" }).first().click();
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
  await page.getByLabel("开始时间").fill("2026-04-18T19:00");
  await page.getByRole("button", { name: "添加节目" }).click();
  await expect(page.getByTestId("schedule-entry")).toContainText("合唱");

  await page.getByLabel("备注").fill("首版节目单");
  await page.getByRole("button", { name: "发布节目单" }).click();
  await page.getByRole("dialog", { name: "发布节目单？" }).getByRole("button", { name: "发布" }).click();
  await expect(page.getByText(/第 1 版/)).toBeVisible();

  await page.getByRole("button", { name: "启动排期会话" }).click();
  await expect(page.getByRole("button", { name: "下一位" })).toBeEnabled();
  await page.getByRole("button", { name: "下一位" }).click();

  await page.goto(`/program/${publicCode}`);
  await expect(page.getByRole("heading", { name: title, exact: true })).toBeVisible();
  await expect(page.getByText("合唱《夜空中最亮的星》")).toBeVisible();
  await expect(page.getByText(/19:00/)).toBeVisible();

  await page.goto(`/e/${publicCode}`);
  await expect(page.getByText("合唱《夜空中最亮的星》").first()).toBeVisible();
  await expect(page.getByText(/19:00/)).toBeVisible();
  await expect(page.locator(".event-now")).toContainText("合唱《夜空中最亮的星》");
  await expect(page.locator(".event-now")).toContainText("NOW · 01");
});
