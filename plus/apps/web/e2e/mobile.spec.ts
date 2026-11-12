import { expect, test, type Page } from "@playwright/test";

// Runs in the `mobile` project (iPhone 13 viewport on Chromium). These are
// layout guarantees, not journeys: every console surface must stay readable
// at 390px, and every visible control must stay a usable touch target.
const touchTargetFloor = 40;

const consoleRoutes = [
  "/workspace",
  "/workspace/act_e2e_attendance",
  "/studio",
  "/studio/act_e2e_attendance",
  "/live",
  "/ops",
  "/ops/act_e2e_attendance",
];

async function login(page: Page) {
  await page.goto("/login");
  await page.getByLabel("用户名").fill("e2e-ops");
  await page.getByLabel("密码").fill("e2e-ops-password");
  await page.getByRole("button", { name: "登录" }).click();
  await expect(page).toHaveURL(/\/workspace$/);
}

async function measure(page: Page) {
  return page.evaluate((floor) => {
    const root = document.documentElement;
    const targets = [...document.querySelectorAll("a, button, select, summary")].filter((element) => {
      const rect = element.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) {
        return false;
      }
      // The off-canvas sidebar is asserted separately; checkboxes use their
      // wrapping label as the target and are excluded by the selector above.
      return !element.closest(".console-sidebar") && rect.height < floor;
    });
    return {
      horizontalOverflow: root.scrollWidth > root.clientWidth,
      undersized: targets.map((element) => ({
        tag: element.tagName.toLowerCase(),
        text: (element.textContent ?? "").trim().slice(0, 40),
        height: Math.round(element.getBoundingClientRect().height),
      })),
    };
  }, touchTargetFloor);
}

test("mobile console surfaces keep touch targets and avoid horizontal scroll", async ({ page }) => {
  await login(page);

  for (const route of consoleRoutes) {
    await page.goto(route);
    await expect(page.locator(".console-page")).toBeVisible();

    const result = await measure(page);
    expect(result.horizontalOverflow, `${route} scrolls horizontally`).toBe(false);
    expect(result.undersized, `${route} has controls shorter than ${touchTargetFloor}px`).toEqual([]);
  }

  // The seeded Live activity id is timestamped, so take the first detail row
  // the list renders rather than hard-coding it.
  await page.goto("/live");
  const liveDetailHref = await page.locator('a[href^="/live/"]').first().getAttribute("href");
  expect(liveDetailHref).not.toBeNull();
  await page.goto(liveDetailHref!);
  await expect(page.locator(".console-page")).toBeVisible();
  const liveResult = await measure(page);
  expect(liveResult.horizontalOverflow, `${liveDetailHref} scrolls horizontally`).toBe(false);
  expect(liveResult.undersized, `${liveDetailHref} has controls shorter than ${touchTargetFloor}px`).toEqual([]);
});

test("mobile portal header wraps into two rows with 44px targets", async ({ page }) => {
  await login(page);

  await page.goto("/");
  await expect(page.locator(".brand")).toBeVisible();
  // The portal header renders the staff nav only after /api/auth/me resolves.
  await expect(page.getByRole("link", { name: "Ops", exact: true })).toBeVisible();

  const header = await page.evaluate(() => {
    const headerElement = document.querySelector(".site-header");
    if (headerElement === null) {
      return null;
    }
    const links = [...headerElement.querySelectorAll<HTMLElement>(".nav-link")];
    return {
      headerHeight: Math.round(headerElement.getBoundingClientRect().height),
      overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
      brandHeight: Math.round(document.querySelector(".brand")?.getBoundingClientRect().height ?? 0),
      linkHeights: links.map((link) => Math.round(link.getBoundingClientRect().height)),
      linkCount: links.length,
    };
  });

  expect(header).not.toBeNull();
  // Two stacked rows (brand + nav) instead of a single cramped row.
  expect(header!.headerHeight).toBeGreaterThanOrEqual(88);
  expect(header!.overflow).toBe(false);
  expect(header!.linkCount).toBeGreaterThanOrEqual(4);
  expect(header!.brandHeight).toBeGreaterThanOrEqual(44);
  expect(header!.linkHeights.filter((height) => height < 44)).toEqual([]);

  await page.goto("/results/E2E-DEMO");
  const resultsLink = page.getByRole("link", { name: "查看节目单 / 主持手卡" });
  await expect(resultsLink).toBeVisible();
  const linkBox = await resultsLink.boundingBox();
  expect(linkBox?.height ?? 0).toBeGreaterThanOrEqual(44);
});
