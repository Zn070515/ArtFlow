# Ops 跨活动风险看板设计

- **Status**: proposed
- **Date**: 2026-11-18
- **Scope**: `/ops` 跨活动风险总览；新增 `GET /api/operations/risks` 批量读模型；详情页只加锚点与共享文案；不改命令、事实、事件、表
- **相关**: [GOAL](../../../GOAL.md)、[analytics-service](../../../plus/packages/runtime/src/analytics-service.ts)、[Ops 前端视觉](../frontend-design-direction.md)

## 0. 结论

1. **`/ops` 升级为跨活动风险看板**：一次读取所有未归档活动的 `attention`，前端投影成阻塞/关注/准备中/就绪/已结束，带计数、原因、跳转。
2. **归档活动不消失**：`/ops` 列表仍以 `fetchOpsActivities`（全部状态）为底表；风险数据按活动 id 合并；归档行显示“已归档”，不读 analytics、不进入风险计数。
3. **权限不足时降级而不是整页失败**：`hasOpsAccess` 包含 `competition.score.write`、`attendance.manage`、`tasks.manage`，它们不在 `ACTIVITY_ANALYTICS_READ_PERMISSIONS` 里；风险看板必须单独用 `hasAnalyticsAccess` 开启，403/500 只让风险面板显示不可用，活动列表仍可打开。
4. **不制造假阻塞**：Live 的 `participantIds` 来自 `listApprovedParticipantIds`，不是最终名单；`ROSTER_NOT_FINAL` 只是 warning。第一版唯一的 critical 是 **active 活动的 `RESULT_STALE`**（已确认赛果的来源变化，继续推进/发布可能写出错误结果）。
5. **closed 的赛果是冻结的**：`releaseResult` 需要运行中的 publishing 会话（`lockPublishingActivity`），closed 活动无法重新发布；closed 的 `RESULT_STALE`/`RESULT_RELEASE_PENDING` 只做只读提示并链到公开赛果，不提供“去处理”。
6. **draft/closed 不显示“阻塞”**：draft 是“准备中”，只显示准备项（报名/材料/名单/投票/比赛），动作是“查看/准备”；closed 是“已结束”，只显示事后项（赛果、归档），其中只有归档可执行。
7. **看板是近实时快照**：每个活动独立读取 analytics，不是跨活动一致事务；页面在挂载/重新聚焦时刷新，详情页操作后需要返回/刷新；不新增实时推送。

## 1. 目标与非目标

### 目标

- 组织者在 `/ops` 一眼看到哪些活动有阻塞/关注项，以及每项的原因、计数和下一步。
- 所有风险来自现有 `analytics.attention`，不新增第二套业务事实。
- 风险项跳转到真正能处理它的卡片（详情页锚点）或 Live/公开赛果。
- 权限不足、依赖失败、归档活动都有明确降级。

### 非目标

- 不做活动页完整风险看板（详情页保留 `ActivityAnalyticsCard`，只共享文案/可见性并加锚点）。
- 不做批量 SQL 优化、缓存、推送；第一版接受 per-activity 读取。
- 不新增 attention 码（公开主页、日程发布等风险另开设计）。
- 不把 go/no-go 变成命令拦截。
- 不改 `/ops/$activityId` 的卡片布局。

## 2. 批量读模型

### 2.1 接口

`GET /api/operations/risks`，`access: "analytics"`：

```json
{
  "activities": [
    {
      "activity": {
        "id": "act_...",
        "title": "2026 院十佳",
        "publicCode": "E2E-REG",
        "status": "active",
        "enabledCapabilities": ["registration", "questionnaire", "materials"]
      },
      "attention": [
        { "code": "REGISTRATION_REVIEW_PENDING", "count": 3 },
        { "code": "ROSTER_NOT_FINAL" }
      ]
    }
  ]
}
```

- `attention` 只返回 `code` + 可选 `count`；**不返回 severity**，严重度由前端 risk catalog 决定（避免 API 里“warning”与前端 critical 两套说法）。
- 只返回 `status !== "archived"` 的活动；归档活动的 analytics 不读。
- 新 `OperationsRiskResponseSchema` 加入 `@artflow-plus/contracts`；web `fetchOperationsRisks` 使用同一类型。

### 2.2 运行时服务

`plus/packages/runtime/src/operations-risk-service.ts`：

```ts
export async function getOperationsRiskBoard(db, deps): Promise<OperationsRiskResponse> {
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
      attention: view.attention.map((item) => ({ code: item.code, ...(item.count === undefined ? {} : { count: item.count }) })),
    };
  }));
  return { activities: rows };
}
```

- 任一活动读取失败 → 整个请求失败，页面显示错误并可重试；不返回半真数据。
- 每个活动独立读取，不是跨活动一致快照；这是第一版接受的 N 次读取，未来可换批量 SQL 而不改契约。
- 权限与 `getActivityAnalytics` 共用 `ACTIVITY_ANALYTICS_READ_PERMISSIONS`。

### 2.3 接口注册

- 新 `plus/apps/api/src/routes/operations.ts`：`registerOperationsRoutes(ctx)`，注册 `/api/operations/risks`，`config: { access: "analytics" }`，响应 schema。
- `app.ts` 组合注册；route module gate 通过（模块被引用、无重复 method+URL、<900 行）。
- Consumer Graph：web `fetchOperationsRisks` 消费该 route，`graph:check` 零 unresolved。

## 3. 风险目录与生命周期

### 3.1 目录

`riskCatalog.ts`（纯函数）：

```ts
type RiskSeverity = "critical" | "warning";
type RiskArea = "registration" | "materials" | "roster" | "voting" | "competition" | "results" | "archive" | "other";
type RiskTarget =
  | { kind: "anchor"; id: "registration" | "roster" | "voting" | "archive" }
  | { kind: "live" }
  | { kind: "public-results" }
  | { kind: "none" };

interface RiskDefinition {
  title: string;
  reason: string;
  area: RiskArea;
  actionLabel: string;
}
```

| code | area | severity | draft | active | closed | target |
| --- | --- | --- | --- | --- | --- | --- |
| `REGISTRATION_REVIEW_PENDING` | registration | warning | 准备项 | 关注 | 隐藏 | `#registration` |
| `REQUIRED_MATERIALS_PENDING` | materials | warning | 准备项 | 关注 | 隐藏 | `#registration` |
| `ROSTER_NOT_FINAL` | roster | warning | 准备项 | 关注 | 隐藏 | `#roster` |
| `FORMAL_VOTE_OPEN` | voting | warning | 准备项 | 关注 | 隐藏 | `#voting` |
| `COMPETITION_ROUND_NOT_LOCKED` | competition | warning | 准备项 | 关注 | 隐藏 | Live |
| `RESULT_STALE` | results | **critical（仅 active）** | 隐藏 | 阻塞 | 只读提示（warning） | active=Live；closed=公开赛果 |
| `RESULT_RELEASE_PENDING` | results | warning | 隐藏 | 关注 | 只读提示 | active=Live；closed=公开赛果 |
| `ARCHIVE_MISSING` | archive | warning | 隐藏 | 隐藏 | 待处理 | `#archive` |
| 未知 code | other | warning | 显示 | 显示 | 显示 | 无 |

- **`ROSTER_NOT_FINAL` 不是阻塞**：Live 用 `listApprovedParticipantIds`，最终名单不是 Live 的前置；只提示运营侧名单未定稿。
- **`RESULT_STALE` 只在 active 时 critical**：closed 的赛果已冻结，`releaseResult` 需要运行中会话，closed 无法重新发布；closed 只读提示。
- **draft/closed 不出现 critical**：draft 是准备中；closed 是已结束。
- **visibleFor(status, code)**：draft 只显示准备项（报名/材料/名单/投票/比赛）；closed 只显示事后项（赛果/归档）；archived 不进入看板。
- 未知 code 不丢弃，显示原码并标记“未识别的注意项”，便于发现后端新增码。

### 3.2 状态推导

```text
active + 任一 critical        -> blocked
active + 只有 warning         -> attention
active + 无 attention         -> ready
draft                         -> preparing
closed                        -> closed
archived                      -> 不进入风险数据
```

- 汇总：`阻塞 X · 需关注 Y · 准备中 Z · 就绪 W · 已结束 V`。
- 默认排序：blocked → attention → preparing → ready → closed；同组按标题。
- 归档活动保留在 `/ops` 底表，风险列显示“—”，不进入上面的汇总。

### 3.3 动作语义

| 状态 | 动作文案 | 说明 |
| --- | --- | --- |
| active | “去处理” | 目标卡片的命令可能仍因权限/状态被拒；看板不替代命令校验 |
| draft | “查看/准备” | 只跳转查看；报名审核/名单定稿等命令要求 active，不承诺可执行 |
| closed | 归档项“去归档”；赛果项“查看赛果” | 赛果已冻结，不能重新发布 |
| archived | 无 | 只显示状态 |

- Live 目标只在 `hasLiveAccess(session)` 时渲染；否则回退到 Ops 详情（只读）。
- `#registration`/`#roster` 卡片受权限控制；锚点不存在时浏览器停在详情页顶部，链接仍是详情页。
- go/no-go 只是提示，不阻止任何命令；真正的拒绝仍来自 `executeCommand`。

## 4. `/ops` 页面

- **底表**：`fetchOpsActivities`（全部状态，含 archived）继续作为活动列表；`fetchOperationsRisks` 按 id 合并。
- **权限降级**：
  - `hasAnalyticsAccess(session)` 为 false 时不发风险请求，风险面板显示“风险看板需要分析权限”，列表仍可用；
  - 风险请求 403/500 时只让风险面板显示错误 + 重试，列表不阻塞；
  - 风险数据缺失的行风险列显示“—”。
- **标题**：`运营风险`；顶部汇总卡 + “只看有风险”开关；保留搜索、状态筛选、分页。
- **表格列**：活动、公开码、状态、风险（badge + 计数）、风险项、操作。
- **风险项单元格**：前 2 条标题 + “等 N 项”；`<details>` 展开完整原因、计数、动作链接；表格 `<caption>` 保持“活动列表”。
- **空状态**：没有活动 / 没有匹配风险 / 风险看板无权限或不可用。
- **移动端**：`data-label`、`<details>` 可用；不引入图表库。
- **刷新**：`useQuery` 挂载/窗口聚焦刷新；详情操作后返回或刷新；不做实时推送。

## 5. 详情页锚点与共享文案

- `#registration`：报名卡；`#roster`：名单卡外层；`#voting`：投票卡外层；`#archive`：归档卡外层。
- `scroll-margin-top` 防顶栏遮挡。
- `ActivityAnalyticsCard` 的 attention 列表改用同一 `riskCatalog` 的 `visibleFor`、标题和原因，避免详情/看板两套文案与两套可见性。

## 6. Test architecture

### 6.1 契约与能力

- 新增一个只读 route；不新增 capability、命令、事件、表、topic。
- 风险看板不进入 authority 路径；不阻止命令。

### 6.2 消费者、读模型、路由、事件、topic

- 新 route `/api/operations/risks` 被 web `fetchOperationsRisks` 消费；`graph:check` 零 unresolved。
- 不新增 read model 表或事件；复用 `readActivityAnalytics` + `buildActivityAnalyticsView`。
- `/ops` 与 `/ops/$activityId` 页面行为变化。

### 6.3 生命周期边界、终态与 mode 隔离

- draft 只显示准备项；active 才可能 blocked；closed 只显示事后项且赛果只读；archived 不进入风险数据但保留在列表。
- `ROSTER_NOT_FINAL` 不是 Live 前置；`RESULT_STALE` 只有 active 才 critical。
- closed 的 `RESULT_STALE`/`RESULT_RELEASE_PENDING` 不提供发布动作；`releaseResult` 的运行中会话要求不被绕过。
- 权限：`ACTIVITY_ANALYTICS_READ_PERMISSIONS` 与 `hasOpsAccess` 的差集必须降级，不整页失败。
- 快照：每个活动独立读取；看板不声称跨活动一致。

### 6.4 适配器

- 不新增 capability adapter；runtime 服务测试用真实 PostgreSQL；web 用组件测试 + 现有 E2E。

### 6.5 故障注入与恢复状态

| 故障 | 注入方式 | 断言 |
| --- | --- | --- |
| 无 analytics 权限 | 用户只有 `tasks.manage` | route 403；页面风险面板不可用；活动列表仍可打开 |
| 一个活动 analytics 读失败 | 测试中让该活动读取抛错 | endpoint 500，不返回部分数据；页面错误 + 重试 |
| 归档活动 | 列表含 archived | 风险数据不含；底表仍显示“已归档”；风险列“—” |
| draft 活动 | draft + registration | 状态“准备中”；只显示准备项；无 critical |
| closed 活动 | closed + 无归档 + stale 结果 | 状态“已结束”；只显示赛果/归档；赛果链接公开结果；无发布动作 |
| 未知 attention code | 注入 `NEW_CODE` | 显示原码；不崩溃；不丢弃 |
| 权限不足的 Live 目标 | 用户无 `hasLiveAccess` | 赛果/比赛项不渲染 Live 链接，回退 Ops 详情 |
| 快照过期 | 详情操作后返回 `/ops` | 页面重新请求；不依赖缓存伪造 |

### 6.6 现有测试为什么不够

- 现有 `ActivityAnalyticsCard` 只显示码和计数，没有 severity/原因/跳转/状态可见性；
- `/ops` 列表没有风险列，也没有跨活动汇总；
- 现有 `opsActivity.test.tsx` 只覆盖详情卡片；
- 没有针对 analytics 权限差集、归档保留、closed 赛果冻结的测试。

### 6.7 防膨胀 / anti-bloat

- 一个纯函数 `riskCatalog` + 一个 `OpsRiskPage` 改造；不新建第二个 Ops 页面。
- 后端一个只读 route + 一个 runtime 服务；复用 analytics，不复制聚合逻辑。
- 测试：runtime 服务 1 个文件、web catalog/页面 2 个文件、API route 1 个用例、扩展 `registration-loop.spec.ts`；不新建 E2E 套件。
- 不引入图表库、状态库或新的设计系统。

### 6.8 聚焦门禁

```powershell
Set-Location plus
pnpm run check
pnpm --filter @artflow-plus/runtime test -- operations-risk
pnpm --filter @artflow-plus/api test -- operations-risk
pnpm --filter @artflow-plus/web test -- riskCatalog ops
$env:ARTFLOW_PLUS_DATABASE_URL = "postgresql://artflow:artflow_dev@127.0.0.1:5433/artflow_plus"
$env:NO_PROXY = "127.0.0.1,localhost,::1"
pnpm --filter @artflow-plus/web test:e2e -- registration-loop.spec.ts a11y.spec.ts
pnpm run test
pnpm run build:prod
pnpm --filter @artflow-plus/contract-tools graph:check
```

仓库级：

```powershell
uv run pytest tests/gates -q
uv run python tests/golden/validate_fixtures.py
pwsh -NoProfile -File scripts/check_docs.ps1
```

## 7. 实施顺序

1. `OperationsRiskResponseSchema` + runtime `getOperationsRiskBoard` + `routes/operations.ts` + 测试；
2. web `fetchOperationsRisks` + `riskCatalog` + 状态推导 + 单元测试；
3. `/ops` 页面改造（底表 + 风险合并 + 权限降级 + 汇总/列/details/筛选/排序）；
4. 详情页锚点 + `ActivityAnalyticsCard` 共享文案/可见性；
5. E2E（registration-loop）、a11y、全量门禁、合并、CI。

## 8. 风险

- **N 次 analytics 读取**：活动多时看板变慢；第一版接受，未来换批量 SQL 不改契约。
- **跨活动快照不一致**：每个活动独立读取；看板是近实时，不是事务快照。
- **权限差集**：`hasOpsAccess` 比 analytics 权限宽；页面必须降级，不能整页失败。
- **锚点缺失**：受限用户看不到目标卡片时链接停在详情页顶部；看板仍可读。
- **闭活动赛果冻结**：closed 的赛果问题只能只读提示，不能重新发布；不要把它包装成可执行动作。
