import { expect, test } from "@playwright/test";

test("organizer books, confirms and conflicts a rehearsal resource", async ({ page }) => {
  await page.goto("/login");
  await page.getByLabel("用户名").fill("e2e-ops");
  await page.getByLabel("密码").fill("e2e-ops-password");
  await page.getByRole("button", { name: "登录" }).click();
  await expect(page).toHaveURL(/\/workspace$/);

  await page.goto("/ops/act-e2e-resources");
  await expect(page.getByRole("heading", { name: "资源与排练", level: 2 })).toBeVisible();
  await expect(page.getByText("主礼堂").first()).toBeVisible();

  await page.getByLabel("用途 / 标题").fill("彩排 A");
  await page.getByLabel("开始").fill("2026-12-01T10:00");
  await page.getByLabel("结束").fill("2026-12-01T12:00");
  await page.getByRole("button", { name: "添加预约" }).click();

  const firstRow = page.getByTestId("resource-booking-row").filter({ hasText: "彩排 A" });
  await expect(firstRow).toContainText("草稿");
  await firstRow.getByRole("button", { name: "确认" }).click();
  await expect(firstRow).toContainText("已确认");

  await page.getByLabel("用途 / 标题").fill("彩排 B");
  await page.getByLabel("开始").fill("2026-12-01T11:00");
  await page.getByLabel("结束").fill("2026-12-01T13:00");
  await page.getByRole("button", { name: "添加预约" }).click();
  const secondRow = page.getByTestId("resource-booking-row").filter({ hasText: "彩排 B" });
  await expect(secondRow).toContainText("草稿");
  await secondRow.getByRole("button", { name: "确认" }).click();
  await expect(page.getByText("该资源在这个时段已被确认。")).toBeVisible();
});
