import { readFile } from "node:fs/promises";

import { expect, test } from "@playwright/test";

test("Ops downloads a registration sheet with name, student id, title and status", async ({ page }) => {
  await page.goto("/login");
  await page.getByLabel("用户名").fill("e2e-ops");
  await page.getByLabel("密码").fill("e2e-ops-password");
  await page.getByRole("button", { name: "登录" }).click();
  await expect(page).toHaveURL(/\/ops$/);

  await page.goto("/ops/act-e2e-export");
  await expect(page.getByRole("heading", { name: "2026 院十佳导出" })).toBeVisible();
  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("link", { name: "导出报名表" }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe("registrations.csv");
  const path = await download.path();
  expect(path).toBeTruthy();
  const csv = await readFile(path ?? "", "utf8");
  expect(csv).toContain("姓名,学号,曲目,状态");
  expect(csv).toContain("李明,20260001,夜空中最亮的星,已通过");
  expect(csv).toContain("未定稿");
});
