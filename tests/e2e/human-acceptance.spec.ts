import { expect, test } from "@playwright/test";

const adminAccessKey = process.env.ARTFLOW_E2E_ADMIN_ACCESS_KEY;
if (!adminAccessKey) {
  throw new Error("ARTFLOW_E2E_ADMIN_ACCESS_KEY is required for the human acceptance flow.");
}

// Both journeys intentionally exercise first-class account provisioning against the
// same database. Keep them ordered so local SQLite rehearsal cannot race on writes;
// PostgreSQL CI remains covered by the same visible browser contract.
test.describe.configure({ mode: "serial" });

test.describe("human acceptance", () => {

async function registerAndOpenWorkspace(page) {
  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const username = `human-acceptance-${suffix}`;
  // Keep the fixture independent of the random suffix's character composition:
  // Django's password validators require a numeric character.
  const password = `Violet!Mesa7Quartz2026${suffix.slice(-4)}`;
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

test("the first admin bootstrap reaches the Singer workspace and preserves scope", async ({ page }) => {
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

  await page.getByLabel("轮次名称").fill("第一轮");
  await page.locator("#id_sequence").fill("1");
  await page.locator("#id_rubric").selectOption({ label: "第一轮评分" });
  await page.getByRole("button", { name: "创建轮次" }).click();
  await expect(page).toHaveURL(/\/staff\/rounds\/$/);
  await expect(page.getByRole("cell", { name: "第一轮", exact: true }).first()).toBeVisible();

  await page.goto(`/staff/vote-sessions/new/?activity_id=${await activityId(page, activityTitle)}`);
  await expect(page.locator("#id_activity_id option:checked")).toHaveText(activityTitle);

  await page.goto("/staff/activities/");
  await page.getByRole("link", { name: "新建活动" }).click();
  const farewellTitle = `${activityTitle} 毕晚`;
  await page.getByLabel("活动标题").fill(farewellTitle);
  await page.locator("#id_activity_type").selectOption("farewell_show");
  await page.getByRole("button", { name: "保存" }).click();
  const farewellRow = page.locator("tr", { hasText: farewellTitle });
  await farewellRow.getByRole("link", { name: "进入工作区" }).click();
  await expect(page.getByRole("heading", { name: "节目征集与审核" })).toBeVisible();
  await expect(page.getByRole("link", { name: "查看本活动节目" })).toBeVisible();
  await expect(page.getByText("新建比赛轮次")).toHaveCount(0);
});

async function activityId(page, title: string) {
  await page.goto("/staff/activities/");
  const workspaceHref = await page
    .locator("tr", { hasText: title })
    .getByRole("link", { name: "进入工作区" })
    .getAttribute("href");
  const match = workspaceHref?.match(/activities\/(\d+)\/workspace/);
  if (!match) throw new Error(`Could not resolve activity id for ${title}.`);
  return match[1];
}

test("the activity workspace remains usable at a mobile viewport", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  const { activityTitle } = await registerAndOpenWorkspace(page);
  await expect(page.getByRole("heading", { name: activityTitle })).toBeVisible();
  await expect(page.getByText("报名与材料")).toBeVisible();
  await expect(page.getByText("赛制与评分")).toBeVisible();
  await expect(page.getByText("投票与现场")).toBeVisible();
  await expect(page.locator('[class~="bg-brand"][class~="text-brand"]')).toHaveCount(0);
});

});
