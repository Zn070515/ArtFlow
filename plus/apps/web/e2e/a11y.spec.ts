import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Locator, type Page } from "@playwright/test";

const authenticatedSurfaces: { path: string; ready: (page: Page) => Locator }[] = [
  { path: "/workspace", ready: (page) => page.locator(".workspace-activity-card").first() },
  { path: "/ops", ready: (page) => page.getByRole("table", { name: "活动列表" }) },
  { path: "/studio", ready: (page) => page.getByRole("table", { name: "活动列表" }) },
  { path: "/live", ready: (page) => page.getByRole("table", { name: "可执评的活动" }) },
  { path: "/results/E2E-DEMO", ready: (page) => page.locator(".results") },
];

async function assertNoBlockingViolations(page: Page, label: string): Promise<void> {
  const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).analyze();
  const blocking = results.violations.filter(
    (violation) => violation.impact === "serious" || violation.impact === "critical",
  );
  expect(
    blocking,
    `${label}: ${blocking.map((violation) => `${violation.id} (${violation.nodes.length})`).join(", ")}`,
  ).toEqual([]);
}

test("key surfaces have no serious or critical accessibility violations", async ({ page }) => {
  // Public surfaces are audited before login; /login redirects authenticated
  // sessions to /workspace, so it cannot be audited after signing in.
  await page.goto("/");
  await expect(page.locator(".landing")).toBeVisible();
  await assertNoBlockingViolations(page, "/");

  await page.goto("/login");
  await expect(page.locator(".auth-card")).toBeVisible();
  await assertNoBlockingViolations(page, "/login");

  await page.getByLabel("用户名").fill("e2e-ops");
  await page.getByLabel("密码").fill("e2e-ops-password");
  await page.getByRole("button", { name: "登录" }).click();
  await expect(page).toHaveURL(/\/workspace$/);

  for (const surface of authenticatedSurfaces) {
    await page.goto(surface.path);
    // .console-page renders before RequireSession and the page query resolve;
    // wait for a real table/card so axe inspects loaded content.
    await expect(surface.ready(page)).toBeVisible({ timeout: 15_000 });
    await assertNoBlockingViolations(page, surface.path);
  }
});
