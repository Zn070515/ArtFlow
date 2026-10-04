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

type Fixture = {
  public_code: string;
  activity_id: number;
  round_id: number;
  singer_id: number;
  session_key: string;
};

// The default browser root font is 16px, and WeChat's own font-size control and the
// system accessibility settings both scale it. Everything here is sized in rem, so a
// larger root grows the whole layout — which is exactly when a width that just fit starts
// overflowing. Measure that reflow rather than fighting the setting: intercepting it
// would take a real accessibility option away from the reader.
//
// Measured across all seven widths on 2026-10-05. The gate sits at the last scale that
// passes, which is a margin above WeChat's own control (it tops out near 1.5x):
//
//   1.25x (20px)  196 passed
//   1.50x (24px)  196 passed
//   1.75x (28px)  196 passed   <- the gate
//   2.00x (32px)    6 failed
//   2.25x (36px)   20 failed
//
// Override PLAYWRIGHT_LAYOUT_FONT_PX to re-probe after a layout change.
const LARGE_TEXT_PX = Number(process.env.PLAYWRIGHT_LAYOUT_FONT_PX ?? 28);

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
  { name: "staff-activities", path: "/staff/activities/", staff: true },
  { name: "staff-ruleset-templates", path: "/staff/ruleset-templates/", staff: true },
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
  { name: "staff-registration-detail", path: "/staff/registrations/{singer}/", staff: true },
  { name: "staff-activity-new", path: "/staff/activities/new/", staff: true },
  { name: "staff-activity-edit", path: "/staff/activities/{activity}/edit/", staff: true },
  { name: "staff-round-new", path: "/staff/rounds/new/", staff: true },
  { name: "staff-round-running-order", path: "/staff/rounds/{round}/running-order/", staff: true },
  { name: "staff-round-groups", path: "/staff/rounds/{round}/groups/", staff: true },
  { name: "staff-round-ranking", path: "/staff/rounds/{round}/ranking/", staff: true },
  { name: "staff-rubric-new", path: "/staff/rubrics/new/", staff: true },
  { name: "staff-vote-new", path: "/staff/vote-sessions/new/", staff: true },
  { name: "staff-judge-new", path: "/staff/judges/new/", staff: true },
  { name: "staff-ruleset-create", path: "/staff/rulesets/create/", staff: true },
  { name: "staff-result-board", path: "/staff/activity/{activity}/result-board/", staff: true },
  { name: "staff-result-closure", path: "/staff/activity/{activity}/result-closure/", staff: true },
  { name: "staff-audience-scores", path: "/staff/activity/{activity}/audience-scores/", staff: true },
];

// Runs in the browser: the document must not scroll sideways, and when it does, name the
// widest elements rather than only reporting a number.
function measureOverflow() {
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
  // A box can be the right width while the text inside it is not: an unbreakable run
  // overflows its container without changing the container's border box, so the loop
  // above never sees it. Report those separately.
  for (const element of document.querySelectorAll("body *")) {
    // An element that clips or scrolls its own content is doing so on purpose
    // (`truncate`, `overflow-x-auto`); only unhandled overflow is reported.
    if (getComputedStyle(element).overflowX !== "visible") continue;
    if (element.scrollWidth > element.clientWidth + 1 && element.clientWidth > 0) {
      offenders.push(
        `text-overflow <${element.tagName.toLowerCase()} ` +
          `class="${String(element.className).slice(0, 60)}"> scrollWidth=${element.scrollWidth} ` +
          `clientWidth=${element.clientWidth}`
      );
    }
  }
  return { viewportWidth, scrollWidth: document.documentElement.scrollWidth, offenders };
}

function resolve(path: string): string {
  return path
    .replace("{code}", fixture?.public_code ?? "")
    .replace("{activity}", String(fixture?.activity_id ?? ""))
    .replace("{round}", String(fixture?.round_id ?? ""))
    .replace("{singer}", String(fixture?.singer_id ?? ""));
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

  const found = await page.evaluate(measureOverflow);

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

  // WeChat lets the reader raise the system font size, and its own "care mode" is a
  // supported setting rather than an edge case. Everything here is sized in rem, so a
  // larger root font grows the whole layout — which is exactly when a width that just
  // fit starts overflowing. Measure that reflow rather than fighting the setting:
  // intercepting it would take a real accessibility option away from the reader.
  await page.evaluate((px) => {
    document.documentElement.style.fontSize = `${px}px`;
  }, LARGE_TEXT_PX);
  const scaled = await page.evaluate(measureOverflow);
  const scaledScrolls = scaled.scrollWidth > scaled.viewportWidth + 1;
  if (scaledScrolls) {
    await test.info().attach("overflow-large-text.png", {
      body: await page.screenshot(),
      contentType: "image/png",
    });
  }
  expect(
    scaledScrolls,
    `${path} scrolls sideways at ${scaled.viewportWidth}px once the reader raises the font ` +
      `size (scrollWidth ${scaled.scrollWidth}); widest elements: ` +
      `${scaled.offenders.join(" | ") || "(none reported)"}`
  ).toBe(false);
}
