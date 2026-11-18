import { expect, test } from "@playwright/test";

test("audience submits feedback after the event and Ops reads it", async ({ page }) => {
  await page.goto("/e/E2E-ONSITE-CLOSED");
  await expect(page.getByRole("heading", { name: "活动反馈" })).toBeVisible();
  await page.getByLabel("评分").selectOption("5");
  await page.getByLabel("想说的话（可选）").fill("闭幕反馈 E2E");
  await page.getByRole("button", { name: "提交反馈" }).click();
  await expect(page.getByText("感谢反馈。")).toBeVisible();

  await page.goto("/login");
  await page.getByLabel("用户名").fill("e2e-ops");
  await page.getByLabel("密码").fill("e2e-ops-password");
  await page.getByRole("button", { name: "登录" }).click();
  await expect(page).toHaveURL(/\/workspace$/);

  await page.goto("/ops/act_e2e_onsite_closed");
  await expect(page.getByText("赛后反馈")).toBeVisible();
  await expect(page.getByText(/共 \d+ 条 · 平均/)).toBeVisible();
  await expect(page.getByText("闭幕反馈 E2E")).toBeVisible();
});
