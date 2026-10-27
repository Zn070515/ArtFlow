# ArtFlow-Plus：参与者投票页

状态：已确认（2026-10-27）
范围：公开投票数据接口、参与者投票页面、Ops 卡片的投票链接与二维码。
非目标：票据投票入口、投票结果页、实时票数展示、机器人/设备指纹增强、投票审计 UI。

## 背景

M10/M11 让运营可以创建场次、实时看票数、确认并发布投票结果，但**观众没有投票页面**：
v2 只有一个公开 ballot 写接口，没有公开读接口告诉页面候选是谁、是否已投、是否需要票据。
本 slice 把投票做成观众可用的一条完整路径。

## 决策

- **入口（已定）**：`/vote/<sessionId>`。新增公共读
  `GET /api/public/vote/:sessionId`，由场次反查 activityId、标题与候选；不为场次新增
  短公开码，避免迁移与唯一约束。
- **票据场次（已定）**：公共读返回 `identityPolicy`；`ticket` 场次页面明确显示
  “本场需要现场票据，请联系工作人员”，不渲染提交按钮。票据 UI 留给后续 slice。
- **链接与二维码（已定）**：Ops 卡片对每个开放场次显示完整链接、复制按钮与客户端生成的
  二维码（新增 `qrcode` 前端依赖）。关闭的场次不再展示入口。
- **已投状态（已定）**：公共读返回 `voted`；browser 策略下用请求的
  `artflow_browser_id` 计算 digest 并查该场次是否已有 ballot。刷新/重进页面直接显示
  “已投票”；服务端唯一约束仍是最终权威。
- **不显示票数（已定）**：投票页面不展示任何实时或累计票数，避免影响投票；结果只在
  场次关闭后由运营发布。
- **身份（已定）**：沿用 `browser` / `anonymous` 策略。页面在 browser 策略下先调
  `GET /api/activities/:id/voting/browser-identity` 拿 HttpOnly cookie，再读公开数据；
  `anonymous` 直接投票。`ticket` 阻断。

## 公共读

`GET /api/public/vote/:sessionId`（匿名、限流 120 次/分钟）：

```ts
{
  activityId: string,
  activityTitle: string,
  sessionId: string,
  status: "open" | "closed",
  selectionType: "single" | "multi",
  maxSelections: number,
  identityPolicy: "browser" | "ticket" | "anonymous",
  candidates: { optionId: string, candidateId: string }[],
  voted: boolean
}
```

- 运行时 `readPublicVoteSession(db, sessionId, browserFingerprint?)`：
  - 场次不存在 → `null` → 404。
  - 活动标题从 `activity` 读取；活动被归档不影响读取，页面按场次状态显示。
  - 候选按 `ordinal` 排序；**不返回 counts、ballots、身份**。
  - `voted`：`identityPolicy === "browser"` 且提供了 fingerprint 时，用
    `stableHash(fingerprint)` 查 `ballot(session_id, identity_digest)`；其他情况 false。
- Cookie 名 `artflow_browser_id`，长度 ≥ 32 才参与 `voted` 判定（与 ballot 路由一致）。
- 路由只做参数校验与限流，不要求登录。

## 投票页

路由：`/vote/$sessionId`（TanStack Router，`vote.tsx`）。

加载顺序：

1. 读公共数据。
2. 若 `identityPolicy === "browser"`：调
   `/api/activities/<activityId>/voting/browser-identity`，再读一次公共数据，
   拿到 `voted`。页面 `staleTime: Infinity`，不轮询。
3. 其他策略不再请求身份。

状态与 UI：

| 状态 | 显示 |
|---|---|
| loading | 加载中 |
| 404 | “投票链接无效或已失效” |
| `status === "closed"` | “投票已结束” |
| `identityPolicy === "ticket"` | “本场需要现场票据，请联系工作人员”（无提交按钮） |
| `voted === true` | “你已经投过票了” |
| open | 候选列表 + 提交 |

- single：radio；multi：checkbox，最多 `maxSelections` 个，超出时禁止选择并提示。
- 提交前必须至少选 1 项；提交中禁用按钮。
- 提交 body：`{ scope: "voting", optionIds, identity: { type: "browser" | "anonymous" } }`；
  使用 `apiFetch`（自动带 CSRF，已登录参与者也可投票）。
- 成功后本地置 `voted = true`，显示“投票成功”。
- 错误映射：
  - `DUPLICATE_BALLOT` → “这台设备已经投过票了”
  - `VOTE_SESSION_CLOSED` → “投票已结束”
  - `SESSION_NOT_RUNNING` → “投票尚未开始，请稍后再试”
  - `TOO_MANY_SELECTIONS` → “选择的候选超过上限”
  - `BALLOT_IDENTITY_INVALID` → “当前设备无法投票，请刷新后重试”
  - `ACTIVITY_NOT_ACTIVE` → “活动已结束”
- 移动端优先：单列候选、足够大的点击区域；不引入新组件库。

## Ops 卡片

- 对每个 `status === "open"` 的场次显示：
  - 完整链接 `${window.location.origin}/vote/${session.id}`；
  - “复制链接”按钮（`navigator.clipboard.writeText`，失败时只展示文本）；
  - 二维码 `<img alt="投票二维码">`，由 `qrcode` 在客户端生成（`toDataURL`，宽度 160）。
- 关闭的场次不显示入口。
- 新增依赖：`qrcode@1.5.4` 与 `@types/qrcode@1.5.6`（提交 lockfile）。

## 测试

- Runtime/API：
  - 公共读形状：activityId/title/status/selection/max/identityPolicy/candidates；
    **不含 counts**；
  - `voted`：无 cookie false；带合法 browser cookie 且已投 true；
  - closed 场次返回 `status: "closed"`；
  - ticket 场次返回 `identityPolicy: "ticket"`；
  - 未知场次 404；
  - 公共读不限流误伤正常使用（多次请求仍 200）。
- Web：
  - 页面单测（可选）：closed / ticket / voted / open 四种状态的渲染；
  - Playwright E2E：Ops 开场 → 新匿名浏览器上下文打开 `/vote/<sessionId>` →
    选择 alice → 投票成功 → 刷新显示已投票 → Ops 卡片实时票数变为 1；
    二维码 `<img>` 可见。
  - 现有 Ops 投票 E2E 保留（API 投票路径）。
- 文档：ADR-0028、roadmap M12、shape-validation（投票者页面缺口关闭）。

## 出口

1. `pnpm -C plus run check` / `run test` 全绿。
2. `uv run pytest tests/gates -q`、`scripts/check_docs.ps1` 通过。
3. 投票页 E2E 通过，现有投票/发布路径零回归。
4. 公共读不泄露票数或身份。

## 风险

- 浏览器身份可被清除 cookie 绕过；这是既有轻量防刷边界，不承诺强一致一人一票。
- 页面不轮询场次状态：运营关闭场次后，已打开的页面在提交时才会看到“已结束”。
  这是有意的（避免投票页变成实时结果页）。
- 二维码由客户端生成；依赖体积增加，但只在 Ops 页面加载。
