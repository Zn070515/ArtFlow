# M8a Web Shell + Portal Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship `apps/web` with an Afterglow shader hero and the anonymous public results experience.

**Architecture:** React 19 + Vite 8 + TanStack Router/Query, R3F 9 + custom GLSL backdrop, Vitest/RTL for components, Playwright for the seeded public journey. The web app proxies `/api` to Fastify in dev/preview; no auth or staff surfaces in this slice.

**Spec:** `docs/artflow-plus/specs/2026-10-26-m8a-web-portal-design.md`

---

### Task 1: Scaffold `apps/web`

**Files:**
- Create: `plus/apps/web/package.json`, `index.html`, `tsconfig.json`,
  `vite.config.ts`, `vitest.config.ts`, `src/{main,router,env.d.ts}`,
  `test/setup.ts`
- Add deps: react, react-dom, @vitejs/plugin-react, vite,
  @tanstack/react-router, @tanstack/react-query, @react-three/fiber, three,
  @fontsource-variable/fraunces, @fontsource-variable/space-grotesk,
  vitest, jsdom, @testing-library/react, @testing-library/jest-dom,
  @types/three, @playwright/test

- [ ] **Step 1: Create the package and install deps**

```powershell
mkdir plus/apps/web
pnpm -C plus --filter @artflow-plus/web...
pnpm -C plus/apps/web add react react-dom @tanstack/react-router @tanstack/react-query @react-three/fiber three @fontsource-variable/fraunces @fontsource-variable/space-grotesk
pnpm -C plus/apps/web add -D vite @vitejs/plugin-react typescript vitest jsdom @testing-library/react @testing-library/jest-dom @types/three @playwright/test
```

`package.json` scripts: `dev`, `build` (`tsc --noEmit && vite build`), `preview`,
`check` (`tsc --noEmit`), `test` (`vitest run`), `test:e2e` (`playwright test`).

- [ ] **Step 2: Vite + Vitest config**

`vite.config.ts`: react plugin; `server.proxy` and `preview.proxy` for `/api`
target `process.env.VITE_API_TARGET ?? "http://127.0.0.1:3000"`.

`vitest.config.ts`: jsdom, setup `test/setup.ts`, include `src/**/*.test.ts(x)`.

- [ ] **Step 3: Typecheck and commit**

```powershell
pnpm -C plus/apps/web run check
git add plus/apps/web plus/pnpm-lock.yaml
git commit -m "feat(web): scaffold public results app"
```

---

### Task 2: API client and query

**Files:** `src/api/public-results.ts`, `src/api/public-results.test.ts`

- [ ] **Step 1: Types and fetch**

```ts
export interface PublicDecision { rank: number; contestantId: string; score: string }
export interface PublicAward { award: string; contestantId: string }
export interface PublicResult {
  releaseId: string; stageKey: string; publicTitle: string; releasedAt: string;
  decisions: PublicDecision[]; awards: PublicAward[];
}
export interface PublicResults {
  activity: { publicCode: string };
  activityTitle: string;
  results: PublicResult[];
}
export class PublicResultsNotFound extends Error {}
export async function fetchPublicResults(code: string, signal?: AbortSignal): Promise<PublicResults>
```

404 → `PublicResultsNotFound`; other non-2xx → `Error("加载赛果失败")`.

- [ ] **Step 2: Tests** with mocked `fetch`: success, 404, 500.

- [ ] **Step 3: Commit** `feat(web): add public results client`.

---

### Task 3: Design tokens, shell, landing, CodeEntry

**Files:** `src/styles/{tokens,global}.css`, `src/router.tsx`, `src/routes/{__root,index}.tsx`,
`src/components/CodeEntry.tsx`, `src/components/CodeEntry.test.tsx`, `src/main.tsx`

- [ ] **Step 1: Tokens** (ink/gold/ember/bone, fonts, radii, spacing, focus ring).
- [ ] **Step 2: Root layout** with backdrop slot, brand, `<Outlet />`.
- [ ] **Step 3: Landing** with eyebrow, oversized serif title, code form.
- [ ] **Step 4: CodeEntry** trims input, navigates to `/results/<encodeURIComponent(code)>`,
  `aria-label`, error for empty.
- [ ] **Step 5: Tests + commit**.

---

### Task 4: Results page and states

**Files:** `src/routes/results.tsx`, `src/components/results/{ResultsView,RankRow,AwardChips,ResultStates}.tsx`,
tests, `src/styles/global.css`

- [ ] **Step 1: Query** `useQuery` with `["public-results", code]`, `retry: false`,
  404 → not-found state, other errors → retry.
- [ ] **Step 2: ResultsView** renders activityTitle, per-stage publicTitle + formatted
  date, decisions table (`caption`, rank/contestant/score), awards chips.
- [ ] **Step 3: States** loading skeleton, 404, empty, error.
- [ ] **Step 4: Tests** for ranking order, awards, empty, 404.
- [ ] **Step 5: Commit**.

---

### Task 5: Afterglow shader hero

**Files:** `src/components/hero/{AuroraScene,ShaderPlane,ChromeRing}.tsx`,
`src/hooks/useReducedMotion.ts`, `src/components/hero/AuroraScene.test.tsx`

- [ ] **Step 1: Reduced motion** hook via `matchMedia("(prefers-reduced-motion: reduce)")`.
- [ ] **Step 2: ShaderPlane** fullscreen orthographic plane with uniforms
  `uTime/uPointer/uResolution/uGold/uEmber/uInk`; fragment: FBM + domain warp +
  pointer glow + grain + vignette.
- [ ] **Step 3: ChromeRing** torus with Fresnel/iridescent shader, slow rotation,
  positioned right on wide viewports.
- [ ] **Step 4: AuroraScene** `<Canvas dpr={[1,2]} aria-hidden>`; no canvas when
  reduced motion; CSS gradient fallback `data-testid="static-backdrop"`.
- [ ] **Step 5: Test** reduced-motion renders the static fallback.
- [ ] **Step 6: Commit**.

---

### Task 6: E2E seed, Playwright, CI

**Files:** `plus/apps/api/scripts/seed-public-result.ts`, `plus/apps/api/package.json`,
`plus/apps/web/playwright.config.ts`, `plus/apps/web/e2e/public-results.spec.ts`,
`.github/workflows/gates.yml`

- [ ] **Step 1: Seed script** creates schema if needed, migrates, inserts fixed
  activity `E2E-DEMO` + active release with snapshot; idempotent.
- [ ] **Step 2: Playwright config** starts API (`PORT=3100`,
  `ARTFLOW_PLUS_DB_SCHEMA=artflow_e2e`) and web dev (`4173`,
  `VITE_API_TARGET=http://127.0.0.1:3100`); baseURL `http://127.0.0.1:4173`.
- [ ] **Step 3: E2E tests** landing → results, unknown 404, reduced motion, no
  fingerprint in page text.
- [ ] **Step 4: CI job** `web-e2e` in `gates.yml` with Chromium install.
- [ ] **Step 5: Run `pnpm -C plus/apps/web test:e2e` and commit**.

---

### Task 7: Docs, full gate, integration

**Files:** `docs/architecture/adr/0016-web-shell-and-public-portal.md`,
`docs/artflow-plus/roadmap.md`, `plus/README.md`, `docs/artflow-plus/review-checklist.md`

- [ ] **Step 1: ADR-0016** records the web shell, proxy, shader performance/reduced
  motion, and deferral of auth/staff surfaces.
- [ ] **Step 2: Docs** roadmap M8a, README run commands, review checklist.
- [ ] **Step 3: Full gate**

```powershell
$env:ARTFLOW_PLUS_DATABASE_URL = "postgresql://artflow:artflow_dev@127.0.0.1:5433/artflow_plus"
$env:REQUIRE_DB = "1"
pnpm -C plus run check
pnpm -C plus run test
pnpm -C plus/apps/web run test:e2e
uv run pytest tests/gates -q
uv run python tests/golden/validate_fixtures.py
uv run python manage.py test tests.golden --noinput
uv run ruff check tests/gates tests/golden
pwsh -NoProfile -File scripts/check_docs.ps1
```

- [ ] **Step 4: Merge and push**

```powershell
git checkout artflow-plus
git merge --no-ff feat/plus-m8a-web -m "merge: M8a web shell and public portal"
git push origin artflow-plus
gh run watch $(gh run list -L 1 --json databaseId -q '.[0].databaseId') --exit-status
```
