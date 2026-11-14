# Phase 1–5 High-Review Remediation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close every actionable finding from the Phase 1–5 high review while preserving the existing authority, API, file-storage, realtime, and HTTP completion paths.

**Architecture:** Keep Portal and Console as separate route-aware shells. Make backdrop selection explicit by route, make Console consume semantic Signal tokens, and add client-side table controls over the existing fetched collections without changing API contracts. Use CSS visibility plus keyboard state management for the mobile Console navigation, and keep all review fixes covered by focused component/style tests and the existing browser journeys.

**Tech Stack:** React 19, TanStack Router/Query, TypeScript, Vitest, Playwright, CSS custom properties, Vite.

**Spec:** `docs/artflow-plus/specs/2026-10-28-visual-theme-family-and-console-shell-design.md`

## Global Constraints

- Do not change Plus API contracts, command handlers, authority rules, file storage, realtime protocol, or HTTP fallback behavior.
- Portal uses `afterglow`; Console uses `signal`; component CSS consumes semantic tokens instead of raw Portal primitives.
- Aurora is mounted only for `/` and `/results/*`; `/vote/*` uses a static backdrop; other Portal routes do not mount a decorative scene.
- Console interaction targets remain at least 40px; hidden mobile navigation must not remain keyboard-focusable.
- Run Plus checks/tests only; do not run the v1 full suite.
- Use TDD for every behavior change: failing test first, then minimal implementation, then focused verification.

### Task 1: Route-scoped shells and mobile navigation accessibility

**Files:**
- Modify: `plus/apps/web/src/components/shell/PortalShell.tsx`
- Modify: `plus/apps/web/src/components/shell/ConsoleShell.tsx`
- Modify: `plus/apps/web/src/components/shell/routeSurface.ts`
- Modify: `plus/apps/web/src/components/shell/shell.test.tsx`
- Modify: `plus/apps/web/src/components/shell/routeSurface.test.ts`
- Modify: `plus/apps/web/src/styles/global.css`
- Modify: `plus/apps/web/src/styles/theme.test.ts`

**Interfaces:**
- `PortalShell` continues to render the existing children and `data-theme="afterglow"`; it receives only pathname-derived backdrop mode.
- `ConsoleShell` continues to expose the existing navigation and logout behavior; it adds explicit `Judge`, `报名`, and `登录` context labels and keyboard-safe menu state.

- [ ] **Step 1: Write failing shell tests**

Add tests for:

```tsx
it("does not mount Aurora for claim routes", () => {
  locationMock.mockReturnValue({ pathname: "/claim" });
  render(<PortalShell><p>claim</p></PortalShell>);
  expect(screen.queryByTestId("aurora-scene")).not.toBeInTheDocument();
  expect(screen.queryByTestId("static-backdrop")).not.toBeInTheDocument();
});

it("closes the mobile navigation with Escape and restores the trigger focus", async () => {
  render(<ConsoleShell><p>page</p></ConsoleShell>);
  const toggle = screen.getByRole("button", { name: "打开 Console 导航" });
  await userEvent.click(toggle);
  await userEvent.keyboard("{Escape}");
  expect(toggle).toHaveAttribute("aria-expanded", "false");
  expect(document.activeElement).toBe(toggle);
});

it.each([
  ["/judge/public-code", "Judge · 评分"],
  ["/join", "报名 · 参与者"],
  ["/login", "登录"],
])("labels %s as %s", (pathname, label) => {
  locationMock.mockReturnValue({ pathname });
  render(<ConsoleShell><p>page</p></ConsoleShell>);
  expect(screen.getByLabelText("当前工作区")).toHaveTextContent(label);
});
```

- [ ] **Step 2: Run the focused shell tests and confirm RED**

Run: `pnpm -C plus/apps/web test -- src/components/shell/shell.test.tsx src/components/shell/routeSurface.test.ts`

Expected: failures for claim backdrop, Escape focus restoration, and the three missing context labels.

- [ ] **Step 3: Implement route-scoped backdrop and menu behavior**

Use explicit pathname checks in `PortalShell`: `/` and `/results/*` render the animated `AuroraScene`, `/vote/*` renders the existing static backdrop, and all other Portal routes render no scene. Add a menu button ref, an Escape listener active only while open, pathname-change close behavior, and CSS `visibility: hidden`/`pointer-events: none` for the closed mobile sidebar so its links are not tab stops while off-canvas.

- [ ] **Step 4: Run focused shell tests and CSS contracts**

Run: `pnpm -C plus/apps/web test -- src/components/shell/shell.test.tsx src/components/shell/routeSurface.test.ts src/styles/theme.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit the shell remediation**

```bash
git add plus/apps/web/src/components/shell plus/apps/web/src/styles/global.css plus/apps/web/src/styles/theme.test.ts
git commit -m "fix: harden portal and console shell boundaries"
```

### Task 2: Signal token boundary, font roles, and Portal cleanup

**Files:**
- Modify: `plus/apps/web/src/styles/tokens.css`
- Modify: `plus/apps/web/src/styles/global.css`
- Modify: `plus/apps/web/src/styles/theme.test.ts`
- Create: `plus/apps/web/src/styles/theme-contrast.test.ts`

**Interfaces:**
- Add semantic token `--color-accent-contrast` and a sidebar shadow token to both presets.
- Keep existing `--color-*` names stable; no route or component API changes.

- [ ] **Step 1: Write failing token and cleanup tests**

Add assertions that:

```ts
expect(tokens).toContain("--color-accent-contrast");
expect(tokens).toContain('font-family: system-ui');
expect(global).toContain("var(--color-accent-contrast)");
expect(global).not.toContain("var(--muted, #666)");
expect(global).not.toContain("var(--line, #ddd)");
expect(global).not.toContain("color: var(--gold)");
```

Add a `theme-contrast.test.ts` helper that parses the Signal hex roles and computes WCAG relative luminance ratios for text/page, muted/page, text/surface, accent/surface, and focus/surface; assert normal text pairs are at least `4.5` and large/control pairs at least `3`.

- [ ] **Step 2: Run focused style tests and confirm RED**

Run: `pnpm -C plus/apps/web test -- src/styles/theme.test.ts src/styles/theme-contrast.test.ts`

Expected: failures for missing semantic tokens, legacy fallback colors, and missing contrast test implementation.

- [ ] **Step 3: Implement semantic Signal roles and clean legacy styles**

Set Signal’s console font to a system UI stack, add `font-variant-numeric: tabular-nums` to Console surfaces, add `--color-accent-contrast` and `--shadow-sidebar`, and replace Console raw `--ink`/`rgba(...)` usage with semantic `var()`/`color-mix()` expressions. Override Console auth/loading/field rules so login does not inherit Portal gradient, blur, or shadow. Remove obsolete `--muted`/`--line` fallbacks and replace the remaining Portal/Ops hard-coded fallback colors with existing semantic roles or an explicit theme token.

- [ ] **Step 4: Run focused style tests and verify GREEN**

Run: `pnpm -C plus/apps/web test -- src/styles/theme.test.ts src/styles/theme-contrast.test.ts src/styles/join-registration-vote.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit token and cleanup remediation**

```bash
git add plus/apps/web/src/styles/tokens.css plus/apps/web/src/styles/global.css plus/apps/web/src/styles/theme.test.ts plus/apps/web/src/styles/theme-contrast.test.ts
git commit -m "fix: enforce semantic atmosphere tokens"
```

### Task 3: Search/filter controls and registration feedback

**Files:**
- Modify: `plus/apps/web/src/routes/ops.tsx`
- Modify: `plus/apps/web/src/routes/studio.tsx`
- Modify: `plus/apps/web/src/routes/live.tsx`
- Modify: `plus/apps/web/src/routes/opsActivity.tsx`
- Modify: `plus/apps/web/src/components/ops/RegistrationTable.tsx`
- Modify: `plus/apps/web/src/components/form/RegistrationForm.tsx`
- Modify: `plus/apps/web/src/routes/opsRegistration.tsx`
- Modify: `plus/apps/web/src/routes/joinActivity.tsx`
- Modify: `plus/apps/web/src/styles/global.css`
- Create/Modify tests beside each affected route/component.

**Interfaces:**
- Filtering is client-side over the already-fetched arrays; no API changes.
- Add a shared visual class `.console-table-toolbar` but keep route-local state so each page’s query behavior remains independent.

- [ ] **Step 1: Write failing tests for filtering and feedback**

Add route/component tests asserting:

```tsx
expect(screen.getByLabelText("搜索活动")).toBeInTheDocument();
expect(screen.getByLabelText("按状态筛选")).toBeInTheDocument();
await userEvent.type(screen.getByLabelText("搜索活动"), "春季");
expect(screen.queryByRole("link", { name: "不匹配活动" })).not.toBeInTheDocument();
```

Add RegistrationForm tests for an empty review note not rendering `.review-note`, and for success text having `aria-live="polite"`. Add Ops registration detail coverage for the same empty-note rule.

- [ ] **Step 2: Run focused tests and confirm RED**

Run the affected route/component test files with Vitest; expected failures are missing toolbar controls, filtering behavior, and empty-note/live-region assertions.

- [ ] **Step 3: Implement client-side controls and semantic feedback**

Add `searchTerm` and `statusFilter` state to Ops, Studio, Live, and the Ops registration table. Render accessible text/select controls, filter by title/public code/participant and status, and show a no-match state. Guard review notes with `reviewNote?.trim()`, add `aria-live="polite"` to registration success messages and Vote success/already-voted status, and style the toolbar responsively with 40px controls.

- [ ] **Step 4: Run focused tests and verify GREEN**

Run all affected web test files and inspect that the filtered tables retain their existing links and mutation buttons.

- [ ] **Step 5: Commit the operator and registration remediation**

```bash
git add plus/apps/web/src/routes/ops.tsx plus/apps/web/src/routes/studio.tsx plus/apps/web/src/routes/live.tsx plus/apps/web/src/routes/opsActivity.tsx plus/apps/web/src/components/ops/RegistrationTable.tsx plus/apps/web/src/components/form/RegistrationForm.tsx plus/apps/web/src/routes/opsRegistration.tsx plus/apps/web/src/routes/joinActivity.tsx plus/apps/web/src/styles/global.css
git commit -m "fix: add console table controls and form feedback"
```

### Task 4: Vote route-state reset and final verification coverage

**Files:**
- Modify: `plus/apps/web/src/routes/vote.tsx`
- Modify: `plus/apps/web/src/routes/vote.test.tsx`
- Modify: `plus/apps/web/src/components/shell/shell.test.tsx`
- Modify: `plus/apps/web/src/styles/live-judge-console.test.ts`
- Modify: `plus/apps/web/src/styles/join-registration-vote.test.ts`
- Modify: `docs/artflow-plus/specs/2026-10-28-visual-theme-family-and-console-shell-design.md`

**Interfaces:**
- Vote submission/redeem API calls and identity policy remain unchanged.
- Route parameter changes reset only local UI state (`selected`, `justVoted`, ticket/redeem state); query data remains TanStack-managed.

- [ ] **Step 1: Write failing Vote route-state tests**

Add a test that renders the Vote page, changes the route/session identity through the mocked params, and asserts the new session starts with no selected option and no prior success state. Add style assertions for mobile sidebar visibility and the table toolbar.

- [ ] **Step 2: Run focused tests and confirm RED**

Run: `pnpm -C plus/apps/web test -- src/routes/vote.test.tsx src/components/shell/shell.test.tsx src/styles/live-judge-console.test.ts src/styles/join-registration-vote.test.ts`

Expected: the route-change state test fails before the reset effect and the new style contracts fail before final CSS is present.

- [ ] **Step 3: Implement reset and document status**

Add a `useEffect` keyed by `sessionId` to clear local vote selection/status/redeem state. Update the design document to record the review remediation and leave Phase 5 explicitly marked implemented only for the completed cleanup scope, with future theme presets still optional.

- [ ] **Step 4: Run full Plus verification**

Run:

```powershell
pnpm -C plus run check
$env:ARTFLOW_PLUS_DATABASE_URL = "postgresql://artflow:artflow_dev@127.0.0.1:5433/artflow_plus"
$env:REQUIRE_DB = "1"
pnpm -C plus run test
pnpm -C plus/apps/web test:e2e
pnpm -C plus/apps/web build
pwsh -NoProfile -File scripts/check_docs.ps1
git diff --check
```

Expected: all commands exit 0; report the existing large-chunk warning separately if it remains.

- [ ] **Step 5: Review and commit the final verification batch**

```bash
git add plus/apps/web/src/routes/vote.tsx plus/apps/web/src/routes/vote.test.tsx plus/apps/web/src/components/shell/shell.test.tsx plus/apps/web/src/styles/live-judge-console.test.ts plus/apps/web/src/styles/join-registration-vote.test.ts docs/artflow-plus/specs/2026-10-28-visual-theme-family-and-console-shell-design.md
git commit -m "test: close phase review coverage"
```

## Plan Self-Review

- Spec coverage: shell boundaries, semantic tokens, Console responsive behavior, table controls, accessibility, contrast, and Phase 5 cleanup are covered by Tasks 1–4.
- Authority/API coverage: no task changes API or command behavior; all mutations remain in existing services.
- Placeholder scan: all implementation steps contain concrete files, behavior, and verification commands.
- Type consistency: `searchTerm`, `statusFilter`, `--color-accent-contrast`, `.console-table-toolbar`, and `sessionId` reset are defined at their first use and reused consistently.
