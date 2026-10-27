import { expect, test } from "@playwright/test";

test("ops splits, confirms, and freezes a grouping stage", async ({ page }) => {
  await page.goto("/login");
  await page.getByLabel("用户名").fill("e2e-ops");
  await page.getByLabel("密码").fill("e2e-ops-password");
  await page.getByRole("button", { name: "登录" }).click();
  await page.waitForURL(/\/ops$/);

  await page.goto("/ops/act_e2e_grouping");
  await expect(page.getByRole("heading", { name: "第一轮分组" })).toBeVisible();

  await page.getByRole("button", { name: "创建分组赛段" }).click();
  await expect(page.getByRole("button", { name: "保存分组" })).toBeDisabled();
  await page.getByRole("button", { name: "自动平均分组" }).click();
  // A local draft is not saved yet: confirming now would use the old grouping.
  await expect(page.getByRole("button", { name: "确认分组" })).toBeDisabled();
  await page.getByRole("button", { name: "保存分组" }).click();
  await expect(page.getByText("已分 4/4 人")).toBeVisible();
  await expect(page.getByRole("button", { name: "确认分组" })).toBeEnabled();

  await page.getByRole("button", { name: "确认分组" }).click();
  await expect(page.getByText("状态：confirmed")).toBeVisible();

  await page.getByRole("button", { name: "冻结分组" }).click();
  await expect(page.getByText("分组已冻结")).toBeVisible();
});
