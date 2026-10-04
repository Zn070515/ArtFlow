// Touch-target audit. Runs against the same pages and the same device projects as the
// layout audit, and answers a different question: on a phone, can a person actually hit
// these controls while a show is running?
//
// GOAL §13.2 makes the phone a first-class on-site terminal — check-in, the vote switch,
// judge connection, incident notes — and staff are tapping these one-handed, in a dark
// room, in a hurry.
//
// The gate is the WCAG 2.2 AA minimum, 24x24 CSS px (2.5.8) — not the 44x44 a native app
// would use. Measured on 2026-10-05: at 44px, 489 of 529 standalone controls miss the bar,
// which is not a gate but a rewrite of nearly every control in the app; at 24px the number
// is 172, concentrated in a handful of shared patterns, which is a gate that can be held.
// Raise the bar with the env var once that debt is paid.
//
//   PLAYWRIGHT_TOUCH_MIN_PX=44 npm run test:e2e   # the stricter native-app bar, as a probe
//
// Targets are measured at the default font size, which is the worst case: they are sized
// in rem, so raising the reader's font size makes them larger, not smaller.

import { expect, test } from "@playwright/test";

import { FIXTURE_TARGETS, PUBLIC_TARGETS, loadFixture, makeResolver } from "./layout-targets";

const MIN_TARGET_PX = Number(process.env.PLAYWRIGHT_TOUCH_MIN_PX ?? 24);
const REPORT_LIMIT = 8;

const fixture = loadFixture();
const resolve = makeResolver(fixture);

// Runs in the browser: every control a finger is meant to hit, with its tappable box.
//
// WCAG 2.5.8 carries an explicit "inline" exception: a link sitting in a sentence is
// bounded by that sentence's line-height, so it is not a target the rule applies to. Its
// computed display is the reliable signal — a standalone action link is blockified by its
// container, an inline one is not.
function measureTargets(minPx: number) {
  const selector = "a[href], button, input:not([type=hidden]), select, textarea, summary, [role=button]";
  const tooSmall: { label: string; width: number; height: number }[] = [];
  let considered = 0;

  for (const element of document.querySelectorAll<HTMLElement>(selector)) {
    const rect = element.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) continue;
    const style = getComputedStyle(element);
    if (style.visibility === "hidden" || style.display === "none") continue;
    if (element.tagName === "A" && style.display === "inline") continue;
    // A control inside a closed <details> or an off-canvas panel is not reachable yet.
    if (element.closest("details:not([open])")) continue;
    considered += 1;
    if (rect.width >= minPx && rect.height >= minPx) continue;
    tooSmall.push({
      label: `${element.tagName.toLowerCase()}${
        element.id ? `#${element.id}` : ""
      } "${(element.textContent || element.getAttribute("name") || "").trim().slice(0, 24)}"`,
      width: Math.round(rect.width),
      height: Math.round(rect.height),
    });
  }
  tooSmall.sort((a, b) => Math.min(a.width, a.height) - Math.min(b.width, b.height));
  return { considered, count: tooSmall.length, smallest: tooSmall.slice(0, 8) };
}

for (const target of PUBLIC_TARGETS) {
  test(`touch: ${target.name}`, async ({ page }) => {
    await assertTargets(page, resolve(target.path));
  });
}

for (const target of FIXTURE_TARGETS) {
  test(`touch: ${target.name}`, async ({ page, context }) => {
    test.skip(!fixture, "PLAYWRIGHT_LAYOUT_FIXTURE_PATH is not set");
    if (target.staff && fixture) {
      await context.addCookies([
        { name: "sessionid", value: fixture.session_key, url: test.info().project.use.baseURL! },
      ]);
    }
    await assertTargets(page, resolve(target.path));
  });
}

async function assertTargets(page: import("@playwright/test").Page, path: string) {
  await page.goto(path, { waitUntil: "load" });
  await page.evaluate(() => document.fonts.ready);
  const measured = await page.evaluate(measureTargets, MIN_TARGET_PX);

  const detail =
    `${path}: ${measured.count} of ${measured.considered} controls are smaller than ` +
    `${MIN_TARGET_PX}px. Smallest: ` +
    measured.smallest
      .slice(0, REPORT_LIMIT)
      .map((t) => `${t.label} ${t.width}x${t.height}`)
      .join(" | ");

  if (measured.count > 0) {
    await test.info().attach("touch-targets.png", {
      body: await page.screenshot(),
      contentType: "image/png",
    });
  }
  expect(measured.count, detail).toBe(0);
}
