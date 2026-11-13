import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

const surfaces = [
  { path: "/login", ready: ".auth-card" },
  { path: "/workspace", ready: ".console-page" },
  { path: "/ops", ready: ".console-page" },
  { path: "/studio", ready: ".console-page" },
  { path: "/live", ready: ".console-page" },
  { path: "/results/E2E-DEMO", ready: ".results" },
];

test("key surfaces have no serious or critical accessibility violations", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(".landing")).toBeVisible();
  const landing = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).analyze();
  expect(
    landing.violations.filter((violation) => violation.impact === "serious" || violation.impact === "critical"),
    `/: ${landing.violations.map((violation) => violation.id).join(", ")}`,
  ).toEqual([]);

  await page.goto("/login");
  await page.getByLabel("用户名").fill("e2e-ops");
  await page.getByLabel("密码").fill("e2e-ops-password");
  await page.getByRole("button", { name: "登录" }).click();
  await expect(page).toHaveURL(/\/workspace$/);

  for (const surface of surfaces) {
    await page.goto(surface.path);
    await expect(page.locator(surface.ready)).toBeVisible();
    const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).analyze();
    const blocking = results.violations.filter(
      (violation) => violation.impact === "serious" || violation.impact === "critical",
    );
    expect(
      blocking,
      `${surface.path}: ${blocking.map((violation) => `${violation.id} (${violation.nodes.length})`).join(", ")}`,
    ).toEqual([]);
  }
});
