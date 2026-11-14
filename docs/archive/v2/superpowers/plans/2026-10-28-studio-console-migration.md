# Studio Console Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Migrate the existing Studio list, creation, and activity workspace onto the `Signal` Console layout with a dense editor main column and sticky operational rail.

**Architecture:** Keep all Studio data fetching, permissions, idempotency keys, mutation handlers, and error semantics unchanged. Only introduce Console page-header/card contracts in routes and studio panels, then scope the existing Studio grid to a 1fr + 360px rail layout under `.console-page`; the Portal shell remains untouched.

**Tech Stack:** React 19, TypeScript 7, TanStack Router/Query, Vitest + Testing Library, CSS custom properties.

**Spec:** `docs/artflow-plus/specs/2026-10-28-visual-theme-family-and-console-shell-design.md` and `docs/artflow-plus/specs/2026-10-26-m8c-studio-design.md`

## Global Constraints

- Work only in `plus/`; do not modify the Django v1 line.
- Preserve Studio API calls, permission guards, idempotency keys, and mutation behavior.
- Console uses `data-theme="signal"`; Studio must not reintroduce `results-title`, Portal hero typography, Aurora, or full-screen blur.
- Studio detail uses a main editor column plus a roughly 360px sticky rail on desktop; rail moves below on narrow screens.
- New Studio styling consumes the existing semantic Console tokens and shared button classes.
- Verify with Plus tests and affected Chromium E2E only; do not run v1 full tests or real rehearsal/cutover.

---

### Task 1: Add Studio route structure tests

**Files:**
- Create: `plus/apps/web/src/routes/studio.test.tsx`
- Create: `plus/apps/web/src/routes/studioActivity.test.tsx`
- Create: `plus/apps/web/src/routes/studioNew.test.tsx`

**Interfaces:**
- Tests render the existing route components with mocked Query/Router/session boundaries.
- List and creation routes must expose `.console-page-header`, `.console-page-title`, and `.console-table-wrap` where a table exists.
- Activity route must expose `.console-page-title`, `.studio-workspace`, `.studio-main-column`, and `.studio-rail` without changing visible business actions.

- [ ] **Step 1: Write failing tests for Studio list and creation headers**

Use one fixture activity and one fixture pack. Assert the list heading is not `results-title`, the activity table is wrapped, and the creation page heading is `console-page-title`.

```tsx
expect(screen.getByRole("heading", { name: "活动" })).toHaveClass("console-page-title");
expect(screen.getByRole("heading", { name: "活动" })).not.toHaveClass("results-title");
expect(document.querySelector(".console-table-wrap")).not.toBeNull();
```

- [ ] **Step 2: Run the focused tests and confirm they fail against current Portal display classes**

Run: `pnpm -C plus/apps/web exec vitest run src/routes/studio.test.tsx src/routes/studioNew.test.tsx`

Expected: FAIL because the current routes use `display results-title` and the list table has no Console wrapper.

- [ ] **Step 3: Write a failing activity workspace test**

Mock the three child panels, return a real `StudioState`, and assert the route contains the title plus `.studio-workspace`, `.studio-main-column`, and `.studio-rail`.

- [ ] **Step 4: Run the focused activity test and confirm it fails because the current grid has no new structure**

Run: `pnpm -C plus/apps/web exec vitest run src/routes/studioActivity.test.tsx`

Expected: FAIL on the missing workspace/column selectors.

### Task 2: Migrate Studio list and creation routes

**Files:**
- Modify: `plus/apps/web/src/routes/studio.tsx`
- Modify: `plus/apps/web/src/routes/studioNew.tsx`

**Interfaces:**
- `StudioPage` keeps the same `fetchStudioActivities` query, `hasStudioAccess` guard, link targets, and empty/error copy.
- `StudioNewPage` keeps the same `fetchPacks`, preview, create, navigate, and form state behavior.
- Both routes use `.console-page-header` and `.console-page-title`; list tables use `.console-table-wrap`.

- [ ] **Step 1: Replace only the list and creation heading classes/wrappers**

Use `console-page-header`, `console-page-title`, and `console-table-wrap`. Keep the existing `primary-button` link and form controls so the Signal Console overrides apply.

- [ ] **Step 2: Run the focused list/creation tests and confirm they pass**

Run: `pnpm -C plus/apps/web exec vitest run src/routes/studio.test.tsx src/routes/studioNew.test.tsx`

Expected: all route structure tests pass and no query/mutation assertion changes are needed.

- [ ] **Step 3: Run TypeScript check**

Run: `pnpm -C plus/apps/web run check`

Expected: zero diagnostics.

- [ ] **Step 4: Commit the list/creation migration**

```powershell
git add plus/apps/web/src/routes/studio.tsx plus/apps/web/src/routes/studioNew.tsx plus/apps/web/src/routes/studio.test.tsx plus/apps/web/src/routes/studioNew.test.tsx
git commit -m "feat: migrate studio list and creation to console"
```

### Task 3: Migrate the Studio activity workspace

**Files:**
- Modify: `plus/apps/web/src/routes/studioActivity.tsx`
- Modify: `plus/apps/web/src/components/studio/DefinitionEditor.tsx`
- Modify: `plus/apps/web/src/components/studio/ReleasePanel.tsx`
- Modify: `plus/apps/web/src/components/studio/SessionPanel.tsx`

**Interfaces:**
- `StudioActivityPage` keeps its current `fetchStudioState`, activation flow, refresh invalidations, and access guard.
- The route renders `.studio-workspace` containing `.studio-main-column` for `DefinitionEditor` and `.studio-rail` for `ReleasePanel`, `SessionPanel`, and `GuidedSummary`.
- The panels preserve all API calls and action labels; only card heading classes and outer semantic classes change.

- [ ] **Step 1: Add the page header and workspace containers**

Move the activity link/status/title into `.console-page-header`; replace `display results-title` with `console-page-title`; wrap editor and rail children without changing their props.

- [ ] **Step 2: Add shared Console card heading classes to all Studio panels**

Use `console-card-title` on Definition, Release, Session, Guided, and creation panel headings where appropriate. Keep the editor textarea `aria-label="Definition Package JSON"` and all button names unchanged.

- [ ] **Step 3: Run activity route tests and type-check**

Run: `pnpm -C plus/apps/web exec vitest run src/routes/studioActivity.test.tsx`  
Run: `pnpm -C plus/apps/web run check`

Expected: tests pass and TypeScript reports zero diagnostics.

- [ ] **Step 4: Commit the activity workspace migration**

```powershell
git add plus/apps/web/src/routes/studioActivity.tsx plus/apps/web/src/components/studio
git commit -m "feat: arrange studio workspace as console main and rail"
```

### Task 4: Add Studio Console layout and style contracts

**Files:**
- Modify: `plus/apps/web/src/styles/global.css`
- Create: `plus/apps/web/src/styles/studio-console.test.ts`

**Interfaces:**
- `.console-page .studio-grid` is a main + 360px rail grid on desktop.
- `.studio-main-column` is min-width-safe; `.studio-rail` is sticky below the Console topbar and becomes normal flow on narrow screens.
- Editor, release/session lists, inputs, and cards consume `--color-*` tokens; no new hardcoded business colors are introduced.

- [ ] **Step 1: Write failing CSS contract tests**

```ts
const global = await readFile(join(process.cwd(), "src", "styles", "global.css"), "utf8");
expect(global).toContain(".studio-main-column");
expect(global).toContain(".studio-rail");
expect(global).toContain("grid-template-columns: minmax(0, 1fr) 360px");
```

- [ ] **Step 2: Run the style test and confirm it fails**

Run: `pnpm -C plus/apps/web exec vitest run src/styles/studio-console.test.ts`

Expected: FAIL because the new Studio selectors do not exist.

- [ ] **Step 3: Add scoped Studio Console styles**

Use `--color-page`, `--color-surface`, `--color-surface-raised`, `--color-line`, and `--color-text-muted`; set editor min-height to at least 520px; remove Portal shadows/blur through Console-specific overrides; add a 1023px breakpoint that moves the rail below the editor.

- [ ] **Step 4: Run style tests and web tests**

Run: `pnpm -C plus/apps/web exec vitest run src/styles/studio-console.test.ts src/routes/studio.test.tsx src/routes/studioActivity.test.tsx src/routes/studioNew.test.tsx`  
Run: `pnpm -C plus/apps/web test`

Expected: focused tests and the complete Web Vitest suite pass.

- [ ] **Step 5: Commit the Studio Console styles**

```powershell
git add plus/apps/web/src/styles/global.css plus/apps/web/src/styles/studio-console.test.ts
git commit -m "feat: style studio workspace for signal console"
```

### Task 5: Verify Studio behavior and integrate

**Files:**
- Modify: `docs/artflow-plus/specs/2026-10-28-visual-theme-family-and-console-shell-design.md` only to record Phase 2 status.
- Modify: `docs/artflow-plus/README.md` only if the Studio visual milestone link needs an index entry.

- [ ] **Step 1: Run Plus checks and DB-gated tests**

```powershell
$env:ARTFLOW_PLUS_DATABASE_URL = "postgresql://artflow:artflow_dev@127.0.0.1:5433/artflow_plus"
$env:REQUIRE_DB = "1"
pnpm -C plus run check
pnpm -C plus run test
pnpm -C plus/apps/web run build
```

- [ ] **Step 2: Run Studio Chromium E2E and verify existing actions**

Run: `pnpm -C plus/apps/web test:e2e -- e2e/studio.spec.ts`

Expected: Studio can still create, activate, compile, release, start rehearsal, and close a session; no business action is blocked by the layout migration.

- [ ] **Step 3: Run docs/diff hygiene**

Run: `pwsh -NoProfile -File scripts/check_docs.ps1; git diff --check; git status --short`

Expected: docs pass, no diff errors, and only scoped files are changed.

- [ ] **Step 4: Perform React review and commit documentation status**

Check hooks remain top-level, actions are not recreated as nested components, interactive controls retain labels, and the rail does not introduce a data-fetch waterfall. Commit any status-only documentation update with `docs: record studio console phase two`.

- [ ] **Step 5: Merge and push**

```powershell
git switch artflow-plus
git pull --ff-only origin artflow-plus
git merge --no-ff feat/studio-console-migration -m "merge: migrate studio to console workspace"
git push origin artflow-plus
```

## Self-review checklist

- Spec coverage: Studio list/new/detail requirements are covered by Tasks 1–3; Console density/rail and token requirements by Task 4; E2E/API preservation by Task 5.
- Placeholder scan: no unresolved placeholder or unspecified selector remains in the task steps.
- Type consistency: route tests consume the same class contracts emitted by routes; the workspace names are shared between the route markup and CSS contract test.
- Scope review: no backend file, authority behavior, realtime core, Portal component, or v1 file is modified.
