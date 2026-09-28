import { expect, test } from "@playwright/test";

test.describe("authentication entry boundaries", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("mobile login selector exposes role-specific entries without credentials", async ({ page }) => {
    const response = await page.goto("/login/");

    expect(response?.status()).toBe(200);
    await expect(page.getByRole("heading", { name: "选择登录入口" })).toBeVisible();
    await expect(page.getByRole("link", { name: "选手登录" })).toBeVisible();
    await expect(page.getByRole("link", { name: "工作人员登录" })).toBeVisible();
    await expect(page.getByRole("link", { name: "管理员登录" })).toBeVisible();
    await expect(page.getByRole("link", { name: "选手注册" })).toBeVisible();
    await expect(page.getByRole("link", { name: "工作人员注册" })).toBeVisible();
    await expect(page.getByRole("link", { name: "管理员注册" })).toBeVisible();
    await expect(page.locator("input[type=password]")).toHaveCount(0);
    await expect(page.locator("details")).toBeVisible();
  });

  test("staff and admin registration pages require their own access-key field", async ({ page }) => {
    await page.goto("/register/staff/");
    await expect(page.getByRole("heading", { name: "工作人员注册" })).toBeVisible();
    await expect(page.locator('input[name="access_key"]')).toHaveCount(1);
    await expect(page.getByLabel("工作人员密钥", { exact: true })).toBeVisible();

    await page.goto("/register/admin/");
    await expect(page.getByRole("heading", { name: "管理员注册" })).toBeVisible();
    await expect(page.locator('input[name="access_key"]')).toHaveCount(1);
    await expect(page.getByLabel("管理员密钥", { exact: true })).toBeVisible();
  });

  test("anonymous staff access is redirected to the staff entry", async ({ page }) => {
    await page.goto("/staff/");

    const redirectedUrl = new URL(page.url());
    expect(redirectedUrl.pathname).toBe("/login/staff/");
    expect(redirectedUrl.searchParams.get("next")).toBe("/staff/");
    await expect(page.getByRole("heading", { name: "工作人员登录" })).toBeVisible();
  });
});
