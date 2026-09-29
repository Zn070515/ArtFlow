import { expect, test } from "@playwright/test";

const adminAccessKey = process.env.ARTFLOW_E2E_ADMIN_ACCESS_KEY;
if (!adminAccessKey) {
  throw new Error("ARTFLOW_E2E_ADMIN_ACCESS_KEY is required for the human acceptance flow.");
}

test("a new admin can register, create an activity, and enter its workspace", async ({ page }) => {
  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const username = `human-acceptance-${suffix}`;
  const password = `Violet!Mesa7Quartz${suffix.slice(-4)}`;
  const activityTitle = `Human acceptance activity ${suffix}`;

  await page.goto("/register/admin/");
  await page.getByLabel("用户名").fill(username);
  await page.getByLabel("密码", { exact: true }).fill(password);
  await page.getByLabel("确认密码").fill(password);
  await page.getByLabel("管理员密钥").fill(adminAccessKey);
  await page.getByRole("button", { name: "创建管理员账号" }).click();

  await expect(page).toHaveURL(/\/staff\/$/);
  await page.locator('a[href="/staff/activities/"]').click();
  await page.getByRole("link", { name: "新建活动" }).click();
  await page.getByLabel("活动标题").fill(activityTitle);
  await page.locator("#id_activity_type").selectOption("singer_contest");
  await page.getByRole("button", { name: "保存" }).click();

  const activityRow = page.locator("tr", { hasText: activityTitle });
  await expect(activityRow).toBeVisible();
  await activityRow.getByRole("link", { name: "进入工作区" }).click();
  await expect(page.getByRole("heading", { name: activityTitle })).toBeVisible();
  await expect(page.getByRole("link", { name: "新建比赛轮次" })).toBeVisible();
  await expect(page.getByRole("link", { name: "创建投票场次" })).toBeVisible();

  await page.getByRole("link", { name: "新建比赛轮次" }).click();
  await expect(page.locator("#id_activity_id")).toHaveValue(/\d+/);
  await expect(page.locator("#id_activity_id option:checked")).toHaveText(activityTitle);
});
