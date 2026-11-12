# Organizer Workspace Experience Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a role-aware organizer workspace that turns the existing Studio, Ops, Live, and Portal capabilities into one navigable activity workflow without adding a second business authority.

**Architecture:** Add a thin Web-only experience layer. Existing API readers remain the source of truth; a pure workspace mapper converts their DTOs into progress, attention, and next-action presentation state. Two Console routes (`/workspace` and `/workspace/$activityId`) compose the mapper and existing read APIs, while the shell and login landing gain activity context.

**Tech Stack:** React 19, TanStack Router, TanStack Query, TypeScript strict ESM, Vitest + Testing Library, Playwright, existing Console CSS tokens and primitives.

**Spec:** `docs/artflow-plus/specs/2026-11-12-organizer-workspace-experience-design.md`

## Global Constraints

- Base all existing-file reads on locked source SHA `fff236f836b39ef58cc01a6745188e8ad103d8b3`; do not infer current behavior from a moving worktree.
- Do not add a database table, migration, API route, command, event, realtime topic, or capability descriptor in this phase.
- Reuse `GET /api/activities`, `GET /api/activities/:id/operations/analytics`, `GET /api/activities/:id/studio`, `GET /api/activities/:id/live`, and the existing public-results route.
- Do not import `@artflow-plus/runtime`, database types, or capability internals into Web components.
- Preserve Portal routes and Afterglow behavior; workspace pages use the Console shell and never mount `AuroraScene`.
- All user-visible states need loading, empty, error, and permission-aware copy; no predictable 403 dead links.
- `test`, `rehearsal`, and `formal` facts must remain distinguishable; presentation logic cannot merge them or authorize mutations.
- Keep existing uncommitted files from the parallel agent out of every commit; stage only the files listed by the current task.
- Before claiming completion, run focused Web tests, Web typecheck, Web production build, graph check, and the relevant E2E journey with PostgreSQL available.

## File Map

Create:

- `plus/apps/web/src/api/workspace.ts` — thin re-export/read seam over existing API readers and workspace DTO types.
- `plus/apps/web/src/components/workspace/workspaceState.ts` — pure presentation mapping for attention, progress, and next action.
- `plus/apps/web/src/components/workspace/workspaceState.test.ts` — mapper invariants and fallback behavior.
- `plus/apps/web/src/components/workspace/ActivitySwitcher.tsx` — activity context selector.
- `plus/apps/web/src/components/workspace/WorkspaceActivityCard.tsx` — overview card with primary and secondary links.
- `plus/apps/web/src/components/workspace/WorkspaceNextAction.tsx` — next-action panel.
- `plus/apps/web/src/components/workspace/WorkspaceProgress.tsx` — ordered activity progress.
- `plus/apps/web/src/components/workspace/workspace.test.tsx` — focused component behavior tests.
- `plus/apps/web/src/routes/workspace.tsx` — organizer activity overview route.
- `plus/apps/web/src/routes/workspaceActivity.tsx` — organizer activity workspace route.
- `plus/apps/web/src/routes/workspace.test.tsx` — overview route states and navigation.
- `plus/apps/web/src/routes/workspaceActivity.test.tsx` — detail route states, permissions, and partial failures.
- `plus/apps/web/src/styles/workspace.css` — workspace-only Console styles.
- `plus/apps/web/e2e/workspace.spec.ts` — authenticated organizer journey.

Modify:

- `plus/apps/web/src/router.tsx` — register the two workspace routes.
- `plus/apps/web/src/components/shell/routeSurface.ts` and its test — classify workspace paths as Console.
- `plus/apps/web/src/components/shell/ConsoleShell.tsx` and its test — add Workspace navigation and activity context label.
- `plus/apps/web/src/auth/SessionProvider.tsx` and a focused auth test — organizer access and `/workspace` default landing.
- `plus/apps/web/src/styles/global.css` — import the workspace partial after Console styles.
- `plus/apps/web/src/styles/*` only if an existing Console primitive needs a narrowly scoped workspace override; do not add business colors in JSX.

## Task 1: Prove and implement the pure workspace state mapper

**Files:**

- Create: `plus/apps/web/src/components/workspace/workspaceState.test.ts`
- Create: `plus/apps/web/src/components/workspace/workspaceState.ts`
- Read-only references: `plus/apps/web/src/api/ops.ts`, `plus/apps/web/src/api/analytics.ts`, `plus/apps/web/src/api/studio.ts`, `plus/apps/web/src/api/live.ts`, `plus/packages/contracts/src/analytics.ts`

**Interfaces:**

```ts
export type WorkspaceSurface = "studio" | "ops" | "live" | "results";

export interface WorkspaceAccess {
  readonly studio: boolean;
  readonly ops: boolean;
  readonly live: boolean;
}

export interface WorkspaceFacts {
  readonly activity: WorkspaceActivity;
  readonly analytics: ActivityAnalyticsResponse | null;
  readonly studio: StudioState | null;
  readonly live: LiveState | null;
  readonly access: WorkspaceAccess;
}

export interface WorkspaceProgressItem {
  readonly key: "setup" | "registration" | "review" | "live" | "results";
  readonly label: string;
  readonly state: "complete" | "attention" | "available" | "unavailable";
  readonly detail: string;
  readonly target: WorkspaceSurface | null;
}

export interface WorkspaceNextAction {
  readonly code: string;
  readonly label: string;
  readonly description: string;
  readonly target: WorkspaceSurface;
  readonly count?: number;
}

export function attentionCopy(code: string): string;
export function buildWorkspaceProgress(facts: WorkspaceFacts): readonly WorkspaceProgressItem[];
export function pickWorkspaceNextAction(facts: WorkspaceFacts): WorkspaceNextAction | null;
```

- [ ] **Step 1: Write the failing mapper tests.** Cover `REGISTRATION_REVIEW_PENDING` selecting Ops with its count, `ROSTER_NOT_FINAL` selecting Ops, `COMPETITION_ROUND_NOT_LOCKED` selecting Live only when Live access exists, `RESULT_RELEASE_PENDING` selecting results, an active formal release producing a results action when attention is empty, and a draft with no readable detail producing a setup action or `null` without inventing a command.

```ts
it("maps a registration attention item to the Ops next action", () => {
  const result = pickWorkspaceNextAction({
    activity: activeActivity({ enabledCapabilities: ["registration"] }),
    analytics: analyticsWithAttention("REGISTRATION_REVIEW_PENDING", 3),
    studio: null,
    live: null,
    access: { studio: false, ops: true, live: false },
  });

  expect(result).toMatchObject({
    code: "REGISTRATION_REVIEW_PENDING",
    target: "ops",
    count: 3,
  });
});
```

- [ ] **Step 2: Run the focused test to prove it fails.**

Run: `pnpm --filter @artflow-plus/web exec vitest run src/components/workspace/workspaceState.test.ts`

Expected: FAIL because `workspaceState.ts` does not exist yet.

- [ ] **Step 3: Implement the minimal pure mapper.** Keep attention-code copy and target mapping in one record. Use only stable analytics fields and the existing `StudioState`/`LiveState` DTOs. Treat unknown attention codes as a generic warning that targets the activity’s first permitted operational surface; never throw and never return a mutation payload.

- [ ] **Step 4: Run the focused test to prove it passes.**

Run: `pnpm --filter @artflow-plus/web exec vitest run src/components/workspace/workspaceState.test.ts`

Expected: PASS with all mapper branches covered.

- [ ] **Step 5: Commit the isolated mapper.**

```powershell
git add plus/apps/web/src/components/workspace/workspaceState.ts plus/apps/web/src/components/workspace/workspaceState.test.ts
git commit -m "feat: map organizer workspace state"
```

## Task 2: Add the thin API seam and organizer landing contract

**Files:**

- Create: `plus/apps/web/src/api/workspace.ts`
- Create: `plus/apps/web/src/auth/SessionProvider.test.tsx`
- Modify: `plus/apps/web/src/auth/SessionProvider.tsx`
- Modify: `plus/apps/web/src/routes/login.test.tsx` only for the real default-landing assertion if its existing mock shape requires it

**Interfaces:**

```ts
export type { OpsActivitySummary as WorkspaceActivity } from "./ops.js";
export type { ActivityAnalyticsResponse } from "./analytics.js";
export type { StudioState } from "./studio.js";
export type { LiveState } from "./live.js";

export { fetchOpsActivities as fetchWorkspaceActivities } from "./ops.js";
export { fetchActivityAnalytics as fetchWorkspaceAnalytics } from "./analytics.js";
export { fetchStudioState as fetchWorkspaceStudioState } from "./studio.js";
export { fetchLiveState as fetchWorkspaceLiveState } from "./live.js";
```

Add one pure access helper beside the existing helpers:

```ts
export function hasWorkspaceAccess(session: SessionResponse | null): boolean {
  return hasOpsAccess(session) || hasStudioAccess(session) || hasLiveAccess(session);
}
```

Update `defaultLanding` so an actor with any organizer surface lands at `/workspace`, while a participant-only actor still lands at `/join`. Keep `next` handling in `LoginPage` unchanged.

- [ ] **Step 1: Write failing access and landing tests.** Assert staff, studio-only, and live-only actors land at `/workspace`; participant-only actors land at `/join`; anonymous input returns false; and the API seam re-exports the existing functions without introducing another URL.

- [ ] **Step 2: Run the focused tests to prove the current behavior is red.**

Run: `pnpm --filter @artflow-plus/web exec vitest run src/auth/SessionProvider.test.tsx src/routes/login.test.tsx`

Expected: FAIL because organizer actors currently land at `/ops`, `/studio`, or `/join`, and the workspace seam does not exist.

- [ ] **Step 3: Implement the access helper, default landing, and API re-exports.** Do not change login mutation behavior or query invalidation.

- [ ] **Step 4: Run the focused tests.**

Run: `pnpm --filter @artflow-plus/web exec vitest run src/auth/SessionProvider.test.tsx src/routes/login.test.tsx`

Expected: PASS.

- [ ] **Step 5: Commit the landing seam.**

```powershell
git add plus/apps/web/src/api/workspace.ts plus/apps/web/src/auth/SessionProvider.tsx plus/apps/web/src/auth/SessionProvider.test.tsx plus/apps/web/src/routes/login.test.tsx
git commit -m "feat: add organizer workspace landing"
```

## Task 3: Build tested workspace components

**Files:**

- Create: `plus/apps/web/src/components/workspace/ActivitySwitcher.tsx`
- Create: `plus/apps/web/src/components/workspace/WorkspaceActivityCard.tsx`
- Create: `plus/apps/web/src/components/workspace/WorkspaceNextAction.tsx`
- Create: `plus/apps/web/src/components/workspace/WorkspaceProgress.tsx`
- Create: `plus/apps/web/src/components/workspace/workspace.test.tsx`

**Interfaces:**

```tsx
export function ActivitySwitcher(props: {
  readonly activities: readonly WorkspaceActivity[];
  readonly activeActivityId?: string;
}): JSX.Element;

export function WorkspaceActivityCard(props: {
  readonly activity: WorkspaceActivity;
  readonly attentionCount: number;
  readonly primaryAction: WorkspaceNextAction | null;
}): JSX.Element;

export function WorkspaceNextAction(props: {
  readonly action: WorkspaceNextAction | null;
  readonly pending: boolean;
}): JSX.Element;

export function WorkspaceProgress(props: {
  readonly items: readonly WorkspaceProgressItem[];
}): JSX.Element;
```

- [ ] **Step 1: Write component tests before implementation.** Cover: activity card exposes title, status, public code, capability chips, a workspace detail link, and the primary action; a null action renders a clear “暂无待处理事项” state; progress renders accessible ordered items and does not use Portal heading classes; switcher labels the current activity and navigates using the typed workspace route; copying a public code announces success and leaves the original code visible.

```tsx
it("renders an activity card with the next action and public code", async () => {
  render(
    <WorkspaceActivityCard
      activity={activity}
      attentionCount={2}
      primaryAction={{
        code: "REGISTRATION_REVIEW_PENDING",
        label: "处理报名审核",
        description: "还有 2 项报名需要处理。",
        target: "ops",
        count: 2,
      }}
    />,
  );

  expect(screen.getByRole("link", { name: "处理报名审核" })).toHaveAttribute(
    "href",
    "/ops/activity-1",
  );
  expect(screen.getByText("SPRING-1")).toBeInTheDocument();
});
```

- [ ] **Step 2: Run the focused component test to prove it fails.**

Run: `pnpm --filter @artflow-plus/web exec vitest run src/components/workspace/workspace.test.tsx`

Expected: FAIL because the workspace component files do not exist.

- [ ] **Step 3: Implement the components with existing Console primitives.** Use `Link` for navigation, a real `button` for copy, `aria-live="polite"` for copy feedback, and `aria-current="page"` for the active activity. Do not use inline color literals or Portal-only classes.

- [ ] **Step 4: Run the focused component test.**

Run: `pnpm --filter @artflow-plus/web exec vitest run src/components/workspace/workspace.test.tsx`

Expected: PASS.

- [ ] **Step 5: Commit the component layer.**

```powershell
git add plus/apps/web/src/components/workspace
git commit -m "feat: add organizer workspace components"
```

## Task 4: Wire the overview and detail routes

**Files:**

- Create: `plus/apps/web/src/routes/workspace.tsx`
- Create: `plus/apps/web/src/routes/workspaceActivity.tsx`
- Create: `plus/apps/web/src/routes/workspace.test.tsx`
- Create: `plus/apps/web/src/routes/workspaceActivity.test.tsx`
- Modify: `plus/apps/web/src/router.tsx`

**Interfaces and query contracts:**

```ts
// workspace.tsx
useQuery({
  queryKey: ["workspace-activities"],
  queryFn: fetchWorkspaceActivities,
  enabled: hasWorkspaceAccess(session),
  retry: false,
});

// workspaceActivity.tsx
useQuery({
  queryKey: ["workspace-activities"],
  queryFn: fetchWorkspaceActivities,
  enabled: hasWorkspaceAccess(session),
  retry: false,
});
useQuery({
  queryKey: ["workspace-analytics", activityId],
  queryFn: () => fetchWorkspaceAnalytics(activityId),
  enabled: hasWorkspaceAccess(session),
  retry: false,
});
useQuery({
  queryKey: ["workspace-studio", activityId],
  queryFn: () => fetchWorkspaceStudioState(activityId),
  enabled: hasStudioAccess(session),
  retry: false,
});
useQuery({
  queryKey: ["workspace-live", activityId],
  queryFn: () => fetchWorkspaceLiveState(activityId),
  enabled: hasLiveAccess(session) && activity?.enabledCapabilities.includes("competition") === true,
  retry: false,
});
```

- [ ] **Step 1: Write failing route tests.** Overview tests must cover loading, API error with retry, zero activities with and without Studio access, search/status filtering, and navigation to `/workspace/$activityId`. Detail tests must cover loading, unknown activity, partial analytics failure preserving the activity header and quick links, disabled capability copy, and a successful attention-driven next action.

- [ ] **Step 2: Run the route tests to prove they fail.**

Run: `pnpm --filter @artflow-plus/web exec vitest run src/routes/workspace.test.tsx src/routes/workspaceActivity.test.tsx`

Expected: FAIL because the route modules are not registered or implemented.

- [ ] **Step 3: Implement `WorkspacePage`.** Wrap content in `RequireSession`; if the session has no organizer access, show a Console state with a link to `/join`. Use the existing `ConsolePagination` and filter semantics from `OpsPage`, but render cards instead of a data table. Reset page to 1 when search or status changes.

- [ ] **Step 4: Implement `WorkspaceActivityPage`.** Resolve the activity from the list query before rendering detail. Keep analytics, Studio, and Live reads independent; an error in one panel must not erase the identity header or other links. Build `WorkspaceFacts` and pass it to `buildWorkspaceProgress` and `pickWorkspaceNextAction`. Render result links only when the activity is not a draft or analytics reports an active result release.

- [ ] **Step 5: Register both routes.** Add imports and `createRoute` entries for `/workspace` and `/workspace/$activityId`, then include them in `routeTree` without changing the public root route.

- [ ] **Step 6: Run route tests and the Web typecheck.**

Run: `pnpm --filter @artflow-plus/web exec vitest run src/routes/workspace.test.tsx src/routes/workspaceActivity.test.tsx && pnpm --filter @artflow-plus/web run check`

Expected: PASS with no TypeScript errors.

- [ ] **Step 7: Commit the route slice.**

```powershell
git add plus/apps/web/src/routes/workspace.tsx plus/apps/web/src/routes/workspaceActivity.tsx plus/apps/web/src/routes/workspace.test.tsx plus/apps/web/src/routes/workspaceActivity.test.tsx plus/apps/web/src/router.tsx
git commit -m "feat: add organizer workspace routes"
```

## Task 5: Add Console activity context and shell coverage

**Files:**

- Modify: `plus/apps/web/src/components/shell/routeSurface.ts`
- Modify: `plus/apps/web/src/components/shell/routeSurface.test.ts`
- Modify: `plus/apps/web/src/components/shell/ConsoleShell.tsx`
- Modify: `plus/apps/web/src/components/shell/shell.test.tsx`

- [ ] **Step 1: Extend the route-surface test first.** Add `/workspace` and `/workspace/activity-1` to the Console cases and keep `/workspace-extra` in the Portal negative case.

- [ ] **Step 2: Run the focused shell tests to prove the route classification fails.**

Run: `pnpm --filter @artflow-plus/web exec vitest run src/components/shell/routeSurface.test.ts src/components/shell/shell.test.tsx`

Expected: FAIL because workspace paths currently resolve to Portal.

- [ ] **Step 3: Add the `Workspace` navigation item.** Extend the `ConsoleNavItem` route union, show it when `hasWorkspaceAccess(session)` is true, mark it current for `/workspace` and its descendants, and add the context label `工作台 · 活动`.

- [ ] **Step 4: Run the shell tests.**

Run: `pnpm --filter @artflow-plus/web exec vitest run src/components/shell/routeSurface.test.ts src/components/shell/shell.test.tsx`

Expected: PASS, including the existing mobile Escape/focus behavior.

- [ ] **Step 5: Commit the shell integration.**

```powershell
git add plus/apps/web/src/components/shell/routeSurface.ts plus/apps/web/src/components/shell/routeSurface.test.ts plus/apps/web/src/components/shell/ConsoleShell.tsx plus/apps/web/src/components/shell/shell.test.tsx
git commit -m "feat: add workspace console navigation"
```

## Task 6: Add workspace styling and static style coverage

**Files:**

- Create: `plus/apps/web/src/styles/workspace.css`
- Modify: `plus/apps/web/src/styles/global.css`
- Create or modify: `plus/apps/web/src/styles/workspace.test.ts`

- [ ] **Step 1: Write the style contract test.** Assert every workspace class used by the new TSX files is declared in `workspace.css` or an existing Console partial, and assert workspace pages use Console token variables instead of hard-coded hex colors.

- [ ] **Step 2: Run the style test to prove it fails.**

Run: `pnpm --filter @artflow-plus/web exec vitest run src/styles/workspace.test.ts`

Expected: FAIL because the partial and import do not exist.

- [ ] **Step 3: Implement responsive styles.** Add the overview grid, activity cards, progress list, next-action panel, capability chips, and detail main/rail layout. Use existing `--color-*` tokens, 40px minimum controls, visible focus styles, and breakpoints at 1023px and 767px. Import `workspace.css` after `console.css` in `global.css`.

- [ ] **Step 4: Run style tests and build.**

Run: `pnpm --filter @artflow-plus/web exec vitest run src/styles/workspace.test.ts && pnpm --filter @artflow-plus/web run build`

Expected: PASS; Vite emits a production bundle without undefined class or TypeScript errors.

- [ ] **Step 5: Commit the visual layer.**

```powershell
git add plus/apps/web/src/styles/workspace.css plus/apps/web/src/styles/global.css plus/apps/web/src/styles/workspace.test.ts
git commit -m "style: add organizer workspace layout"
```

## Task 7: Prove the complete browser journey and recovery states

**Files:**

- Create: `plus/apps/web/e2e/workspace.spec.ts`
- Modify only if required by the locked seed contract: `plus/apps/api/scripts/seed-*.ts`

- [ ] **Step 1: Add the E2E journey against existing seeded staff data.** Log in as `e2e-ops`, assert the post-login URL is `/workspace`, assert an activity card and public code are visible, open the activity workspace, follow the attention-driven Ops/Studio/Live link that the seeded data supports, and return through the Workspace navigation. Use existing `E2E-DEMO` public results only when the activity card exposes a result link.

```ts
test("organizer enters the workspace and continues an activity", async ({ page }) => {
  await page.goto("/login");
  await page.getByLabel("用户名").fill("e2e-ops");
  await page.getByLabel("密码").fill("e2e-ops-password");
  await page.getByRole("button", { name: "登录" }).click();
  await expect(page).toHaveURL(/\/workspace$/);
  await expect(page.getByRole("heading", { name: /活动/ })).toBeVisible();
  await page.getByRole("link", { name: /E2E-DEMO|春季/ }).first().click();
  await expect(page).toHaveURL(/\/workspace\/act/);
  await expect(page.getByRole("heading").first()).toBeVisible();
});
```

- [ ] **Step 2: Add deterministic browser-level recovery checks.** Mock only the analytics request in a route test or Playwright route interception, assert the activity header and quick links remain visible during the failure, then fulfill the request and assert the attention panel returns. Do not add arbitrary sleeps; wait on visible response/state assertions.

- [ ] **Step 3: Run the focused E2E journey.**

Run from repository root with PostgreSQL configured:

```powershell
$env:ARTFLOW_PLUS_DATABASE_URL = "postgresql://artflow:artflow_dev@127.0.0.1:5433/artflow_plus"
pnpm --filter @artflow-plus/web run test:e2e -- e2e/workspace.spec.ts
```

Expected: PASS with the API and Vite servers started by Playwright.

- [ ] **Step 4: Commit the browser journey.**

```powershell
git add plus/apps/web/e2e/workspace.spec.ts plus/apps/api/scripts/seed-*.ts
git commit -m "test: cover organizer workspace journey"
```

Do not stage seed files unless the focused E2E proves the existing seed cannot express the journey and the change remains deterministic and scoped.

## Task 8: Full focused verification and configuration sweep

**Files:**

- Modify only when a check proves drift: `plus/apps/web/tsconfig.json`, `plus/apps/web/vite.config.ts`, `plus/apps/web/src/styles/*`, `.env*.example`, `.gitignore`, `.dockerignore`, or relevant gate declarations.

- [ ] **Step 1: Run all Web tests and typecheck.**

```powershell
pnpm --filter @artflow-plus/web run test
pnpm --filter @artflow-plus/web run check
```

Expected: all existing and workspace tests pass; no skipped database evidence is counted as proof.

- [ ] **Step 2: Run the Web production build.**

```powershell
pnpm --filter @artflow-plus/web run build
```

Expected: build succeeds and Console routes do not pull the Portal-only hero into the bundle through an accidental import.

- [ ] **Step 3: Run structural and Consumer Graph checks.**

```powershell
pnpm -C plus run check
uv run pytest tests/gates -q
```

Expected: route discovery remains clean, no unresolved consumer edge is introduced, and the new files are covered by the existing TypeScript/style checks.

- [ ] **Step 4: Run the relevant database-backed test suite when PostgreSQL is available.**

```powershell
$env:ARTFLOW_PLUS_DATABASE_URL = "postgresql://artflow:artflow_dev@127.0.0.1:5433/artflow_plus"
$env:REQUIRE_DB = "1"
pnpm -C plus run test
```

Expected: database tests execute rather than silently skip; no API contract or existing journey regresses.

- [ ] **Step 5: Perform the configuration sweep.** Confirm new TSX/CSS/test files are included by `tsconfig`, imported by `global.css`, covered by the Web test script, and absent from generated/dist artifacts. Confirm no environment knob or dependency was added.

- [ ] **Step 6: Inspect the final diff against the feature branch base.**

```powershell
git diff --check db59b8446e222cbdea750ad81fbfba12a1905961...HEAD
git status --short
```

Expected: only the workspace implementation, its tests, the accepted spec/plan, and explicitly scoped documentation appear; parallel agent files remain unstaged and uncommitted.

- [ ] **Step 7: Commit any final documentation-only correction separately.**

```powershell
git add docs/artflow-plus/specs/2026-11-12-organizer-workspace-experience-design.md docs/artflow-plus/plans/2026-11-12-organizer-workspace-experience.md
git commit -m "docs: record organizer workspace implementation plan"
```

## Test Architecture Checklist

- Contracts/capabilities: existing activity, analytics, studio, competition/live, and publishing read contracts only; no contract extension.
- Consumers/read models/routes/events/topics: add two Web route consumers; no new server read model, event, or realtime topic; run graph check.
- Lifecycle/terminal/mode isolation: read-only presentation preserves all existing lifecycle guards and keeps test/rehearsal/formal separate.
- Adapters: no new adapter; reuse real API/database paths and existing capability adapters.
- Fault injection: list failure/retry, partial analytics failure/recovery, permission downgrade/upgrade, stale activity route, account switch isolation, and realtime absence with final-state assertions.
- Existing-test gap: current product surfaces are isolated and do not prove cross-surface navigation or account isolation.
- Anti-bloat: one pure mapper and one thin API seam; no per-capability copies or aggregate endpoint.
- Proof: focused mapper/component/route/style tests, Web check/build, Consumer Graph and structural gates, and PostgreSQL-backed E2E.
