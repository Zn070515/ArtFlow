import { expect, test } from "@playwright/test";

test("published programme and host cues show the Chinese titles", async ({ page }) => {
  await page.goto("/programme/E2E-SHOW");
  await expect(page.getByRole("heading", { name: "2026 毕业晚会" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "合唱《毕业歌》" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "开场致辞" })).toBeVisible();
  await expect(page.getByText("音乐系合唱队")).toBeVisible();

  await page.goto("/login");
  await page.getByLabel("用户名").fill("e2e-ops");
  await page.getByLabel("密码").fill("e2e-ops-password");
  await page.getByRole("button", { name: "登录" }).click();
  await expect(page).toHaveURL(/\/ops$/);

  await page.goto("/live/act-e2e-show/cues");
  await expect(page.getByRole("heading", { name: "合唱《毕业歌》" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "开场致辞" })).toBeVisible();
  await expect(page.getByText("第 1 个")).toBeVisible();
});

test("an unfinalized show has an explicit empty programme and cue state", async ({ page }) => {
  await page.goto("/programme/E2E-SHOW-DRAFT");
  await expect(page.getByText("节目单尚未发布")).toBeVisible();
  await expect(page.getByText("不能提前看到的节目")).toHaveCount(0);

  await page.goto("/login");
  await page.getByLabel("用户名").fill("e2e-ops");
  await page.getByLabel("密码").fill("e2e-ops-password");
  await page.getByRole("button", { name: "登录" }).click();
  await expect(page).toHaveURL(/\/ops$/);
  await page.goto("/live/act-e2e-show-draft/cues");
  await expect(page.getByText("节目单尚未发布")).toBeVisible();
  await expect(page.getByText("不能提前看到的节目")).toHaveCount(0);
});
