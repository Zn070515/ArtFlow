import { expect, test } from "@playwright/test";

const adminAccessKey = process.env.ARTFLOW_E2E_ADMIN_ACCESS_KEY;
if (!adminAccessKey) {
  throw new Error("ARTFLOW_E2E_ADMIN_ACCESS_KEY is required for the human acceptance flow.");
}

// Both journeys intentionally exercise first-class account provisioning against the
// same database. Keep them ordered so local SQLite rehearsal cannot race on writes;
// PostgreSQL CI remains covered by the same visible browser contract.
test.describe.configure({ mode: "serial" });

async function registerAndOpenWorkspace(page) {
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

  // New activities intentionally start in draft. Move the activity through the
  // visible admin workflow before opening configuration that requires a live phase.
  await page.getByRole("link", { name: "编辑活动" }).click();
  await page.locator("#id_phase").selectOption("registration_open");
  await page.getByRole("button", { name: "保存" }).click();
  await expect(page).toHaveURL(/\/staff\/activities\/$/);
  await page.locator("tr", { hasText: activityTitle }).getByRole("link", { name: "进入工作区" }).click();
  await expect(page.getByRole("heading", { name: activityTitle })).toBeVisible();
  return { activityTitle };
}

test("a new admin can reach the activity workspace and preserve scope", async ({ page }) => {
  const { activityTitle } = await registerAndOpenWorkspace(page);
  await expect(page.getByRole("link", { name: "编辑赛制" })).toBeVisible();
  await expect(page.getByRole("link", { name: "新建评分标准" })).toBeVisible();
  await expect(page.getByRole("link", { name: "新建比赛轮次" })).toBeVisible();
  await expect(page.getByRole("link", { name: "创建投票场次" })).toBeVisible();

  await page.getByRole("link", { name: "新建评分标准" }).click();
  await expect(page.locator("#id_activity_id option:checked")).toHaveText(activityTitle);
  await page.locator("#id_name").fill("第一轮评分");
  await page.locator("#id_criterion_name_1").fill("综合表现");
  await page.locator("#id_criterion_max_score_1").fill("100");
  await page.getByRole("button", { name: "创建评分标准" }).click();

  await expect(page).toHaveURL(/\/staff\/rounds\/new\/\?activity_id=\d+/);
  await expect(page.locator("#id_activity_id")).toHaveValue(/\d+/);
  await expect(page.locator("#id_activity_id option:checked")).toHaveText(activityTitle);
  await expect(page.locator("#id_rubric option")).toHaveCount(2);
  await expect(page.locator("#id_rubric option").nth(1)).toHaveText("第一轮评分");
  await expect(page.locator('[class~="bg-brand"][class~="text-brand"]')).toHaveCount(0);
});

test("the activity workspace remains usable at a mobile viewport", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  const { activityTitle } = await registerAndOpenWorkspace(page);
  await expect(page.getByRole("heading", { name: activityTitle })).toBeVisible();
  await expect(page.getByText("报名与材料")).toBeVisible();
  await expect(page.getByText("赛制与评分")).toBeVisible();
  await expect(page.getByText("投票与现场")).toBeVisible();
  await expect(page.locator('[class~="bg-brand"][class~="text-brand"]')).toHaveCount(0);
});
