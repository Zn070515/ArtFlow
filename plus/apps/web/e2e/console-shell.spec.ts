import { expect, test } from "@playwright/test";

test("mobile Console navigation is hidden when closed and restores focus on Escape", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/login");
  await page.getByLabel("用户名").fill("e2e-ops");
  await page.getByLabel("密码").fill("e2e-ops-password");
  await page.getByRole("button", { name: "登录" }).click();
  await expect(page).toHaveURL(/\/ops$/);

  const sidebar = page.locator("#console-sidebar");
  const menuToggle = page.getByRole("button", { name: "打开 Console 导航" });
  await expect(sidebar).toBeHidden();
  await expect.poll(async () => sidebar.evaluate((element) => {
    const style = window.getComputedStyle(element);
    return `${style.visibility}/${style.pointerEvents}`;
  })).toBe("hidden/none");

  await menuToggle.click();
  await expect(page.getByRole("button", { name: "关闭 Console 导航" })).toBeVisible();
  await expect(sidebar).toBeVisible();

  await page.keyboard.press("Escape");
  await expect(sidebar).toBeHidden();
  await expect(menuToggle).toBeFocused();
});
