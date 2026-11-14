# ArtFlow v1/v2 Comparative Analysis and Operations Analytics Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Produce a reproducible, evidence-backed comparison of ArtFlow v1 and v2 and ship a read-only activity operations analytics slice that exposes authoritative aggregate facts without creating a second business authority.

**Architecture:** A standard-library Python analyzer measures both repository eras using one explicit exclusion policy and emits JSON or Markdown. The v2 feature is a projection: a DB repository aggregates existing registration, material, competition, voting, publishing, and archive facts; a runtime service applies read authorization and derives non-authoritative attention items; the API and Ops activity page render those aggregates. No new migration or mutation path is introduced.

**Tech Stack:** Python 3.12 standard library, TypeScript 7, Fastify 5, Kysely/PostgreSQL 18, TypeBox, React 19, TanStack Query, Vitest.

**Spec:** `docs/artflow-plus/specs/2026-10-28-operations-analytics-design.md`

## Global Constraints

- v1 remains the Django production reference; do not mechanically merge `main` into `artflow-plus`.
- v2 domain authority remains in existing facts, decisions, snapshots, and projections; analytics is read-only and non-authoritative.
- Valid vote counts must use the existing redeemed-ticket predicate, never raw ballot rows without that predicate.
- Aggregates must not return participant answers, judge notes, credentials, storage keys, or other row-level private data.
- Every new GET route declares `config.access` and fails closed at boot if omitted.
- Do not add a real-activity rehearsal requirement; Docker verification is disposable and isolated only.
- Every new production function gets a failing test first and is verified with Plus tests only, not the full v1 suite.

### Task 1: Freeze the measurement contract

**Files:**
- Create: `docs/artflow-plus/specs/2026-10-28-operations-analytics-design.md`
- Create: `scripts/tests/test_artflow_comparison.py`
- Create: `scripts/artflow_comparison.py`
- Test: `scripts/tests/test_artflow_comparison.py`

**Interfaces:**
- Produces `analyze_repository(root: Path) -> ComparisonReport`.
- Produces `render_markdown(report: ComparisonReport) -> str` and `render_json(report: ComparisonReport) -> str`.
- CLI accepts `--root`, `--format {markdown,json}`, and optional `--output`.

- [ ] **Step 1: Write analyzer contract tests** for stable source/test/migration/route/model metrics, generated-directory exclusion, Markdown headings, and JSON round-trip.
- [ ] **Step 2: Run `uv run pytest scripts/tests/test_artflow_comparison.py -q` and confirm the import/behavior failure is caused by the missing analyzer.**
- [ ] **Step 3: Implement the analyzer with explicit v1 and v2 roots, line counting, route/model/table extraction, test counting, largest-file reporting, and normalized ratios.**
- [ ] **Step 4: Run the focused test again and verify the contract passes.**
- [ ] **Step 5: Run the analyzer against the repository and inspect the generated metrics before writing conclusions.**

### Task 2: Write the deep comparative report and research matrix

**Files:**
- Create: `docs/artflow-v1-v2-comparative-analysis-2026-10.md`
- Modify: `docs/artflow-plus/roadmap.md`
- Modify: `plus/README.md`

**Interfaces:**
- Consumes the analyzer output and the source documents listed in the spec.
- Records v1/v2 metric definitions, caveats, architecture comparison, capability parity, framework responsibility transfer, security/operations debt, test-density analysis, related-project feature matrix, and prioritized implementation backlog.

- [ ] **Step 1: Add the measured snapshot with command, commit, inclusion/exclusion, and date metadata.**
- [ ] **Step 2: Add the v1/v2 comparison by domain: registration, materials, evaluation, voting, publishing, archive, realtime, operations, portal, deployment, and recovery.**
- [ ] **Step 3: Add the related-project comparison using official sources for CampusGroups/Modern Campus Involve, Award Force, pretix, and pretalx, clearly separating observed facts from ArtFlow inferences.**
- [ ] **Step 4: Record which v2 strengths remain protected and which gaps are intentionally deferred, including the absent check-in/task/scheduling capabilities.**
- [ ] **Step 5: Add the analytics slice to the roadmap and README without claiming production cutover or real-activity rehearsal.**

### Task 3: Add the authoritative aggregate repository

**Files:**
- Create: `plus/packages/db/src/analytics-repository.ts`
- Modify: `plus/packages/db/src/index.ts`
- Test: `plus/packages/db/test/analytics-repository.test.ts`

**Interfaces:**
- Produces `readActivityAnalytics(db, activityId) -> Promise<ActivityAnalyticsFacts>`.
- `ActivityAnalyticsFacts` contains only counts and status distributions for registrations, material checks, rounds/performances/scores, voting sessions/valid ballots, stage results/releases, and archives.

- [ ] **Step 1: Write a PostgreSQL test with fixture rows covering pending/approved/rejected registration, missing/uploaded/approved material checks, round/performance/score states, open/closed voting with a revoked ticket ballot, result states, and archive versions.**
- [ ] **Step 2: Run the focused DB test and confirm the missing repository/export failure.**
- [ ] **Step 3: Implement aggregate queries with explicit status maps and the existing valid-ballot predicate.**
- [ ] **Step 4: Run the focused DB test and verify exact counts plus no row-level payload leakage.**
- [ ] **Step 5: Run the DB package typecheck/test for the touched package.**

### Task 4: Add runtime semantics and API read surface

**Files:**
- Create: `plus/packages/runtime/src/analytics-service.ts`
- Modify: `plus/packages/runtime/src/index.ts`
- Modify: `plus/apps/api/src/app.ts`
- Test: `plus/packages/runtime/test/analytics-service.test.ts`
- Test: `plus/apps/api/test/analytics.test.ts`

**Interfaces:**
- Produces `getActivityAnalytics(db, deps, activityId) -> Promise<ActivityAnalyticsView>`.
- Adds `GET /api/activities/:id/operations/analytics` with `config.access = "analytics"`.
- Analytics read access accepts the existing operations permissions but uses a dedicated access surface so registration-only users do not gain access to sensitive event-feed reads.

- [ ] **Step 1: Write runtime tests for permission refusal, missing activity, aggregate mapping, and deterministic attention codes.**
- [ ] **Step 2: Run the focused runtime test and confirm the missing service failure.**
- [ ] **Step 3: Implement the service with a narrow permission list and explicit non-authoritative attention rules: pending registration review, required material not approved, unknown roster when registration is enabled, open formal vote session, unlocked competition round, stale/unconfirmed result, and missing archive only when the activity is closed.**
- [ ] **Step 4: Add the API contract/schema, read-surface guard, route, and public-safe response mapping.**
- [ ] **Step 5: Run runtime/API focused tests and verify unauthorized actors receive 403 and missing activities receive 404.**

### Task 5: Add the Ops activity analytics panel

**Files:**
- Create: `plus/apps/web/src/api/analytics.ts`
- Create: `plus/apps/web/src/components/ops/ActivityAnalyticsCard.tsx`
- Modify: `plus/apps/web/src/routes/opsActivity.tsx`
- Modify: `plus/apps/web/src/routes/opsActivity.test.tsx`
- Modify: `plus/apps/web/src/styles/global.css`

**Interfaces:**
- `fetchActivityAnalytics(activityId) -> Promise<ActivityAnalyticsView>` consumes the shared API response shape.
- `ActivityAnalyticsCard` renders aggregate cards, attention codes, and empty capability states; it does not expose row-level private data or mutation controls.

- [ ] **Step 1: Add a failing component test for loading, counts, attention, and no-capability states.**
- [ ] **Step 2: Run the focused web test and confirm the missing API/card failure.**
- [ ] **Step 3: Implement the API client and card using the existing Ops visual language and TanStack Query.**
- [ ] **Step 4: Mount the card in the Ops activity page and keep existing registration/roster/voting cards unchanged.**
- [ ] **Step 5: Run the focused web tests and client typecheck.**

### Task 6: Final verification and scoped integration

**Files:**
- Modify only files already listed above unless verification finds a direct defect.

- [ ] **Step 1: Run the analyzer snapshot and update the report numbers from fresh output.**
- [ ] **Step 2: Run `pnpm -C plus run check`.**
- [ ] **Step 3: Run the focused Plus tests, then `REQUIRE_DB=1 pnpm -C plus run test` as the requested Plus-only full test gate.**
- [ ] **Step 4: Run `uv run pytest tests/gates -q`, the comparison tests, docs check, Bash syntax checks, and `git diff --check`.**
- [ ] **Step 5: Start the local Plus services with Docker only if needed for the route smoke; use a disposable schema/project and do not reset source volumes.**
- [ ] **Step 6: Commit the analyzer/report, DB/runtime/API, and web changes as separate conventional commits; merge `--no-ff` into `artflow-plus`, push directly, verify remote, and delete the local feature branch.**
