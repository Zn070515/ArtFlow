import { expect, test } from "@playwright/test";

test("organizer builds, freezes and corrects a team roster", async ({ page }) => {
  await page.goto("/login");
  await page.getByLabel("用户名").fill("e2e-ops");
  await page.getByLabel("密码").fill("e2e-ops-password");
  await page.getByRole("button", { name: "登录" }).click();
  await expect(page).toHaveURL(/\/workspace$/);

  await page.goto("/ops/act-e2e-teams");
  await expect(page.getByRole("heading", { name: "队伍与名册", level: 2 })).toBeVisible();

  await page.getByLabel("队伍 key").fill("e2e-alpha");
  await page.getByLabel("队伍名称").fill("E2E 队");
  await page.getByRole("button", { name: "添加队伍" }).click();

  const row = page.getByTestId("team-row").filter({ hasText: "E2E 队" });
  await expect(row).toContainText("草稿");

  await row.getByLabel("添加队员").selectOption({ label: "选手甲" });
  await row.getByRole("button", { name: "添加", exact: true }).click();
  await expect(row).toContainText("选手甲");

  await page.getByRole("button", { name: "冻结名册" }).click();
  await expect(page.getByText(/名册已冻结/)).toBeVisible();

  await page.getByRole("button", { name: "修正名册" }).click();
  await page.getByLabel("队伍名称", { exact: true }).fill("E2E 队改名");
  await page.getByLabel("修正原因").fill("现场更正队名");
  await page.getByRole("button", { name: "保存修正" }).click();

  await expect(page.getByTestId("team-row").filter({ hasText: "E2E 队改名" })).toContainText("已冻结");
  await expect(page.getByText(/名册已冻结/)).toBeVisible();
});
