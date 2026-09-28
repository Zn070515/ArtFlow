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
    await expect(page.locator("input[type=password]")).toHaveCount(0);
    await expect(page.locator("details")).toBeVisible();
  });

  test("anonymous staff access is redirected to the staff entry", async ({ page }) => {
    await page.goto("/staff/");

    await expect(page).toHaveURL(/\/login\/staff\/\?next=%2Fstaff%2F$/);
    await expect(page.getByRole("heading", { name: "工作人员登录" })).toBeVisible();
  });
});
