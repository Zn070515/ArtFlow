import { expect, test } from "@playwright/test";

test("organizer publishes a story that appears on the public articles page", async ({ page }) => {
  const suffix = Date.now().toString(36);
  const slug = `spring-story-${suffix}`;
  const title = `春季故事 ${suffix}`;

  await page.goto("/login");
  await page.getByLabel("用户名").fill("e2e-ops");
  await page.getByLabel("密码").fill("e2e-ops-password");
  await page.getByRole("button", { name: "登录" }).click();
  await expect(page).toHaveURL(/\/workspace$/);

  await page.goto("/ops/articles");
  await page.getByRole("button", { name: "新建文章" }).click();
  await page.getByLabel("标题").fill(title);
  await page.getByLabel(/Slug/).fill(slug);
  await page.getByLabel("正文").fill("第一段。\n\n第二段。");
  await page.getByRole("button", { name: "创建草稿" }).click();
  const row = page.getByRole("listitem").filter({ hasText: title });
  await expect(row).toContainText("草稿");
  await row.getByRole("button", { name: "发布" }).click();

  await page.goto(`/articles/${slug}`);
  await expect(page.getByRole("heading", { name: title })).toBeVisible();
  await expect(page.getByText(/第二段/)).toBeVisible();
});
