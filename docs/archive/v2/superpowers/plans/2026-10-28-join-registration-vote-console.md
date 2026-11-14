# Join Registration Vote Console Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Complete Phase 4 of the approved Atmospheres design by moving Join and Registration into the Signal Console workspace and tightening Vote inside the Afterglow Portal without changing business authority or API behavior.

**Architecture:** Keep the existing query/mutation flows, file metadata-then-content upload order, ticket fragment cleanup, browser identity handling, and vote submission logic. Change only route/component structure, semantic classes, PortalShell's `/vote` background selection, and token-based responsive CSS.

**Tech Stack:** React 19, TypeScript, TanStack Query/Router, Vitest + Testing Library, Playwright, existing Signal/Afterglow tokens in `plus/apps/web/src/styles/global.css`.

**Spec:** `docs/artflow-plus/specs/2026-10-28-visual-theme-family-and-console-shell-design.md` (Phase 4), `docs/artflow-plus/frontend-design-direction.md` (Join/Registration and Vote layout rules), and `docs/artflow-plus/specs/2026-10-26-m8d-live-judge-design.md` only for unchanged registration/vote boundary assumptions.

## Global Constraints

- `/join` and `/join/:publicCode` remain in the Console shell with `data-theme="signal"`; `/vote/:sessionId` remains in the Portal shell with `data-theme="afterglow"`.
- Registration must keep `saveAnswer`, `submitRegistration`, metadata upload, content upload, revision handling, error mapping, and status labels unchanged.
- Vote must keep capability/ticket fragment removal, ticket redemption, browser identity fallback, duplicate-vote handling, selection limits, and HTTP submission unchanged.
- Business state must include text or control affordances in addition to color; new CSS consumes semantic tokens and does not add page-level hex/rgba colors.
- Do not add a UI library, backend route, database migration, authority change, localStorage credential, or v1 test run.
- Verify Plus Web tests/check/build, DB-gated Plus check/test, affected registration/vote Playwright smoke, docs, and whitespace.

---

### Task 1: Add RED contracts for Join, Registration, Vote, and `/vote` background

**Files:**
- Create: `plus/apps/web/src/routes/join.test.tsx`
- Create: `plus/apps/web/src/routes/joinActivity.test.tsx`
- Create: `plus/apps/web/src/components/form/RegistrationForm.test.tsx`
- Modify: `plus/apps/web/src/routes/vote.test.tsx`
- Modify: `plus/apps/web/src/components/shell/shell.test.tsx`
- Create: `plus/apps/web/src/styles/join-registration-vote.test.ts`

**Interfaces:**
- Consumes current `JoinPage`, `JoinActivityPage`, `RegistrationForm`, `VotePage`, `PortalShell`, and existing API/auth modules.
- Produces failing contracts for Console headers, two-column registration form structure, file-slot full-row semantics, Portal Vote action structure, defined primary button classes, and static `/vote` background.

- [ ] **Step 1: Write Join route contracts**

  Mock `useNavigate` and render `JoinPage`. Assert the page uses a `console-page-header`, an `h1.console-page-title`, a `.join-code-card`, and keeps the labels `活动公开码` and button `继续`.

  Mock TanStack Query/Router, auth wrapper, registration API, and `RegistrationForm` for `JoinActivityPage`. Render a successful detail state and assert the page exposes a `.registration-page` Console header and passes the detail into the form placeholder.

- [ ] **Step 2: Write RegistrationForm contracts**

  Mock registration mutations and render a draft detail with two text questions, one notice, and one file question. Assert:

  ```tsx
  expect(screen.getByRole("heading", { name: "春季现场" })).toHaveClass("console-page-title");
  expect(screen.getByRole("heading", { name: "春季现场" })).not.toHaveClass("results-title");
  expect(document.querySelector(".registration-question-grid")).not.toBeNull();
  expect(document.querySelector(".question-file")).toHaveClass("question-full-row");
  expect(document.querySelector(".registration-actions")).not.toBeNull();
  ```

  Keep `保存草稿` and `提交报名` accessible names in the fixture.

- [ ] **Step 3: Extend Vote and PortalShell contracts**

  Add an open-session Vote fixture and assert `.vote-workspace`, `.vote-action-panel`, a `primary-button` submit control, and no `button-primary` class. Keep the existing closed-ticket test and its no-redeem assertion.

  Add a PortalShell test with `pathname: "/vote/session-1"` and reduced motion disabled; assert `[data-theme="afterglow"]` contains `.static-backdrop` and does not contain the Aurora test id.

- [ ] **Step 4: Add stylesheet/source contracts**

  Assert `global.css` contains `.join-page`, `.registration-question-grid`, `.question-full-row`, `.vote-workspace`, `.vote-action-panel`, and a mobile single-column rule. Read `vote.tsx` and assert it does not contain `className="button-primary"`.

- [ ] **Step 5: Run the focused tests to verify RED**

  Run: `pnpm -C plus/apps/web test -- src/routes/join.test.tsx src/routes/joinActivity.test.tsx src/components/form/RegistrationForm.test.tsx src/routes/vote.test.tsx src/components/shell/shell.test.tsx src/styles/join-registration-vote.test.ts`

  Expected: new layout assertions fail because Join/Registration still use auth/Portal classes, Vote still uses `button-primary`, and PortalShell always mounts Aurora. Existing closed-ticket behavior must remain passing.

- [ ] **Step 6: Commit the failing contract tests**

  ```powershell
  git add plus/apps/web/src/routes/join.test.tsx plus/apps/web/src/routes/joinActivity.test.tsx plus/apps/web/src/components/form/RegistrationForm.test.tsx plus/apps/web/src/routes/vote.test.tsx plus/apps/web/src/components/shell/shell.test.tsx plus/apps/web/src/styles/join-registration-vote.test.ts
  git commit -m "test: define join registration vote layout contracts"
  ```

### Task 2: Move Join and Registration into the Signal Console workspace

**Files:**
- Modify: `plus/apps/web/src/routes/join.tsx`
- Modify: `plus/apps/web/src/routes/joinActivity.tsx`
- Modify: `plus/apps/web/src/components/form/RegistrationForm.tsx`
- Modify: `plus/apps/web/src/components/form/FileMetadataField.tsx`

**Interfaces:**
- Consumes unchanged registration API functions and `RegistrationDetail` types.
- Produces Console page headers, route-level Console states, a two-column registration question grid, full-row file slots, and accessible file labels.

- [ ] **Step 1: Migrate JoinPage presentation**

  Replace `auth-page`/`auth-card` with `.join-page` and `.join-code-card`, render a `.console-page-header` with `h1.console-page-title`, and put the existing code form in the card. Preserve the `活动公开码` label, validation text `请输入活动公开码`, navigation target `/join/$publicCode`, and button name `继续`.

- [ ] **Step 2: Migrate JoinActivity route states and wrapper**

  Replace loading/error/closed-registration Portal result wrappers with `.console-state` and Console titles. Wrap the successful `RegistrationForm` in a `.registration-page` container with a compact Console page header containing the activity title and public code, while leaving query keys, auto-start behavior, idempotency command ref, and invalidation callbacks unchanged.

- [ ] **Step 3: Migrate RegistrationForm structure**

  Replace `registration-panel` and the `display results-title` heading with `.registration-workspace`, `.registration-header`, `h1.console-page-title`, and `.registration-question-grid`. Keep all question rendering and callbacks, add `.question-full-row` to file and notice slots, and add `.registration-actions` around the existing save/submit buttons. Do not change mutation ordering, revision checks, status copy, or disabled behavior.

- [ ] **Step 4: Make file input labeling explicit**

  Render the file question label as a real `<label>`/`<span>` association while keeping `input[type="file"]`, accepted MIME types, reset-on-change, displayed filename metadata, and the existing upload callback unchanged.

- [ ] **Step 5: Run Join/Registration focused tests to verify GREEN**

  Run: `pnpm -C plus/apps/web test -- src/routes/join.test.tsx src/routes/joinActivity.test.tsx src/components/form/RegistrationForm.test.tsx`

  Expected: all Join/Registration contracts pass and existing mutation-facing accessible names remain unchanged.

- [ ] **Step 6: Commit the Join/Registration migration**

  ```powershell
  git add plus/apps/web/src/routes/join.tsx plus/apps/web/src/routes/joinActivity.tsx plus/apps/web/src/components/form/RegistrationForm.tsx plus/apps/web/src/components/form/FileMetadataField.tsx
  git commit -m "feat: move registration into console workspace"
  ```

### Task 3: Tighten Vote Portal layout and make `/vote` static

**Files:**
- Modify: `plus/apps/web/src/routes/vote.tsx`
- Modify: `plus/apps/web/src/components/shell/PortalShell.tsx`
- Modify: `plus/apps/web/src/routes/vote.test.tsx`
- Modify: `plus/apps/web/src/components/shell/shell.test.tsx`

**Interfaces:**
- Consumes unchanged Vote API functions, query/mutation states, and PortalShell branding.
- Produces a two-column Vote workspace at desktop widths, a single-column mobile fallback, and a static Afterglow background for `/vote/*`.

- [ ] **Step 1: Make PortalShell route-aware for Vote background**

  Read `pathname` from `useLocation`; pass `reducedMotion || pathname.startsWith("/vote/")` to `AuroraScene`. `/`, `/results/*`, and other Portal routes keep current behavior; `/vote/*` renders the existing `StaticBackdrop` through the same component boundary.

- [ ] **Step 2: Split Vote selection and action areas**

  Preserve all conditional branches and mutation handlers, but wrap the open ballot candidates in `.vote-workspace` with `.vote-selection` on the candidate list and `.vote-action-panel` around the selection hint and submit button. Give the ticket verification form `.vote-credential-panel` and change both Vote buttons from `button-primary` to the existing `primary-button` class.

- [ ] **Step 3: Run Vote and shell focused tests to verify GREEN**

  Run: `pnpm -C plus/apps/web test -- src/routes/vote.test.tsx src/components/shell/shell.test.tsx`

  Expected: closed-ticket no-redeem behavior, open ballot structure, button class contract, and static Vote background all pass.

- [ ] **Step 4: Commit the Vote migration**

  ```powershell
  git add plus/apps/web/src/routes/vote.tsx plus/apps/web/src/components/shell/PortalShell.tsx plus/apps/web/src/routes/vote.test.tsx plus/apps/web/src/components/shell/shell.test.tsx
  git commit -m "style: refine vote portal workspace"
  ```

### Task 4: Add responsive Signal/Afterglow styles, update docs, and verify the slice

**Files:**
- Modify: `plus/apps/web/src/styles/global.css`
- Modify: `plus/apps/web/src/styles/join-registration-vote.test.ts`
- Modify: `docs/artflow-plus/specs/2026-10-28-visual-theme-family-and-console-shell-design.md`

**Interfaces:**
- Consumes existing `--color-*` Signal tokens, Afterglow variables, Console breakpoints, and Portal layout primitives.
- Produces desktop Join/Registration/Vote layouts, mobile single-column fallbacks, full-row file slots, stable submission states, and Phase 4 documentation evidence.

- [ ] **Step 1: Run the stylesheet contract before CSS changes**

  Run: `pnpm -C plus/apps/web test -- src/styles/join-registration-vote.test.ts`

  Expected: the new selectors are absent and the test fails; do not edit CSS before seeing this failure.

- [ ] **Step 2: Add semantic Console and Portal styles**

  Add Signal styles for `.join-page`, `.join-code-card`, `.registration-page`, `.registration-workspace`, `.registration-question-grid`, `.question-full-row`, and `.registration-actions`. The question grid uses two equal columns at `min-width: 1024px`, with file and notice rows spanning both columns; at `max-width: 1023px` it becomes one column.

  Add Afterglow styles for `.vote-workspace`, `.vote-selection`, `.vote-action-panel`, and `.vote-credential-panel`, using existing variables and a two-column layout at `min-width: 1024px` with a single-column fallback below that breakpoint. Keep target controls at least 40px and preserve visible focus styles.

- [ ] **Step 3: Update the design spec**

  Change the spec status to `Phase 4 implemented` and record that Join/Registration now use Signal two-column form workspaces with full-row file slots, Vote remains Afterglow with static background and stable submit states, and no authority/API/file-storage behavior changed.

- [ ] **Step 4: Run focused tests and the complete Web test suite**

  Run:

  ```powershell
  pnpm -C plus/apps/web test -- src/routes/join.test.tsx src/routes/joinActivity.test.tsx src/components/form/RegistrationForm.test.tsx src/routes/vote.test.tsx src/components/shell/shell.test.tsx src/styles/join-registration-vote.test.ts
  pnpm -C plus/apps/web test
  pnpm -C plus/apps/web run check
  pnpm -C plus/apps/web build
  ```

  Expected: all focused and Web tests pass, TypeScript exits 0, and the production build exits 0. The existing Aurora chunk-size warning is non-blocking if it remains unchanged.

- [ ] **Step 5: Run Plus verification and affected E2E browser flows**

  ```powershell
  $env:ARTFLOW_PLUS_DATABASE_URL = "postgresql://artflow:artflow_dev@127.0.0.1:5433/artflow_plus"
  $env:REQUIRE_DB = "1"
  pnpm -C plus run check
  pnpm -C plus run test
  pnpm -C plus/apps/web test:e2e -- e2e/registration-loop.spec.ts e2e/vote-page.spec.ts
  pwsh -NoProfile -File scripts/check_docs.ps1
  git diff --check
  ```

  Expected: DB-gated Plus packages, registration/vote Chromium flows, docs, and whitespace checks exit 0. Do not run the v1 suite.

- [ ] **Step 6: Perform final implementation review and commit the styles/docs**

  Review for unchanged API imports, no `results-title` in Join/Registration, no `button-primary` in Vote, no token leakage into URLs/localStorage, explicit file labels, and mobile layout rules. Then commit:

  ```powershell
  git add plus/apps/web/src/styles/global.css plus/apps/web/src/styles/join-registration-vote.test.ts docs/artflow-plus/specs/2026-10-28-visual-theme-family-and-console-shell-design.md
  git commit -m "style: finish join registration vote phase four"
  ```

## Completion Handoff

After verification, merge this feature branch into `artflow-plus` with a non-fast-forward merge, push `artflow-plus`, verify local and remote heads match, and delete only the feature branch. Phase 5 remains Portal cleanup and evaluation of `daybreak`, `ember`, and `quiet`; it is outside this implementation.
