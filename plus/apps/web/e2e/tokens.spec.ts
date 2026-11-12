import { expect, test } from "@playwright/test";

test("token sheet renders every theme at 1440 and 390", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto("/_tokens");
  await page.evaluate(() => document.fonts.ready);
  await expect(page.getByRole("heading", { name: "设计 token" })).toBeVisible();
  await expect(page).toHaveScreenshot("tokens-1440.png", {
    fullPage: true,
    animations: "disabled",
    maxDiffPixelRatio: 0.05,
  });

  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page).toHaveScreenshot("tokens-390.png", {
    fullPage: true,
    animations: "disabled",
    maxDiffPixelRatio: 0.05,
  });
});
