// Phone layout audit. Runs once per device project declared in playwright.config.ts, so
// the VS Code Test Explorer lists each width separately and any one can be run or
// debugged on its own.
//
// The assertion is deliberately mechanical: no page may scroll sideways, and when one
// does the failure names the element that caused it rather than just reporting a number.
// A screenshot is attached so the extension shows what broke.
//
//   uv run python manage.py prepare_layout_e2e --output-file /tmp/layout.json
//   PLAYWRIGHT_LAYOUT_FIXTURE_PATH=/tmp/layout.json npm run test:e2e
//
// Without the fixture the staff pages are skipped; the public ones still run.

import { readFileSync } from "node:fs";

import { expect, test } from "@playwright/test";

type Fixture = { public_code: string; activity_id: number; session_key: string };

const fixturePath = process.env.PLAYWRIGHT_LAYOUT_FIXTURE_PATH;
const fixture: Fixture | null = fixturePath
  ? (JSON.parse(readFileSync(fixturePath, "utf8")) as Fixture)
  : null;

type Target = { name: string; path: string; staff?: boolean };

const PUBLIC_TARGETS: Target[] = [
  { name: "home", path: "/" },
  { name: "results", path: "/results/" },
  { name: "showcase", path: "/showcase/" },
  { name: "announcements", path: "/announcements/" },
  { name: "privacy", path: "/privacy/" },
  { name: "login", path: "/login/" },
  { name: "staff-login", path: "/login/staff/" },
  { name: "register", path: "/register/" },
];

const FIXTURE_TARGETS: Target[] = [
  { name: "activity-entry", path: "/e/{code}/" },
  { name: "activity-live", path: "/e/{code}/live/" },
  { name: "activity-judge", path: "/e/{code}/judge/" },
  { name: "staff-dashboard", path: "/staff/", staff: true },
  { name: "staff-workspace", path: "/staff/activities/{activity}/workspace/", staff: true },
  { name: "staff-registrations", path: "/staff/registrations/", staff: true },
  { name: "staff-rounds", path: "/staff/rounds/", staff: true },
  { name: "staff-round-scores", path: "/staff/rounds/{round}/scores/", staff: true },
  { name: "staff-ticket-manage", path: "/staff/tickets/manage/", staff: true },
  { name: "staff-ticket-check-in", path: "/staff/tickets/check-in-page/", staff: true },
  { name: "staff-vote-sessions", path: "/staff/vote-sessions/", staff: true },
  { name: "staff-judges", path: "/staff/judges/", staff: true },
  { name: "staff-awards", path: "/staff/awards/", staff: true },
  { name: "staff-incidents", path: "/staff/incidents/", staff: true },
  { name: "staff-audit-logs", path: "/staff/audit-logs/", staff: true },
  { name: "staff-export-center", path: "/staff/export-center/", staff: true },
  { name: "staff-qr-center", path: "/staff/qr/", staff: true },
  { name: "staff-users", path: "/staff/users/", staff: true },
  { name: "staff-posts", path: "/staff/posts/", staff: true },
  { name: "staff-programs", path: "/staff/programs/", staff: true },
];

function resolve(path: string): string {
  return path
    .replace("{code}", fixture?.public_code ?? "")
    .replace("{activity}", String(fixture?.activity_id ?? ""))
    .replace("{round}", String(fixture?.round_id ?? ""));
}

// The loop is what makes this a contract: every phone width in every device project
// must fit every target page.
for (const target of PUBLIC_TARGETS) {
  test(`layout: ${target.name}`, async ({ page }) => {
    await assertNoSidewaysScroll(page, resolve(target.path));
  });
}

for (const target of FIXTURE_TARGETS) {
  test(`layout: ${target.name}`, async ({ page, context }) => {
    test.skip(!fixture, "PLAYWRIGHT_LAYOUT_FIXTURE_PATH is not set");
    if (target.staff && fixture) {
      await context.addCookies([
        { name: "sessionid", value: fixture.session_key, url: test.info().project.use.baseURL! },
      ]);
    }
    await assertNoSidewaysScroll(page, resolve(target.path));
  });
}

async function assertNoSidewaysScroll(page: import("@playwright/test").Page, path: string) {
  const response = await page.goto(path, { waitUntil: "load" });
  await page.evaluate(() => document.fonts.ready);

  const found = await page.evaluate(() => {
    const viewportWidth = document.documentElement.clientWidth;
    const offenders: string[] = [];
    for (const element of document.querySelectorAll("body *")) {
      const rect = element.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) continue;
      if (rect.right <= viewportWidth + 1 && rect.left >= -1) continue;
      const parentRect = element.parentElement?.getBoundingClientRect();
      if (parentRect && parentRect.right > viewportWidth + 1) continue;
      offenders.push(
        `<${element.tagName.toLowerCase()} class="${String(element.className).slice(0, 80)}"> ` +
          `width=${Math.round(rect.width)}`
      );
    }
    return { viewportWidth, scrollWidth: document.documentElement.scrollWidth, offenders };
  });

  // The contract is about the *page*, not about every element: a wide data table inside
  // an `overflow-x-auto` wrapper is meant to scroll within its own box, which is what
  // Django's own admin does for its changelists. What must never happen is the document
  // itself scrolling sideways, because that drags the header and the whole layout with it.
  const pageScrolls = found.scrollWidth > found.viewportWidth + 1;
  if (pageScrolls) {
    await test.info().attach("overflow.png", {
      body: await page.screenshot(),
      contentType: "image/png",
    });
  }
  expect(
    pageScrolls,
    `${path} scrolls sideways at ${found.viewportWidth}px (scrollWidth ${found.scrollWidth}); ` +
      `widest elements: ${found.offenders.join(" | ") || "(none reported)"}`
  ).toBe(false);
  expect(response?.status() ?? 0, `${path} did not render`).toBeLessThan(400);
}
