# Live Judge Console Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Migrate the Plus Live staff workflow and Judge scoring page to the approved Signal Console layout without changing authority, realtime, or HTTP behavior.

**Architecture:** Keep all existing data fetching, commands, capability claiming, score validation, and realtime invalidation unchanged. Replace the Portal-era `studio-page`/`results-title` presentation with Console page headers, a Live main-column plus sticky control rail, and a single-column Judge scoring workspace.

**Tech Stack:** React 19, TypeScript, TanStack Query/Router, Vitest + Testing Library, Playwright, existing semantic CSS tokens in `plus/apps/web/src/styles/global.css`.

**Spec:** `docs/artflow-plus/specs/2026-10-28-visual-theme-family-and-console-shell-design.md` (Phase 3) and `docs/artflow-plus/specs/2026-10-26-m8d-live-judge-design.md`.

## Global Constraints

- Console routes use the `signal` theme and must not mount Aurora or Portal-only `results-title` presentation.
- Live keeps its existing session, round, roster, judge-link, lock, resolve, reset, and refresh behavior.
- Judge keeps capability claim, HttpOnly session use, polling, score validation, direct-jury submission, and HTTP completion behavior.
- Business state remains expressed by text, status labels, borders, and controls; color is not the only state signal.
- No new UI library, hard-coded business colors, backend change, realtime protocol change, or localStorage token storage.
- Verify with Plus web tests/check/build, DB-gated Plus checks/tests, affected Live/Judge Playwright smoke, and documentation checks; do not run the v1 full suite.

---

### Task 1: Add Live and Judge Console layout contract tests

**Files:**
- Create: `plus/apps/web/src/routes/live.test.tsx`
- Create: `plus/apps/web/src/routes/liveActivity.test.tsx`
- Create: `plus/apps/web/src/routes/judge.test.tsx`
- Create: `plus/apps/web/src/styles/live-judge-console.test.ts`

**Interfaces:**
- Consumes the current `LivePage`, `LiveActivityPage`, and `JudgePage` exports plus their existing API and auth modules.
- Produces failing tests that require `console-page-header`, `console-page-title`, `console-table-wrap`, `live-workspace`, `live-control-rail`, `judge-workspace`, and `judge-score-column`.

- [ ] **Step 1: Write the failing route tests**

  Mock TanStack hooks, auth wrappers, API functions, realtime, and child panels in the same style as `studio.test.tsx` and `studioActivity.test.tsx`. Assert:

  ```tsx
  expect(screen.getByRole("heading", { name: "活动" })).toHaveClass("console-page-title");
  expect(document.querySelector(".console-table-wrap")).not.toBeNull();
  expect(screen.getByRole("heading", { name: "春季现场" })).not.toHaveClass("results-title");
  expect(document.querySelector(".live-workspace")).not.toBeNull();
  expect(document.querySelector(".live-control-rail")).not.toBeNull();
  expect(document.querySelector(".judge-workspace")).not.toBeNull();
  expect(document.querySelector(".judge-score-column")).not.toBeNull();
  ```

  The Judge fixture must include one open performance, three rubric criteria, a scoring target, a seat, panel, and round so the real score form renders. Set `useSearch` to an empty object so the test remains in the already-claimed path and does not test capability claiming.

- [ ] **Step 2: Run the focused tests to verify RED**

  Run: `pnpm -C plus/apps/web test -- src/routes/live.test.tsx src/routes/liveActivity.test.tsx src/routes/judge.test.tsx src/styles/live-judge-console.test.ts`

  Expected: the tests fail because the current pages still render `results-title`/`studio-grid` and the new Console selectors do not exist. Fix only test setup errors if they occur; do not change production code before the expected assertion failures are visible.

- [ ] **Step 3: Commit the failing contract tests**

  ```powershell
  git add plus/apps/web/src/routes/live.test.tsx plus/apps/web/src/routes/liveActivity.test.tsx plus/apps/web/src/routes/judge.test.tsx plus/apps/web/src/styles/live-judge-console.test.ts
  git commit -m "test: define live judge console layout contracts"
  ```

### Task 2: Migrate Live route containers to Console layout

**Files:**
- Modify: `plus/apps/web/src/routes/live.tsx`
- Modify: `plus/apps/web/src/routes/liveActivity.tsx`

**Interfaces:**
- Consumes unchanged `fetchLiveActivities`, `fetchLiveState`, `hasLiveAccess`, `useRealtimeTopic`, and child panel props.
- Produces Live list and detail DOM with Console headers and the Live workspace/rail classes required by Task 1 and the visual spec.

- [ ] **Step 1: Replace Portal-era route presentation**

  In `live.tsx`, use a `console-state` wrapper for unauthorized/loading/error states, render a `console-page-header` with `h1.console-page-title`, and wrap the activity table in `.console-table-wrap` while retaining caption, links, columns, and values.

  In `liveActivity.tsx`, use `console-state` for route-level states, render `.console-page-header` and `h1.console-page-title`, keep the status/connection copy and ticketing warning, then replace `.studio-grid` with:

  ```tsx
  <div className="live-workspace">
    <main className="live-main-column live-rounds">...</main>
    <aside className="live-control-rail">
      <LiveSessionPanel ... />
      <section className="ops-card live-roster-card">...</section>
    </aside>
  </div>
  ```

  Keep `refresh`, query keys, fallback polling, child props, roster text, and every accessible action unchanged.

- [ ] **Step 2: Run the route contract tests to verify GREEN for Task 2**

  Run: `pnpm -C plus/apps/web test -- src/routes/live.test.tsx src/routes/liveActivity.test.tsx`

  Expected: Live list and Live detail tests pass; Judge and style tests remain failing until their tasks are implemented.

- [ ] **Step 3: Commit the Live route migration**

  ```powershell
  git add plus/apps/web/src/routes/live.tsx plus/apps/web/src/routes/liveActivity.tsx
  git commit -m "feat: move live routes into console workspace"
  ```

### Task 3: Migrate Judge scoring workspace and Live operational card semantics

**Files:**
- Modify: `plus/apps/web/src/routes/judge.tsx`
- Modify: `plus/apps/web/src/components/live/LiveSessionPanel.tsx`
- Modify: `plus/apps/web/src/components/live/LiveRoundPanel.tsx`

**Interfaces:**
- Consumes unchanged JudgeContext, scoring API, session API, round API, and callbacks.
- Produces a Judge single-column score workspace and stable semantic hooks for Console cards without changing the form field labels or button names used by E2E.

- [ ] **Step 1: Replace Judge presentation containers**

  Use `console-state` for claim/context loading and error states. In `JudgeContent`, render `.console-page-header` with `h1.console-page-title`, then a `.judge-workspace` containing a `.judge-score-column` with `ScoreCard` followed by a `.judge-status-panel` status card. Remove the Portal `results-title` class and the two-column `.studio-grid` dependency. Keep the score form, field labels, error text, polling, and `onScored` callback unchanged.

- [ ] **Step 2: Add Console semantic classes to Live child cards**

  Add `live-control-card` to the session card, `live-round-card` to each round card, and `console-card-title` to their operational headings. Add `live-roster-card` only to the existing roster card if it is not already supplied by the route. Do not change API calls, state transitions, button copy, test ids, or control order.

- [ ] **Step 3: Run the Judge and Live component contract tests to verify GREEN**

  Run: `pnpm -C plus/apps/web test -- src/routes/judge.test.tsx src/routes/live.test.tsx src/routes/liveActivity.test.tsx`

  Expected: all route tests pass, with the existing E2E-facing accessible names still present.

- [ ] **Step 4: Commit the Judge and component migration**

  ```powershell
  git add plus/apps/web/src/routes/judge.tsx plus/apps/web/src/components/live/LiveSessionPanel.tsx plus/apps/web/src/components/live/LiveRoundPanel.tsx
  git commit -m "feat: move judge scoring into console workspace"
  ```

### Task 4: Add Signal Console Live/Judge responsive styles and verify the full slice

**Files:**
- Modify: `plus/apps/web/src/styles/global.css`
- Modify: `plus/apps/web/src/styles/live-judge-console.test.ts`
- Modify: `docs/artflow-plus/specs/2026-10-28-visual-theme-family-and-console-shell-design.md`

**Interfaces:**
- Consumes the existing Signal semantic tokens and Console shell breakpoints.
- Produces a desktop Live main-column plus sticky 360px control rail, a mobile single-column Live layout, and a Judge score workspace capped at 720px with the status card below the score card.

- [ ] **Step 1: Add the failing style assertions**

  Assert the stylesheet contains `.live-workspace`, `.live-main-column`, `.live-control-rail`, `.judge-workspace`, `.judge-score-column`, `max-width: 720px`, `position: sticky`, the 360px rail declaration, and a `@media (max-width: 1023px)` single-column rule. Run the style test and confirm it fails before editing CSS.

- [ ] **Step 2: Implement semantic-token-only styles**

  Add styles in the existing Console section of `global.css`:

  ```css
  .console-page .live-workspace {
    display: grid;
    grid-template-columns: minmax(0, 1fr) 360px;
    gap: 16px;
    align-items: start;
  }

  .console-page .live-control-rail {
    position: sticky;
    top: 80px;
    display: grid;
    gap: 16px;
  }

  .console-page .judge-workspace {
    width: min(100%, 720px);
    margin: 0 auto;
  }
  ```

  Use only existing `--color-*`, `--font-console`, and spacing/layout values; ensure cards have no Portal shadow or backdrop filter. At the existing 1023px Console breakpoint, make both workspaces one column and return the Live rail to normal flow. Preserve 40px controls and visible focus styles inherited from Console.

- [ ] **Step 3: Update the design spec status and roadmap note**

  Change the visual design spec status to `Phase 3 implemented` and record that Live uses a sticky operational rail while Judge uses a 720px single-column score workspace. State explicitly that authority, realtime, and HTTP paths were not changed.

- [ ] **Step 4: Run focused style and route tests**

  Run: `pnpm -C plus/apps/web test -- src/routes/live.test.tsx src/routes/liveActivity.test.tsx src/routes/judge.test.tsx src/styles/live-judge-console.test.ts`

  Expected: all focused tests pass.

- [ ] **Step 5: Run the Plus verification slice**

  Run from the repository root:

  ```powershell
  pnpm -C plus/apps/web test
  pnpm -C plus/apps/web run check
  pnpm -C plus/apps/web build
  $env:ARTFLOW_PLUS_DATABASE_URL = "postgresql://artflow:artflow_dev@127.0.0.1:5433/artflow_plus"
  $env:REQUIRE_DB = "1"
  pnpm -C plus run check
  pnpm -C plus run test
  pnpm -C plus/apps/web test:e2e -- e2e/live-judge.spec.ts
  pwsh -NoProfile -File scripts/check_docs.ps1
  git diff --check
  ```

  Expected: web tests/check/build, DB-gated Plus checks/tests, Live/Judge E2E, docs, and whitespace verification exit 0. The build may repeat the known non-blocking Aurora chunk-size warning; record it without changing unrelated bundling.

- [ ] **Step 6: Perform self-review and commit the verified slice**

  Review the diff for unchanged API imports, authority boundaries, accessible labels, no `results-title` in Live/Judge, no raw color literals, and mobile layout coverage. Then run `git status --short` and commit:

  ```powershell
  git add plus/apps/web/src/styles/global.css plus/apps/web/src/styles/live-judge-console.test.ts docs/artflow-plus/specs/2026-10-28-visual-theme-family-and-console-shell-design.md
  git commit -m "style: finish live judge console migration"
  ```

## Completion Handoff

After the feature branch is verified, merge it into `artflow-plus` with a non-fast-forward merge, push `artflow-plus`, verify local and remote heads match, and delete only the feature branch. The next planned phase is Join / Registration / Vote migration; it is not part of this change.
