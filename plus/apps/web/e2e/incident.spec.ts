import { expect, test } from "@playwright/test";

test("organizer records and recovers a live incident", async ({ page }) => {
  const title = `E2E Incident ${Date.now()}`;

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
  await page.getByRole("checkbox", { name: /是否需要现场事故记录/ }).check();
  await page.getByRole("button", { name: "下一步" }).click();
  await expect(page.getByRole("heading", { name: "检查与创建" })).toBeVisible();
  await page.getByRole("button", { name: "创建活动" }).click();
  await expect(page).toHaveURL(/\/studio\/act/);
  await page.getByRole("button", { name: "激活活动" }).first().click();
  await page.getByRole("button", { name: "编译定义" }).click();
  await expect(page.getByText(/编译成功/)).toBeVisible();
  await page.getByRole("button", { name: "发布当前编译" }).click();
  await expect(page.getByText("ACTIVE", { exact: true }).first()).toBeVisible();

  const activityId = page.url().split("/").pop();
  await page.goto(`/ops/${activityId}`);
  await expect(page.getByTestId("incident-card")).toBeVisible();

  await page.getByLabel("事故标题").fill("话筒没有声音");
  await page.getByLabel("严重程度").selectOption("high");
  await page.getByLabel("分类").selectOption("stage");
  await page.getByRole("button", { name: "记录事故" }).click();
  const row = page.getByTestId("incident-row");
  await expect(row).toContainText("话筒没有声音");
  await expect(row).toContainText("待处理");

  await row.getByRole("button", { name: "确认" }).click();
  await expect(row).toContainText("处理中");

  await row.getByRole("button", { name: "解决" }).click();
  await page.getByLabel("处理结果").fill("更换备用话筒");
  await row.getByRole("button", { name: "确认解决" }).click();
  await expect(row).toContainText("已解决");

  await row.getByRole("button", { name: "重开" }).click();
  await page.getByLabel("重开原因").fill("同一话筒再次无声");
  await row.getByRole("button", { name: "确认重开" }).click();
  await expect(row).toContainText("待处理");
});
