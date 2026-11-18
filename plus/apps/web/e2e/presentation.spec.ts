import { expect, test } from "@playwright/test";

test("the on-site screen shows the event and its current program", async ({ page }) => {
  await page.goto("/screen/E2E-DEMO");
  await expect(page.getByRole("heading", { name: "2026 院十佳", level: 1 })).toBeVisible();
  await expect(page.getByText("NEXT")).toBeVisible();
  await expect(page.getByText("扫码查看活动")).toBeVisible();
});

test("the printed host card and QR pack expose only public destinations", async ({ page }) => {
  await page.goto("/host-card/E2E-DEMO");
  await expect(page.getByRole("heading", { name: "2026 院十佳", level: 1 })).toBeVisible();
  await expect(page.getByRole("button", { name: "打印手卡" })).toBeVisible();

  await page.goto("/print/E2E-DEMO");
  await expect(page.getByText("活动主页")).toBeVisible();
  await expect(page.getByText("现场大屏")).toBeVisible();
  await expect(page.getByRole("button", { name: "打印这一页" })).toBeVisible();
});
