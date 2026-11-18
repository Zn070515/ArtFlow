# Live 现场指挥台实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 `/live/$activityId` 顶部增加只读指挥条：会话、当前、下一、轮次、评委席位、评分进度、HOLD，全部由现有 `LiveState` 投影；动作只做锚点。

**Architecture:** 纯函数 `deriveLiveCommand` + `LiveCommandBar`；页面接入锚点与轮次包裹；不新增命令/路由/表。

**Tech Stack:** React 19、TanStack Query、Vitest、Playwright。

**Spec:** [`2026-11-18-live-command-console-design.md`](../specs/2026-11-18-live-command-console-design.md)

---

## Test architecture

按 spec §5：**契约**（无新命令/路由/表）；**消费者**（`/live/$activityId`）；**生命周期**（session 仅 none/running；当前只取 open；HOLD/未解析阻塞下一轮；下一轮未 prepare；closed/archived 只读；completed）；**适配器**（无）；**故障**（无会话、未 prepare、全 locked、hold、closed、archived、completed、席位不足、权限不足、实时失效）；**防膨胀 / anti-bloat**（一个纯函数 + 一个组件，扩展 live-judge E2E，不复制命令）；**门禁**（下方命令）。

---

## Task 1: `deriveLiveCommand`

**Files:**
- Create: `plus/apps/web/src/components/live/liveCommandModel.ts`
- Test: `plus/apps/web/src/components/live/liveCommandModel.test.ts`

- [ ] **Step 1: 写类型与推导**

```ts
import type { LiveRound, LiveState } from "../../api/live.js";

export type LiveSessionState = "none" | "running";
export type LivePhase =
  | "inactive" | "no_session" | "awaiting_start" | "scoring"
  | "round_scored" | "round_hold" | "round_resolved" | "completed";

export interface LiveCommandView {
  session: LiveSessionState;
  mode: LiveState["session"] extends infer S ? S extends { mode: infer M } ? M | null : null : null;
  phase: LivePhase;
  focusRoundKey: string | null;
  focusRoundIndex: number | null;
  current: {
    performanceId: string; sequence: number; participantId: string;
    scoreCount: number; expectedJudges: number;
  } | null;
  next: {
    kind: "performance" | "round" | "blocked";
    roundKey: string; roundIndex: number;
    sequence?: number; participantId?: string; label: string;
  } | null;
  rounds: {
    key: string; index: number;
    state: "none" | "prepared" | "scoring" | "locked" | "resolved";
    lockedPerformances: number; totalPerformances: number; hold: boolean;
  }[];
  seats: { assigned: number; expected: number; minimum: number };
  readyToScore: boolean;
  activityStatus: LiveState["activity"]["status"];
}
```

- [ ] **Step 2: 推导**

```ts
export function deriveLiveCommand(state: LiveState): LiveCommandView {
  const session: LiveSessionState = state.session === null ? "none" : "running";
  const mode = state.session?.mode ?? null;
  const rounds = state.rounds.map((round, index) => {
    const lockedPerformances = round.performances.filter((p) => p.state === "locked").length;
    return {
      key: round.config.key,
      index,
      state: round.round?.state ?? "none" as const,
      lockedPerformances,
      totalPerformances: round.performances.length,
      hold: round.ranking?.status === "hold",
    };
  });
  const base = {
    session, mode,
    activityStatus: state.activity.status,
    rounds,
    seats: { assigned: 0, expected: 0, minimum: 0 },
    readyToScore: false,
  };
  if (state.activity.status === "closed" || state.activity.status === "archived") {
    return { ...base, phase: "inactive", focusRoundKey: null, focusRoundIndex: null, current: null, next: null };
  }
  const focusIndex = state.rounds.findIndex((round) => round.round?.state !== "resolved");
  if (focusIndex === -1) {
    return { ...base, phase: "completed", focusRoundKey: null, focusRoundIndex: null, current: null, next: null };
  }
  const focus = state.rounds[focusIndex]!;
  const focusKey = focus.config.key;
  const seatsAssigned = focus.seats.filter((seat) => seat.state === "assigned").length;
  const seats = {
    assigned: seatsAssigned,
    expected: focus.config.judgeCount,
    minimum: focus.config.minimumJudges,
  };
  const nextRound = state.rounds[focusIndex + 1];
  const nextLabel = nextRound === undefined
    ? null
    : nextRound.round === null
      ? { kind: "round" as const, roundKey: nextRound.config.key, roundIndex: focusIndex + 1, label: `准备第 ${focusIndex + 2} 轮` }
      : { kind: "performance" as const, roundKey: nextRound.config.key, roundIndex: focusIndex + 1, label: `下一轮：第 ${focusIndex + 2} 轮` };
  const focusRound = focus.round;
  if (focusRound === null) {
    return {
      ...base, seats,
      phase: session === "none" ? "no_session" : "awaiting_start",
      focusRoundKey: focusKey, focusRoundIndex: focusIndex,
      current: null,
      next: session === "none" ? null : { kind: "round", roundKey: focusKey, roundIndex: focusIndex, label: `准备第 ${focusIndex + 1} 轮` },
    };
  }
  const open = focus.performances.find((performance) => performance.state === "open");
  const notOpened = focus.performances
    .filter((performance) => performance.state === "not_opened")
    .sort((left, right) => left.sequence - right.sequence);
  const current = open === undefined ? null : {
    performanceId: open.id,
    sequence: open.sequence,
    participantId: open.contestantId,
    scoreCount: open.scoreCount,
    expectedJudges: open.expectedJudges,
  };
  const nextPerformance = notOpened[0];
  const readyToScore = session === "running" &&
    focusRound.state === "scoring" &&
    focus.panel !== null && focus.panel.current &&
    open !== undefined && seatsAssigned >= seats.minimum;
  if (focusRound.state === "prepared" || focusRound.state === "scoring") {
    if (open !== undefined) {
      const next = nextPerformance === undefined ? null : {
        kind: "performance" as const, roundKey: focusKey, roundIndex: focusIndex,
        sequence: nextPerformance.sequence, participantId: nextPerformance.contestantId,
        label: `第 ${focusIndex + 1} 轮 · 第 ${nextPerformance.sequence} 位`,
      };
      return { ...base, seats, readyToScore, phase: "scoring", focusRoundKey: focusKey, focusRoundIndex: focusIndex, current, next };
    }
    if (notOpened.length > 0) {
      const next = {
        kind: "performance" as const, roundKey: focusKey, roundIndex: focusIndex,
        sequence: notOpened[0]!.sequence, participantId: notOpened[0]!.contestantId,
        label: `第 ${focusIndex + 1} 轮 · 第 ${notOpened[0]!.sequence} 位`,
      };
      return { ...base, seats, phase: "awaiting_start", focusRoundKey: focusKey, focusRoundIndex: focusIndex, current: null, next };
    }
    return { ...base, seats, phase: "round_scored", focusRoundKey: focusKey, focusRoundIndex: focusIndex, current: null, next: null };
  }
  if (focusRound.state === "locked") {
    if (focus.ranking === null || focus.ranking.status === "hold") {
      return {
        ...base, seats, phase: "round_hold", focusRoundKey: focusKey, focusRoundIndex: focusIndex,
        current: null, next: { kind: "blocked", roundKey: focusKey, roundIndex: focusIndex, label: "先处理 HOLD/解析排名" },
      };
    }
    return {
      ...base, seats, phase: "round_resolved", focusRoundKey: focusKey, focusRoundIndex: focusIndex,
      current: null, next: nextLabel,
    };
  }
  return { ...base, seats, phase: "round_resolved", focusRoundKey: focusKey, focusRoundIndex: focusIndex, current: null, next: nextLabel };
}
```

- [ ] **Step 3: 测试**

覆盖：无会话、未 prepare、prepared 无 open、open、全 locked、hold、ranking ready、resolved 下一轮、下一轮未 prepare、全部 resolved、closed/archived、readyToScore 席位不足。

- [ ] **Step 4: 运行/提交**

```powershell
pnpm --filter @artflow-plus/web test -- liveCommandModel
pnpm --filter @artflow-plus/web run check
```

```bash
git add plus/apps/web/src/components/live
git commit -m "feat(live): derive the command console state"
```

---

## Task 2: `LiveCommandBar`

**Files:**
- Create: `plus/apps/web/src/components/live/LiveCommandBar.tsx`
- Test: `plus/apps/web/src/components/live/LiveCommandBar.test.tsx`
- Create: `plus/apps/web/src/styles/live-command.css`
- Modify: `plus/apps/web/src/styles/global.css`

- [ ] **Step 1: 组件**

Props：`state`、`canManageSession`、`canManageSetup`、`canManageCompetition`、`canManageResults`。

- 状态行：inactive → “活动已结束/已归档”；session running → “运行中 · {mode}”；none → “未启动评分会话”。
- 当前块：current 存在 → “第 N 轮 · 第 M 位 · 姓名”；`评分 {scoreCount}/{expectedJudges}`；`席位 {assigned}/{expected}（最低 {minimum}）`；readyToScore → “可评分”。
- 下一块：next.label；blocked 时显示“先处理 HOLD/解析排名”。
- 轮次 chips：`<a href={\`#round-${key}\`}>`，state 标签；hold 加警示。
- 告警：`round_hold` → “HOLD：并列待处理” + `#live-tie`；`异常与修正` + `#live-exception`；`评委入口` + `#live-session`（仅 canManageSession）。
- 主动作锚点：
  - no_session + active + canManageSession → `#live-session` “去启动会话”；
  - awaiting_start + canManageSetup → `#round-$focus` “去开始/准备”；
  - scoring → `#round-$focus` “去评分”；
  - round_scored + canManageSetup → `#round-$focus` “去锁定回合”；
  - round_hold + canManageCompetition → `#live-tie` “去处理 HOLD”；
  - round_resolved + canManageSetup → `#round-$next` “去下一轮”；
  - completed + canManageResults → `#live-result` “查看/发布赛果”；
  - inactive → 无。
- `data-testid="live-command"`；`progress` 元素带 `aria-label="评分进度"`；不复制任何命令。

- [ ] **Step 2: 样式**

`live-command.css`：横条卡片、三列、chips、alerts、progress；<900px 纵向；锚点 `min-height: 44px`；390px 无横向滚动；`scroll-margin-top` 对 `#live-session, #live-tie, #live-exception, #live-result, [id^="round-"]`。

- [ ] **Step 3: 组件测试**

- no_session：未启动 + 去启动锚点（按权限）；
- scoring：当前/评分/席位/ready；
- round_scored：去锁定；
- round_hold：HOLD + blocked next + 去处理（有权限）；
- completed：赛果锚点；
- inactive：无动作；
- 权限不足：不渲染对应锚点；
- 轮次 chips href。

- [ ] **Step 4: 运行/提交**

```powershell
pnpm --filter @artflow-plus/web test -- LiveCommandBar
pnpm --filter @artflow-plus/web run check
```

```bash
git add plus/apps/web/src
git commit -m "feat(live): add the command console bar"
```

---

## Task 3: 页面接入与锚点

**Files:**
- Modify: `plus/apps/web/src/routes/liveActivity.tsx`
- Modify: `plus/apps/web/src/components/live/LiveSessionPanel.tsx`
- Modify: `plus/apps/web/src/components/live/LiveRoundPanel.tsx`
- Modify: `plus/apps/web/src/components/live/ResultActions.tsx`
- Modify: `plus/apps/web/src/styles/live.css`

- [ ] **Step 1: 页面**

- `<LiveCommandBar state={state} canManageSession={canManageSession} canManageSetup={canManageSetup} canManageCompetition={canManageCompetition(session)} canManageResults={...}/>` 放在 header 之后；
- 轮次：`<div id={\`round-${live.config.key}\`} key={live.config.key}>` 包 `LiveRoundPanel` + `LiveExceptionPanel`（`id="live-exception"`）+ `LiveTieAdvancementPanel`（`id="live-tie"`）+ `LiveStaffScorePanel`；
- 会话卡 `id="live-session"`；结果卡 `id="live-result"`。

- [ ] **Step 2: 样式**

`live.css` 的 scroll-margin；确保轮次包裹不破坏 `.live-main-column` 布局。

- [ ] **Step 3: 运行/提交**

```powershell
pnpm --filter @artflow-plus/web test -- liveActivity
pnpm --filter @artflow-plus/web run check
```

```bash
git add plus/apps/web/src
git commit -m "feat(live): wire the command console anchors"
```

---

## Task 4: E2E、a11y、mobile

**Files:**
- Modify: `plus/apps/web/e2e/live-judge.spec.ts`
- Modify: `plus/apps/web/e2e/a11y.spec.ts`

- [ ] **Step 1: live-judge 断言**

- 初始：`getByTestId("live-command")` 含“未启动评分会话”；
- 启动会话后：含“运行中 · 彩排”；
- 准备/激活/开表演后：含“第 1 轮 · 第 1 位 · 林晓”“评分 0/1”；
- 评委提交后：含“评分 1/1”；
- 锁轮/排名后：不显示“已启动”类错误；会话关闭后含“未启动”或“全部轮次已完成”（按 focus 状态）；
- 保留现有面板断言。

- [ ] **Step 2: a11y**

`/live` 列表后，进入第一个 live 详情，`assertNoBlockingViolations(page, "/live/<id>")`；指挥条与面板一起审计。

- [ ] **Step 3: mobile**

既有 live 详情末尾的 measure 覆盖指挥条；确认锚点/芯片 ≥44px、无横向滚动。

- [ ] **Step 4: E2E/全量门禁**

```powershell
Set-Location plus
$env:ARTFLOW_PLUS_DATABASE_URL = "postgresql://artflow:artflow_dev@127.0.0.1:5433/artflow_plus"
$env:NO_PROXY = "127.0.0.1,localhost,::1"
$env:no_proxy = "127.0.0.1,localhost,::1"
pnpm --filter @artflow-plus/web test:e2e -- live-judge.spec.ts a11y.spec.ts mobile.spec.ts
pnpm run check
$env:REQUIRE_DB = "1"
pnpm run test
pnpm run build:prod
pnpm --filter @artflow-plus/contract-tools graph:check
```

仓库根：

```powershell
uv run pytest tests/gates -q
uv run python tests/golden/validate_fixtures.py
pwsh -NoProfile -File scripts/check_docs.ps1
```

- [ ] **Step 5: 提交/合并/CI**

```bash
git add -A
git commit -m "test(live): cover the command console"
```

合并 `feat/live-command-console` 到 `main`，推送后盯 Gates / Security / Workflow lint。
