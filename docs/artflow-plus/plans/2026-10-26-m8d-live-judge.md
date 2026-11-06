# M8d Live + Judge Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the Live console and capability-based judge scoring for the judging loop.

**Architecture:** Add read endpoints for Live state and judge context, build Live/judge pages in `apps/web`, and seed a competition activity for the E2E. Commands and permissions remain authoritative; SSE is an enhancement over HTTP recovery.

**Spec:** `docs/artflow-plus/specs/2026-10-26-m8d-live-judge-design.md`

---

### Task 1: Live state + judge context read APIs

**Files:**
- Modify: `plus/packages/db/src/competition-repository.ts` (read variants)
- Modify: `plus/packages/db/src/score-repository.ts` (read-only current facts by judge)
- Create: `plus/packages/runtime/src/live-service.ts`
- Modify: `plus/packages/runtime/src/index.ts`
- Modify: `plus/apps/api/src/app.ts`
- Test: `plus/apps/api/test/live.test.ts`

- [ ] **Step 1: DB read helpers**

`getJudgeSeat`, `listJudgeSeatsForPanel`, `getPanel`, `getRound`,
`getPerformance`, `getPerformanceScoreState`, and `listCurrentScoreFactsForJudge`
(roundId + judgeId) without locks.

- [ ] **Step 2: `live-service.ts`**

`getLiveState(db, deps, activityId)`:
- require any of competition.manage/judge.manage;
- activity summary; active release competition artifact (rounds/rubric/tiePolicy);
- running judging session (`findRunningSessionByScope(..., "judging")`);
- rounds from `listRoundsForActivity` + configured round keys; panel; seats;
  performances; scoreCount per performance via `countCurrentScoreFactsForContext`;
  latest ranking via `getCurrentRankingSnapshot`;
- approved participant ids via `listApprovedParticipantIds`.
Return the DTO in the spec.

`getJudgeContext(db, judgeToken)`:
- `authenticateJudgeSession` → seat/activity;
- seat → panel → round → open performance;
- rubric from the release artifact;
- existing current score fact for the judge/contestant;
- return seat/panel/round/performance/rubric/score or nulls.

- [ ] **Step 3: Routes**

- `GET /api/activities/:id/live` (staff permissions).
- `GET /api/judge/context` reading `artflow_judge_session`.
- Allow competition.manage/judge.manage on `/api/activities` list.
- Update the E2E admin seed permissions.

- [ ] **Step 4: API test**

Create a released competition activity with a round/panel/performance and verify
live state; judge context 401 without cookie, then with a seeded judge session.
Use the existing `claimJudgeSeat` or insert a judge session/seat directly.

- [ ] **Step 5: Commit** `feat(live): add live state and judge context`.

---

### Task 2: Web Live console

**Files:** `plus/apps/web/src/api/live.ts`,
`src/routes/{live,liveActivity}.tsx`, components under `src/components/live/`,
router, `SessionProvider` (`hasLiveAccess`), header nav, CSS.

- [ ] **Step 1: API client** for live state and all existing commands
  (session start/close, prepare round, panel, performance open/lock, round lock,
  resolve, judge entry reissue, ranking/events).
- [ ] **Step 2: `/live` list + `/live/:activityId`** console:
  session, rounds, panel form, performance form, score progress, lock/resolve,
  ranking, judge entry link, close session.
- [ ] **Step 3: SSE + polling** invalidation.
- [ ] **Step 4: Commit** `feat(web): add Live console`.

---

### Task 3: Judge scoring page

**Files:** `src/routes/judge.tsx`, `src/api/judge.ts`, router, CSS, tests.

- [ ] **Step 1: claim + context polling**.
- [ ] **Step 2: rubric score form** with three criteria; submit direct_judge score;
  show submitted/next performance; error states.
- [ ] **Step 3: Tests + commit** `feat(web): add judge scoring page`.

---

### Task 4: E2E + seed

**Files:** `plus/apps/api/scripts/seed-live.ts`, `package.json` seed chain,
`plus/apps/web/e2e/live-judge.spec.ts`.

- [ ] **Step 1: Seed** `act-e2e-live` / `E2E-LIVE`: active competition activity,
  release artifact (round-1, rubric, review tie), approved registration
  `singer-a`, final roster; admin competition/judge permissions.
- [ ] **Step 2: E2E** staff live setup → judge link → judge score → lock/resolve →
  ranking → close session.
- [ ] **Step 3: Run + commit**.

---

### Task 5: Docs, full gate, integration

- [ ] ADR-0019, roadmap M8d, README, review checklist.
- [ ] Full gate + E2E + gates/docs, merge/push, watch CI.
