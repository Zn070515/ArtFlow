# Visual Theme Family and Console Shell Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the first ArtFlow-Plus visual-system slice: semantic `afterglow`/`signal` theme presets, route-aware Portal/Console shells, and the Ops list/detail/registration layouts.

**Architecture:** Keep the existing Portal markup and Aurora behavior inside a dedicated `PortalShell`. Add a separate `ConsoleShell` with a compact topbar, permission-aware sidebar, responsive main container, and `data-theme="signal"`. A small pure route classifier decides which shell owns the current pathname; business routes keep their existing data fetching and mutation behavior.

**Tech Stack:** React 19, TypeScript 7, TanStack Router, Vitest + Testing Library, CSS custom properties, pnpm workspace.

**Spec:** `docs/artflow-plus/specs/2026-10-28-visual-theme-family-and-console-shell-design.md`

## Global Constraints

- Work only in `plus/`; do not modify the Django v1 line.
- Keep Portal `Afterglow` behavior and public data/authority flows unchanged.
- Console must not mount `AuroraScene`.
- New business styling consumes semantic tokens; do not add route-level hardcoded color literals.
- Console H1 is at most 32px; interaction targets are at least 40px; focus remains visible.
- Keep API, permissions, route paths, and mutation behavior unchanged.
- Verify with Plus checks/tests only; do not run the v1 full test suite.

---

### Task 1: Add route-surface classification and tests

**Files:**
- Create: `plus/apps/web/src/components/shell/routeSurface.ts`
- Test: `plus/apps/web/src/components/shell/routeSurface.test.ts`

**Interfaces:**
- Produces `getShellSurface(pathname: string): "portal" | "console"` for `RootLayout`.
- Console prefixes are `/ops`, `/studio`, `/live`, `/judge`, `/join`, and `/login`.
- All other paths, including `/`, `/results/*`, `/vote/*`, and `/claim`, use Portal.

- [ ] **Step 1: Write the failing tests**

```ts
import { describe, expect, it } from "vitest";

import { getShellSurface } from "./routeSurface.js";

describe("getShellSurface", () => {
  it.each(["/ops", "/ops/activity-1", "/studio", "/live/act-1", "/judge/public-code", "/join", "/login"]) (
    "assigns %s to the Console shell",
    (pathname) => {
      expect(getShellSurface(pathname)).toBe("console");
    },
  );

  it.each(["/", "/results/public-code", "/vote/session-1", "/claim", "/unknown"]) (
    "assigns %s to the Portal shell",
    (pathname) => {
      expect(getShellSurface(pathname)).toBe("portal");
    },
  );

  it("does not treat a similarly named path as a Console route", () => {
    expect(getShellSurface("/ops-extra")).toBe("portal");
  });
});
```

- [ ] **Step 2: Run the focused test and confirm the expected missing-module failure**

Run: `pnpm -C plus/apps/web exec vitest run src/components/shell/routeSurface.test.ts`

Expected: FAIL because `routeSurface.ts` does not exist yet.

- [ ] **Step 3: Implement the minimal classifier**

```ts
const consolePrefixes = ["/ops", "/studio", "/live", "/judge", "/join", "/login"] as const;

export function getShellSurface(pathname: string): "portal" | "console" {
  return consolePrefixes.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`))
    ? "console"
    : "portal";
}
```

- [ ] **Step 4: Run the focused test and confirm it passes**

Run: `pnpm -C plus/apps/web exec vitest run src/components/shell/routeSurface.test.ts`

Expected: all route-surface cases pass.

- [ ] **Step 5: Commit the classifier**

```powershell
git add plus/apps/web/src/components/shell/routeSurface.ts plus/apps/web/src/components/shell/routeSurface.test.ts
git commit -m "test: classify portal and console routes"
```

### Task 2: Extract Portal shell and build the Console shell

**Files:**
- Create: `plus/apps/web/src/components/shell/PortalShell.tsx`
- Create: `plus/apps/web/src/components/shell/ConsoleShell.tsx`
- Test: `plus/apps/web/src/components/shell/shell.test.tsx`
- Modify: `plus/apps/web/src/routes/__root.tsx`

**Interfaces:**
- `PortalShell({ children }: { readonly children: ReactNode }): JSX.Element` preserves the existing public header, navigation, footer, and conditional `AuroraScene` behavior.
- `ConsoleShell({ children }: { readonly children: ReactNode }): JSX.Element` renders a `data-shell="console" data-theme="signal"` wrapper, `topbar`, `sidebar`, and `main` region.
- `ConsoleShell` exposes links to Ops, Studio, and Live only when the existing session access helpers permit them; it keeps logout behavior unchanged.
- `RootLayout` uses `useLocation().pathname` and `getShellSurface()` to choose exactly one shell.

- [ ] **Step 1: Write failing shell tests**

Test the public contract with mocked router/session dependencies:

```tsx
it("renders Console navigation and marks the current section", () => {
  locationMock.mockReturnValue({ pathname: "/ops/activity-1" });
  useSessionMock.mockReturnValue(sessionWithOpsAccess);

  render(<ConsoleShell><p>page</p></ConsoleShell>);

  expect(document.querySelector('[data-shell="console"][data-theme="signal"]')).not.toBeNull();
  expect(screen.getByRole("navigation", { name: "Console 主导航" })).toBeInTheDocument();
  expect(screen.getByRole("link", { name: "Ops" })).toHaveAttribute("aria-current", "page");
  expect(screen.getByText("page")).toBeInTheDocument();
});

it("keeps Portal branding and exposes the public navigation", () => {
  render(<PortalShell><p>public page</p></PortalShell>);

  expect(screen.getByLabelText("ArtFlow 赛果公示首页")).toBeInTheDocument();
  expect(screen.getByRole("link", { name: "报名" })).toBeInTheDocument();
  expect(screen.getByText("public page")).toBeInTheDocument();
});
```

- [ ] **Step 2: Run the shell test and confirm it fails for missing shell exports**

Run: `pnpm -C plus/apps/web exec vitest run src/components/shell/shell.test.tsx`

Expected: FAIL because the shell components do not exist yet.

- [ ] **Step 3: Implement `PortalShell` by moving the existing RootLayout shell markup without changing public copy or session behavior**

Keep `AuroraScene` and `useReducedMotion` inside PortalShell. Pass `children` into the existing `site-main` region and keep the footer below it.

- [ ] **Step 4: Implement `ConsoleShell` with permission-aware navigation and mobile menu state**

Use a single `useState(false)` for the mobile menu, close it on link activation, and render a real button with an accessible label. Use existing `hasOpsAccess`, `hasStudioAccess`, and `hasLiveAccess`; never infer access from the route alone.

- [ ] **Step 5: Switch `RootLayout` to the route-aware shells**

```tsx
const { pathname } = useLocation();
const shell = getShellSurface(pathname);

return shell === "console" ? (
  <ConsoleShell><Outlet /></ConsoleShell>
) : (
  <PortalShell><Outlet /></PortalShell>
);
```

- [ ] **Step 6: Run the focused shell tests and confirm they pass**

Run: `pnpm -C plus/apps/web exec vitest run src/components/shell/routeSurface.test.ts src/components/shell/shell.test.tsx`

Expected: all focused shell tests pass with no console errors.

- [ ] **Step 7: Commit the shell split**

```powershell
git add plus/apps/web/src/components/shell plus/apps/web/src/routes/__root.tsx
git commit -m "feat: split portal and console shells"
```

### Task 3: Add semantic theme presets and Console layout styles

**Files:**
- Modify: `plus/apps/web/src/styles/tokens.css`
- Modify: `plus/apps/web/src/styles/global.css`
- Test: `plus/apps/web/src/styles/theme.test.ts`

**Interfaces:**
- `data-theme="afterglow"` maps existing Portal values to semantic roles without breaking current classes.
- `data-theme="signal"` provides Console page/surface/text/line/accent/status roles.
- `.console-shell`, `.console-topbar`, `.console-sidebar`, `.console-main`, `.console-page`, `.console-page-header`, `.console-page-title`, and `.console-table-wrap` provide the Console layout contract.

- [ ] **Step 1: Write failing token/layout assertions**

The test should render a small element with each theme attribute and assert the attributes and class contract are present; it should also assert the CSS source declares both presets and the required Console layout selectors.

```ts
import { readFile } from "node:fs/promises";
import { join } from "node:path";

const stylesDirectory = join(process.cwd(), "src", "styles");

it("declares both theme presets and Console layout roles", async () => {
  const css = await readFile(join(stylesDirectory, "tokens.css"), "utf8");
  const globalCss = await readFile(join(stylesDirectory, "global.css"), "utf8");

  expect(css).toContain('[data-theme="afterglow"]');
  expect(css).toContain('[data-theme="signal"]');
  expect(css).toContain("--color-surface-raised");
  expect(globalCss).toContain(".console-shell");
  expect(globalCss).toContain(".console-table-wrap");
});
```

- [ ] **Step 2: Run the focused style test and confirm the expected missing-selector failure**

Run: `pnpm -C plus/apps/web exec vitest run src/styles/theme.test.ts`

Expected: FAIL because the semantic presets and Console selectors have not been added.

- [ ] **Step 3: Add semantic token scopes**

Keep existing primitive aliases for Portal compatibility. Add `[data-theme="afterglow"]` and `[data-theme="signal"]` with page, surface, text, line, accent, focus, and status roles. Use opaque Console surfaces and avoid `backdrop-filter` in Console selectors.

- [ ] **Step 4: Add responsive Console layout CSS**

Implement a 56px topbar, 240px desktop sidebar, 220px medium sidebar, collapsed/mobile navigation, 1440px content cap, 24px gutters, 40px controls, visible focus, sticky table header, and horizontal table overflow. Keep the existing Portal selectors unchanged except for safe semantic aliases.

- [ ] **Step 5: Run the focused style test and confirm it passes**

Run: `pnpm -C plus/apps/web exec vitest run src/styles/theme.test.ts`

Expected: all theme/layout assertions pass.

- [ ] **Step 6: Commit theme and shell styles**

```powershell
git add plus/apps/web/src/styles/tokens.css plus/apps/web/src/styles/global.css plus/apps/web/src/styles/theme.test.ts
git commit -m "feat: add signal console theme tokens"
```

### Task 4: Migrate the Ops list, activity detail, and registration detail

**Files:**
- Modify: `plus/apps/web/src/routes/ops.tsx`
- Modify: `plus/apps/web/src/routes/opsActivity.tsx`
- Modify: `plus/apps/web/src/routes/opsRegistration.tsx`
- Modify: `plus/apps/web/src/components/ops/RegistrationTable.tsx`
- Modify: `plus/apps/web/src/components/ops/GroupingCard.tsx`
- Modify: `plus/apps/web/src/components/ops/RosterCard.tsx`
- Modify: `plus/apps/web/src/components/ops/VotingCard.tsx`
- Modify: `plus/apps/web/src/components/ops/ReviewPanel.tsx`
- Test: existing web route/component tests as needed for changed accessible names

**Interfaces:**
- Ops routes keep the same query keys, API functions, permission checks, mutation handlers, links, and error states.
- Each route uses `.console-page` and `.console-page-header`; Ops list uses `.console-table-wrap`.
- Internal headings use `.console-page-title` or `.console-card-title`, never `display results-title`.
- Status labels use a semantic class/token rather than new literal colors.

- [ ] **Step 1: Add route-level regression assertions before changing markup**

Extend the nearest existing route tests, or add focused tests where no route test exists, to assert that the new page contract exposes `main` content with an Ops page heading and no `results-title` class. Keep API mocks and existing mutation assertions unchanged.

- [ ] **Step 2: Run the focused Ops tests and confirm the new assertions fail**

Run: `pnpm -C plus/apps/web exec vitest run src/routes/ops.test.tsx src/routes/opsActivity.test.tsx src/routes/opsRegistration.test.tsx`

Expected: existing missing-test paths may be reported as unavailable; if a route has no test file, create the focused test first and then observe the assertion failure against current markup.

- [ ] **Step 3: Migrate Ops page headers and table wrapper**

Replace only the internal display classes and wrappers. Use a compact title, status/count metadata, and a table overflow wrapper; do not add search/pagination behavior in this slice unless the existing API already supports it.

- [ ] **Step 4: Migrate detail layout classes without changing business children**

Keep `RegistrationTable`, `RosterCard`, `GroupingCard`, `VotingCard`, and `ReviewPanel` logic intact. Give their outer cards semantic Console card classes and fix only class-name aliases needed for the new token contract.

- [ ] **Step 5: Run focused web tests and type-check**

Run: `pnpm -C plus/apps/web test`  
Run: `pnpm -C plus/apps/web run check`

Expected: web tests pass and TypeScript reports zero diagnostics.

- [ ] **Step 6: Commit the Ops migration**

```powershell
git add plus/apps/web/src/routes/ops.tsx plus/apps/web/src/routes/opsActivity.tsx plus/apps/web/src/routes/opsRegistration.tsx plus/apps/web/src/components/ops
git commit -m "feat: migrate ops pages to console shell"
```

### Task 5: Verify the Phase 1 contract and prepare handoff

**Files:**
- Modify: `docs/artflow-plus/specs/2026-10-28-visual-theme-family-and-console-shell-design.md` only if implementation status or acceptance notes need updating.

- [ ] **Step 1: Run the targeted tests and static checks**

Run:

```powershell
pnpm -C plus/apps/web test
pnpm -C plus/apps/web run check
pnpm -C plus run check
pnpm -C plus run test
```

Expected: all Plus packages pass; no v1 test suite is run.

- [ ] **Step 2: Inspect the rendered app with the local service**

Start the existing Plus API/web services as required by the repository instructions, open `/ops`, `/ops/<activityId>`, `/ops/<activityId>/registrations/<registrationId>`, `/`, and `/results/<publicCode>` in a headless Chromium smoke run, and confirm:

- Portal still renders its public header and does not lose Aurora behavior.
- Ops renders `signal`, has one topbar/sidebar/main structure, and does not load the Aurora component.
- 390px viewport has no document-level horizontal overflow.
- Ops table has a scroll wrapper and detail cards do not overlap.

- [ ] **Step 3: Run diff hygiene and review the plan checklist**

Run: `git diff --check; git status --short`

Confirm every plan item is checked, no unrelated file changed, and the branch is ready for the repository’s required merge/push workflow.

- [ ] **Step 4: Commit only documentation updates if needed**

```powershell
git add docs/artflow-plus/specs/2026-10-28-visual-theme-family-and-console-shell-design.md
git commit -m "docs: record visual phase one verification"
```

## Self-review checklist

- Spec coverage: theme family and preset names are covered by Tasks 3 and 5; shell split by Tasks 1–2; Ops migration by Task 4; later Studio/Live/Judge work remains documented in the spec and intentionally out of this plan.
- Placeholder scan: no implementation step depends on an unspecified token name, route, or test command.
- Type consistency: `getShellSurface` returns the exact union consumed by `RootLayout`; shell props use readonly `ReactNode`; theme selectors match `data-theme` attributes emitted by both shells.
- Scope review: this plan does not alter API contracts, authority services, realtime core, or v1 code.
