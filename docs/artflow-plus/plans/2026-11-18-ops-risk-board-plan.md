# Ops 跨活动风险看板实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 `/ops` 增加跨活动风险看板：批量读取未归档活动的 attention，投影成阻塞/关注/准备中/就绪/已结束，带原因、计数、权限安全和跳转。

**Architecture:** 新增只读 `GET /api/operations/risks`（复用 `readActivityAnalytics` + `buildActivityAnalyticsView`）；前端用纯 `riskCatalog` + `deriveRiskRow` 投影；`/ops` 底表仍是 `fetchOpsActivities`（含归档），风险按 id 合并；详情页只加锚点与共享文案。

**Tech Stack:** TypeScript、Fastify/Kysely、React 19、TanStack Query/Router、Vitest、Playwright。

**Spec:** [`2026-11-18-ops-risk-board-design.md`](../specs/2026-11-18-ops-risk-board-design.md)

---

## Test architecture

按 spec §6：**契约**（一个只读 route，无新命令/事件/表）；**消费者**（web `fetchOperationsRisks`、`/ops`、详情锚点、graph）；**生命周期**（draft/active/closed/archived；ROSTER_NOT_FINAL 非阻塞；closed 赛果冻结）；**适配器**（无新 adapter）；**故障**（无 analytics 权限、单活动读失败、归档、未知 code、Live 权限回退、快照过期）；**防膨胀 / anti-bloat**（复用 analytics；一个纯 catalog；扩展 registration-loop E2E）；**门禁**（下方命令）。

---

## Task 1: 批量风险读模型

**Files:**
- Create: `plus/packages/contracts/src/operations-risk.ts`
- Modify: `plus/packages/contracts/src/index.ts`
- Create: `plus/packages/runtime/src/operations-risk-service.ts`
- Modify: `plus/packages/runtime/src/index.ts`
- Create: `plus/apps/api/src/routes/operations.ts`
- Modify: `plus/apps/api/src/app.ts`
- Test: `plus/packages/runtime/test/operations-risk-service.test.ts`
- Test: `plus/apps/api/test/operations-risk.test.ts`

- [ ] **Step 1: 写契约**

```ts
// operations-risk.ts
import { Type, type Static } from "@sinclair/typebox";

const RiskAttentionSchema = Type.Object({
  code: Type.String({ minLength: 1, maxLength: 100 }),
  count: Type.Optional(Type.Integer({ minimum: 1 })),
});

const RiskActivitySchema = Type.Object({
  id: Type.String({ minLength: 1 }),
  title: Type.String({ minLength: 1 }),
  publicCode: Type.String({ minLength: 1 }),
  status: Type.Union([
    Type.Literal("draft"), Type.Literal("active"),
    Type.Literal("closed"), Type.Literal("archived"),
  ]),
  enabledCapabilities: Type.Array(Type.String({ minLength: 1 })),
});

export const OperationsRiskResponseSchema = Type.Object({
  activities: Type.Array(Type.Object({
    activity: RiskActivitySchema,
    attention: Type.Array(RiskAttentionSchema),
  })),
});

export type OperationsRiskResponse = Static<typeof OperationsRiskResponseSchema>;
```

在 `contracts/src/index.ts` 导出 schema 和 type。

- [ ] **Step 2: 写 runtime 服务**

```ts
// operations-risk-service.ts
import { listActivities, readActivityAnalytics } from "@artflow-plus/db";
import type { Database } from "@artflow-plus/db";
import { DomainError, hasPermission } from "@artflow-plus/domain";
import type { Kysely } from "kysely";

import { ACTIVITY_ANALYTICS_READ_PERMISSIONS, buildActivityAnalyticsView } from "./analytics-service.js";
import { runtimeActor, type RuntimeDeps } from "./deps.js";

export async function getOperationsRiskBoard(
  db: Kysely<Database>,
  deps: RuntimeDeps,
): Promise<{
  activities: {
    activity: {
      id: string; title: string; publicCode: string; status: string;
      enabledCapabilities: readonly string[];
    };
    attention: { code: string; count?: number }[];
  }[];
}> {
  const actor = runtimeActor(deps);
  if (!ACTIVITY_ANALYTICS_READ_PERMISSIONS.some((permission) => hasPermission(actor, permission))) {
    throw new DomainError("FORBIDDEN", "An analytics permission is required.");
  }
  const activities = (await listActivities(db)).filter((activity) => activity.status !== "archived");
  const rows = await Promise.all(activities.map(async (activity) => {
    const view = buildActivityAnalyticsView(activity, await readActivityAnalytics(db, activity.id));
    return {
      activity: {
        id: activity.id,
        title: activity.title,
        publicCode: activity.publicCode,
        status: activity.status,
        enabledCapabilities: activity.enabledCapabilities,
      },
      attention: view.attention.map((item) =>
        item.count === undefined ? { code: item.code } : { code: item.code, count: item.count },
      ),
    };
  }));
  return { activities: rows };
}
```

- [ ] **Step 3: 写 route**

```ts
// routes/operations.ts
import { OperationsRiskResponseSchema } from "@artflow-plus/contracts";
import type { ApiContext } from "../http/context.js";
import { getOperationsRiskBoard } from "@artflow-plus/runtime";

export function registerOperationsRoutes(ctx: ApiContext): void {
  const { app, db, requestDeps } = ctx;
  app.get(
    "/api/operations/risks",
    { schema: { response: { 200: OperationsRiskResponseSchema } }, config: { access: "analytics" } },
    async (request) => getOperationsRiskBoard(db, await requestDeps(request)),
  );
}
```

`app.ts`：`import { registerOperationsRoutes } ...;`，在 `registerActivityRoutes` 后 `registerOperationsRoutes(routeContext);`。
`runtime/src/index.ts`：导出 `getOperationsRiskBoard`。

- [ ] **Step 4: runtime 测试**

`operations-risk-service.test.ts`：建 schema、migrate；seed 4 个活动：
- `active` + registration，插入一条 `submitted` 报名；
- `active` + competition，roster unknown；
- `closed` + archive capability，无归档包；
- `archived`；
用户 `permissions: ["registration.review"]`；断言：
- 返回 3 个（archived 排除）；
- active 有 `REGISTRATION_REVIEW_PENDING`/`ROSTER_NOT_FINAL`；
- closed 有 `ARCHIVE_MISSING`；
- 无 analytics 权限（`tasks.manage`）→ `FORBIDDEN`；
- 单活动 analytics 读失败（临时 drop 某表或用 spy）→ 整个 Promise 拒绝，不返回部分数据。

- [ ] **Step 5: API 测试**

`apps/api/test/operations-risk.test.ts`：`buildApp`；登录 analytics 权限用户；`GET /api/operations/risks` 200 形状；`tasks.manage` 用户 403。

- [ ] **Step 6: 运行**

```powershell
Set-Location plus
$env:ARTFLOW_PLUS_DATABASE_URL = "postgresql://artflow:artflow_dev@127.0.0.1:5433/artflow_plus"
$env:REQUIRE_DB = "1"
pnpm --filter @artflow-plus/runtime test -- operations-risk
pnpm --filter @artflow-plus/api test -- operations-risk
pnpm run check
```

- [ ] **Step 7: 提交**

```bash
git add plus/packages/contracts plus/packages/runtime plus/apps/api
git commit -m "feat(ops): add the cross-activity risk read model"
```

---

## Task 2: 风险目录与 web API

**Files:**
- Modify: `plus/apps/web/src/api/ops.ts`
- Create: `plus/apps/web/src/components/ops/riskCatalog.ts`
- Create: `plus/apps/web/src/components/ops/riskCatalog.test.ts`
- Modify: `plus/apps/web/src/auth/SessionProvider.tsx`

- [ ] **Step 1: `fetchOperationsRisks`**

```ts
import type { OperationsRiskResponse } from "@artflow-plus/contracts";
export type { OperationsRiskResponse } from "@artflow-plus/contracts";

export function fetchOperationsRisks(): Promise<OperationsRiskResponse> {
  return apiFetch<OperationsRiskResponse>("/api/operations/risks");
}
```

- [ ] **Step 2: `hasAnalyticsAccess`**

在 `SessionProvider.tsx` 加：

```ts
const ANALYTICS_READ_PERMISSIONS = [
  "studio.manage", "competition.manage", "judge.manage",
  "registration.manage", "registration.review", "registration.roster.finalize",
  "materials.manage", "materials.review", "grouping.manage", "voting.manage",
  "result.manage", "archive.manage", "ticket.manage",
] as const;

export function hasAnalyticsAccess(session: SessionResponse | null): boolean {
  if (session === null) return false;
  const { permissions } = session.actor;
  return permissions.includes("*") ||
    ANALYTICS_READ_PERMISSIONS.some((permission) => permissions.includes(permission));
}
```

- [ ] **Step 3: `riskCatalog.ts`**

```ts
import type { OperationsRiskResponse } from "../../api/ops.js";

export type RiskSeverity = "critical" | "warning";
export type RiskArea = "registration" | "materials" | "roster" | "voting" | "competition" | "results" | "archive" | "other";
export type RiskTarget =
  | { kind: "anchor"; id: "registration" | "roster" | "voting" | "archive" }
  | { kind: "live" }
  | { kind: "public-results" }
  | { kind: "none" };

export type RiskRowStatus = "blocked" | "attention" | "preparing" | "ready" | "closed";

export interface RiskActivity {
  readonly id: string;
  readonly title: string;
  readonly publicCode: string;
  readonly status: "draft" | "active" | "closed" | "archived";
  readonly enabledCapabilities: readonly string[];
}

export interface RiskItem {
  readonly code: string;
  readonly count?: number;
  readonly title: string;
  readonly reason: string;
  readonly area: RiskArea;
  readonly severity: RiskSeverity;
  readonly actionLabel: string;
  readonly target: RiskTarget;
}

export interface RiskRow {
  readonly activity: RiskActivity;
  readonly status: RiskRowStatus;
  readonly critical: number;
  readonly warning: number;
  readonly items: readonly RiskItem[];
}

interface Definition {
  readonly title: string;
  readonly reason: string;
  readonly area: RiskArea;
  readonly actionLabel: string;
}

const DEFINITIONS: Readonly<Record<string, Definition>> = {
  REGISTRATION_REVIEW_PENDING: {
    title: "报名待审核", area: "registration", actionLabel: "去审核",
    reason: "还有报名处于已提交/待补充，审核后才能定稿名单。",
  },
  REQUIRED_MATERIALS_PENDING: {
    title: "必交材料未通过", area: "materials", actionLabel: "去处理",
    reason: "还有必交材料未通过审核，会影响名单与参赛资格。",
  },
  ROSTER_NOT_FINAL: {
    title: "名单未定稿", area: "roster", actionLabel: "去定稿",
    reason: "最终名单尚未定稿；Live 使用已通过报名，但运营记录需要定稿。",
  },
  FORMAL_VOTE_OPEN: {
    title: "正式投票开放", area: "voting", actionLabel: "去投票",
    reason: "正式投票仍在开放，结果发布前需要结束并确认。",
  },
  COMPETITION_ROUND_NOT_LOCKED: {
    title: "回合未锁定", area: "competition", actionLabel: "去 Live",
    reason: "还有比赛回合未锁定，结果不能视为最终。",
  },
  RESULT_STALE: {
    title: "赛果来源已变化", area: "results", actionLabel: "去 Live",
    reason: "已确认赛果的来源发生变化，继续推进或发布可能写出错误结果。",
  },
  RESULT_RELEASE_PENDING: {
    title: "赛果待发布", area: "results", actionLabel: "去 Live",
    reason: "还有赛果待确认或发布。",
  },
  ARCHIVE_MISSING: {
    title: "尚未归档", area: "archive", actionLabel: "去归档",
    reason: "活动已关闭但还没有当前归档包。",
  },
};

const PRE_EVENT = new Set(["registration", "materials", "roster", "voting", "competition"]);
const POST_EVENT = new Set(["results", "archive"]);

export function visibleFor(status: RiskActivity["status"], area: RiskArea): boolean {
  if (status === "archived") return false;
  if (status === "draft") return PRE_EVENT.has(area);
  if (status === "closed") return POST_EVENT.has(area) || area === "other";
  return true;
}

export function severityFor(status: RiskActivity["status"], area: RiskArea): RiskSeverity {
  return status === "active" && area === "results" ? "critical" : "warning";
}

export function targetFor(code: string, activity: RiskActivity): RiskTarget {
  if (code === "COMPETITION_ROUND_NOT_LOCKED" || code === "RESULT_RELEASE_PENDING") {
    return activity.status === "closed"
      ? { kind: "public-results" }
      : { kind: "live" };
  }
  if (code === "RESULT_STALE") {
    return activity.status === "closed" ? { kind: "public-results" } : { kind: "live" };
  }
  if (code === "REGISTRATION_REVIEW_PENDING" || code === "REQUIRED_MATERIALS_PENDING") {
    return { kind: "anchor", id: "registration" };
  }
  if (code === "ROSTER_NOT_FINAL") return { kind: "anchor", id: "roster" };
  if (code === "FORMAL_VOTE_OPEN") return { kind: "anchor", id: "voting" };
  if (code === "ARCHIVE_MISSING") return { kind: "anchor", id: "archive" };
  return { kind: "none" };
}

export function describeRisk(code: string, activity: RiskActivity, count?: number): RiskItem | null {
  const definition = DEFINITIONS[code] ?? {
    title: code, area: "other" as const, actionLabel: "查看",
    reason: "未识别的运营注意项，请检查 analytics 的新码。",
  };
  if (!visibleFor(activity.status, definition.area)) return null;
  return {
    code,
    ...(count === undefined ? {} : { count }),
    ...definition,
    severity: severityFor(activity.status, definition.area),
    target: targetFor(code, activity),
  };
}

export function deriveRiskRow(
  activity: RiskActivity,
  attention: readonly { code: string; count?: number }[],
): RiskRow {
  const items = attention
    .map((item) => describeRisk(item.code, activity, item.count))
    .filter((item): item is RiskItem => item !== null);
  const critical = items.filter((item) => item.severity === "critical").length;
  const warning = items.length - critical;
  const status: RiskRowStatus =
    activity.status === "draft" ? "preparing"
      : activity.status === "closed" ? "closed"
        : critical > 0 ? "blocked"
          : warning > 0 ? "attention"
            : "ready";
  return { activity, status, critical, warning, items };
}

export function deriveRiskSummary(rows: readonly RiskRow[]): Record<RiskRowStatus, number> {
  return rows.reduce<Record<RiskRowStatus, number>>(
    (summary, row) => ({ ...summary, [row.status]: summary[row.status] + 1 }),
    { blocked: 0, attention: 0, preparing: 0, ready: 0, closed: 0 },
  );
}
```

- [ ] **Step 4: catalog 测试**

覆盖：
- `REGISTRATION_REVIEW_PENDING` active → warning, registration anchor；
- `ROSTER_NOT_FINAL` active + competition → warning，不是 critical；
- `RESULT_STALE` active → critical；closed → warning + public-results；
- draft 只显示准备项；closed 只显示赛后项；archived 全部 null；
- 未知 code → other/warning，不丢弃；
- `deriveRiskSummary` 计数。

- [ ] **Step 5: 运行**

```powershell
pnpm --filter @artflow-plus/web test -- riskCatalog
pnpm --filter @artflow-plus/web run check
```

- [ ] **Step 6: 提交**

```bash
git add plus/apps/web/src/api/ops.ts plus/apps/web/src/auth/SessionProvider.tsx plus/apps/web/src/components/ops
git commit -m "feat(ops): add the risk catalog and bulk risk client"
```

---

## Task 3: `/ops` 页面改造

**Files:**
- Modify: `plus/apps/web/src/routes/ops.tsx`
- Create/Modify: `plus/apps/web/src/routes/ops.test.tsx`
- Modify: `plus/apps/web/src/styles/ops.css`

- [ ] **Step 1: 数据与权限**

`OpsContent`：
- `hasAnalyticsAccess(session)`；`riskQuery = useQuery({ queryKey: ["ops-risks"], queryFn: fetchOperationsRisks, enabled: allowed && analyticsAllowed, retry: false })`；
- 底表 `query` 保持 `fetchOpsActivities`；
- `riskRows = riskQuery.data?.activities.map(({activity, attention}) => deriveRiskRow(activity, attention)) ?? []`；
- `riskById = new Map(riskRows.map(row => [row.activity.id, row]))`；
- `summary = deriveRiskSummary(riskRows)`；
- 风险面板：`analyticsAllowed === false` → “风险看板需要分析权限”；`riskQuery.error` → 错误 + 重试；否则汇总。

- [ ] **Step 2: 列表与风险合并**

- `filteredActivities` 在原有搜索/状态过滤上加 `onlyRisk`：`onlyRisk ? (riskById.get(id)?.items.length ?? 0) > 0 : true`；
- 排序：`blocked` → `attention` → `preparing` → `ready` → `closed` → 无风险/归档；同组按标题；
- 表格新增“风险”“风险项”列：
  - 风险 badge：blocked “有阻塞”、attention “需关注”、preparing “准备中”、ready “就绪”、closed “已结束”、archived “已归档”；
  - 计数 `critical/warning`；
  - 风险项单元格：前 2 条 `title` + 计数 + “等 N 项”；`<details>` 展开完整 `reason` 和动作。
- 动作：
  - `target.kind === "anchor"` → `Link to="/ops/$activityId" hash={id}`（hash 不存在时停在详情页顶部）；
  - `kind === "live"` → 仅 `hasLiveAccess(session)` 时 `Link to="/live/$activityId"`，否则 `Link` 到 Ops 详情；
  - `kind === "public-results"` → `Link to="/results/$publicCode"`；
  - `kind === "none"` → 无动作。
- 归档行：风险列“—”；不进入汇总。
- 空状态/错误态保留。

- [ ] **Step 3: 样式**

`ops.css` 增加 `.risk-summary`、`.risk-badge--blocked/attention/preparing/ready/closed`、`.risk-items`、`.risk-item`、`details`；移动端 `data-label`；不引入图表库。

- [ ] **Step 4: 页面测试**

`ops.test.tsx`（mock `fetchOpsActivities`/`fetchOperationsRisks`/`hasAnalyticsAccess`）：
- 汇总 `阻塞 1 · 需关注 1`；
- 行风险 badge、details 原因、`#registration` 链接；
- “只看有风险”过滤 ready/归档；
- 无 analytics 权限：风险面板提示，列表仍显示；
- 风险 query 错误：错误 + 重试，列表不阻塞；
- 归档行“已归档”+ 风险“—”。

- [ ] **Step 5: 运行/提交**

```powershell
pnpm --filter @artflow-plus/web test -- ops
pnpm --filter @artflow-plus/web run check
```

```bash
git add plus/apps/web/src
git commit -m "feat(ops): add the cross-activity risk board"
```

---

## Task 4: 详情锚点与共享文案

**Files:**
- Modify: `plus/apps/web/src/routes/opsActivity.tsx`
- Modify: `plus/apps/web/src/components/ops/ActivityAnalyticsCard.tsx`
- Modify: `plus/apps/web/src/components/ops/ActivityAnalyticsCard.test.tsx`
- Modify: `plus/apps/web/src/styles/ops.css`
- Modify: `plus/apps/web/src/routes/opsActivity.test.tsx`

- [ ] **Step 1: 锚点**

- 报名 `<Card id="registration">`；
- `<div id="roster">` 包 `RosterCard`；
- `<div id="voting">` 包 `VotingCard`；
- `<div id="archive">` 包 `ArchiveCard`；
- `ops.css`：`#registration, #roster, #voting, #archive { scroll-margin-top: 24px; }`。

- [ ] **Step 2: 共享文案/可见性**

`ActivityAnalyticsCard`：
- 用 `describeRisk(item.code, analytics.activity, item.count)`（或 `visibleFor` + 标题/原因）过滤；
- 列表显示标题、计数、原因；未知 code 显示原码；
- 不再维护第二份 `ATTENTION_LABELS`。

`ActivityAnalyticsCard.test.tsx`：
- active 的 registration 项显示标题/原因；
- closed 的 registration 项被隐藏、archive 项显示；
- unknown code 显示原码。

- [ ] **Step 3: 运行/提交**

```powershell
pnpm --filter @artflow-plus/web test -- ActivityAnalyticsCard opsActivity
pnpm --filter @artflow-plus/web run check
```

```bash
git add plus/apps/web/src
git commit -m "feat(ops): anchor the detail cards and share risk copy"
```

---

## Task 5: E2E、a11y 与收尾

**Files:**
- Modify: `plus/apps/web/e2e/registration-loop.spec.ts`
- Modify: `plus/apps/web/e2e/a11y.spec.ts`（如需要）

- [ ] **Step 1: registration-loop 风险看板断言**

在参与者提交后、Ops 登录后：

```ts
await ops.goto("/ops");
const riskRow = ops.getByRole("row", { name: /2026 院十佳报名/ });
await expect(riskRow).toContainText("需关注");
await riskRow.getByText("查看原因").click();
await expect(riskRow.getByText(/报名仍有待审核项|报名待审核/)).toBeVisible();
await riskRow.getByRole("link", { name: "去审核" }).click();
await expect(ops).toHaveURL(/\/ops\/act-e2e-registration#registration$/);
```

然后继续现有审批流程；审批后：

```ts
await ops.goto("/ops");
await expect(ops.getByRole("row", { name: /2026 院十佳报名/ })).not.toContainText("报名待审核");
```

（材料/名单项可能仍在；只断言报名项消失。）

- [ ] **Step 2: a11y**

`/ops` 已在审计面；确认风险 badge/details 无 serious/critical。如 `/ops` 的 ready selector 受新汇总影响，保持 `getByRole("table", { name: "活动列表" })`。

- [ ] **Step 3: E2E**

```powershell
Set-Location plus
$env:ARTFLOW_PLUS_DATABASE_URL = "postgresql://artflow:artflow_dev@127.0.0.1:5433/artflow_plus"
$env:NO_PROXY = "127.0.0.1,localhost,::1"
$env:no_proxy = "127.0.0.1,localhost,::1"
pnpm --filter @artflow-plus/web test:e2e -- registration-loop.spec.ts a11y.spec.ts
```

- [ ] **Step 4: 全量门禁**

```powershell
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
git commit -m "test(ops): cover the cross-activity risk board"
```

合并 `feat/ops-risk-board` 到 `main`，推送后盯 Gates / Security / Workflow lint。
