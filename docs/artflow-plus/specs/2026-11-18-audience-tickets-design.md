# 观众体验与电子票设计

- **Status**: proposed
- **Date**: 2026-11-18
- **Scope**: Portal 新增 `/t` 电子票页与公开现场读模型（当前节目、投票入口）；活动站增加「现场」区；Ops 票据卡增加入场链接
- **相关**: [公开活动站设计](./2026-11-18-portal-public-event-site-design.md)、[参与者个人中心设计](./2026-11-18-participant-center-design.md)、[前端视觉方向](../frontend-design-direction.md)、[GOAL](../../../GOAL.md)

## 0. 结论

1. **电子票是只读票面**：`/t#ticket=<credential>` 只查询票面、生成二维码、展示活动与现场入口；不兑换 credential、不改变票据状态、不建投票会话。
2. **投票仍在投票页兑换**：票面页的投票入口带 `#ticket=<credential>` 指向 `/vote/<sessionId>`，由现有投票页完成一次性兑换。
3. **现场入口是公开读投影**：当前节目来自 formal active schedule release + `schedule_current` 指针；投票入口只取 formal、open 的最新 vote session。
4. **release 快照增加 `entryId`**：附加字段，旧快照读取为 `null`；当前指针无法匹配公开阵容时显示“暂无当前节目”，不拿未发布条目冒充已发布阵容。
5. **credential 不进入 URL 查询串或服务端日志**：页面从 fragment 读取，lookup 用 POST body；二维码在浏览器端生成。

## 1. 目标

- 持票人打开主办方分享的链接即可看到票面、入场二维码、活动信息、当前/下一节目和投票入口。
- 现场观众在活动站看到“当前节目 / 接下来 / 去投票”，不需要刷新整页也能获得最新状态。
- 主办方在 Ops 票据卡可以直接复制入场链接，发给持票人。
- 不把 credential 暴露给日志、Referer 或第三方二维码服务。

### 非目标

- 不做公开公告历史、参与者名录、现场大屏；
- 不做相机扫码/二维码识别；门岗仍用 credential 输入或外部扫码器；
- 不做电子票转赠、多人票、座位图；
- 不做 WebSocket 现场推送；活动站用 HTTP 轮询；
- 不在 `/t` 兑换投票会话。

## 2. 路由与接口

| 路由 | 访问 | 说明 |
| --- | --- | --- |
| `/t` | Portal，public | 电子票页；credential 从 `#ticket=` 或手动输入 |
| `POST /api/public/tickets/lookup` | public + 限流 | 只读校验 credential，返回票面与活动公开信息 |
| `GET /api/public/activities/:publicCode/current` | public + 限流 | 当前/接下来节目 |
| `GET /api/public/activities/:publicCode/voting` | public + 限流 | 最新 open formal vote session 的 locator |

- `/t` 不需要登录；credential 是 bearer 凭证。
- `lookup` 限流 `ticket-lookup:<ip>` 30/min；`current`/`voting` 120/min。
- 所有公开响应 `cache-control: no-store`。

## 3. 电子票

### 3.1 票面响应

```ts
interface PublicTicketLookup {
  ticket: {
    publicCode: string;
    state: "issued" | "redeemed" | "revoked" | "expired";
    credentialVersion: number;
    issuedAt: string;
    redeemedAt?: string;
    revokedAt?: string;
  };
  activity: {
    publicCode: string;
    title: string;
    status: "active" | "closed";
    startsAt: string | null;
    endsAt: string | null;
    venue: string;
    organizer: string;
  };
  links: {
    event: string;
    results: string;
  };
}
```

- `ticket` 只出票号、状态、版本与时间；不回显 credential、不返回 participant/answers。
- `activity` 来自 `getActivitySummary` + `getActivityPublicProfile`。
- 投票入口**不在 lookup 内嵌**：页面按 `activity.publicCode` 调 §4.2 的公开接口，避免两个来源和过期快照。
- 活动 `draft`/`archived` → `TICKET_ACTIVITY_NOT_PUBLIC`（404）；`closed` 可看票面，当前/投票入口为空。
- 票据 `revoked` → `TICKET_REVOKED`；`expired` → `TICKET_EXPIRED`；签名/版本无效 → `INVALID_TICKET`。`issued`/`redeemed` 均有效。

### 3.2 只读校验

新增 `lookupTicketByCredential`（runtime ticket service）：

```text
parseCredential(credential, "T", credentialSecret)
→ findTicketByCredential(publicCode, version)
→ validCredentialForRow(...)
→ state 检查（revoked/expired）
→ 返回 StoredTicket
```

- 不写 command receipt、不写 audit、不发事件、不更新 `ticket.state`。
- 复用现有 `parseCredential`/`validCredentialForRow`/`findTicketByCredential`，不复制签名逻辑。
- `lookup` 路由使用 `publicDeps()` 的 credential secret；不开放 signing secret。

### 3.3 页面

- 入口：`/t` 读取 `window.location.hash` 的 `ticket`；没有 fragment 时显示手动输入框「粘贴入场凭证」。
- 成功：活动标题/状态/时间/地点/主办方、票号、状态 Badge、入场二维码、credential 文本 + 复制、当前/下一节目、投票 CTA、活动主页/赛果链接。
- 二维码：浏览器端 `qrcode.toDataURL(credential, { margin: 1, width: 240 })`，alt「入场二维码」；credential 不发给第三方。
- 错误态：无效/已撤销/过期/活动未公开，分别给出明确文案；不生成二维码。
- 票面 lookup 是一次性快照；当前/投票按 `activity.publicCode` 另行查询并 30s 轮询，仅在活动 `active` 时启用；`closed` 显示票面但不轮询、不显示投票。
- 页面提示「此链接包含入场凭证，请勿转发」。
- 打印：按钮触发 `window.print()`；`@media print` 隐藏导航/按钮，保留票面与二维码。
- 移动端优先；390px 无横向滚动。
- fragment 不主动清除：链接本身就是票据；刷新/再次打开仍可用。投票页仍按既有逻辑清除自己的 fragment。

## 4. 公开现场读模型

### 4.1 当前节目

```ts
interface PublicCurrentProgram {
  activity: { publicCode: string; title: string; status: "active" | "closed" };
  current: {
    order: number;
    slotLabel: string;
    title: string;
    note: string;
    startsAt: string | null;
  } | null;
  next: readonly {
    order: number;
    slotLabel: string;
    title: string;
    note: string;
    startsAt: string | null;
  }[];
}
```

- 活动 `active|closed`；`draft`/`archived` → 404。
- `selectActiveScheduleRelease`（formal、active/closed、最新未撤销）→ release snapshot。
- `getScheduleCurrent(activity.id, "formal")` → 当前 entry id。
- release 快照增加 `entryId`（见 §6）；只有 `entryId` 匹配当前指针时才返回 `current`。
- `next`：当前 `order` 之后最多 5 条；没有 current 时取前 5 条。
- 无 active release（含最新 release 已撤销）→ `current:null, next:[]`。
- release 存在但 current 指针缺失，或旧快照无 `entryId` → `current:null`，`next` 取前 5 条。
- 只出公开字段；不出 `participantId`、评分、评委、test/rehearsal 指针。

### 4.2 投票入口

```ts
type PublicVoteEntry = { sessionId: string; status: "open" } | null;
```

- 只对活动 `active` 返回 open session；`closed` 返回 `null`，`draft`/`archived` → 404。
  原因：投票命令自身要求活动 active；`closed` 活动上的 open session 只会把 CTA 指向一个必然被拒绝的页面。
- `listVoteSessionsForActivity` 过滤 `mode === "formal" && status === "open"`，按 `openedAt` 降序取最新；没有则 `null`。
- 只返回 session id/status；候选人与身份策略仍由现有 `GET /api/public/vote/:sessionId` 提供。
- session id 是 locator，不是授权凭据；投票页继续做 browser/ticket/anonymous 身份校验。

## 5. 活动站 `/e/$publicCode` 增强

- 在公告之后、介绍之前增加「现场」区：
  - `当前：<title> · <slotLabel> · <time>`
  - `接下来：…`（最多 3 条）
  - `投票进行中 · 去投票`（`vote` 非空时）
- 数据源：`fetchPublicCurrent` + `fetchPublicVoteEntry`；`refetchInterval: 30_000`，仅在活动 `active` 时启用；`closed` 停止轮询。
- 无 current/next/vote → 整区隐藏，不渲染空壳；锚点导航在有「现场」区时增加「现场」。
- `/t` 票面页复用同一对公开接口，不内嵌投票快照。
- 不新增 WebSocket topic；HTTP 轮询是唯一实时增强。

## 6. 快照兼容：`entryId`

- `ScheduleSnapshotEntry` 增加 `entryId: string | null`。
- `releaseSchedule` 写入快照时增加 `entryId: entry.id`。
- `release()` 读取旧快照时补 `entryId: null`，不重写历史快照。
- 当前节目只在 `entryId` 匹配时显示；旧快照/旧指针显示“暂无当前节目”，不猜测匹配。
- 这是 JSON 快照的附加字段，`version`/`schemaVersion` 保持 1；数据库 schema 不变。

## 7. Ops 票据卡

- `TicketsCard` 在一次性 credential 显示区增加「复制入场链接」：
  - 复制 `${window.location.origin}/t#ticket=${encodeURIComponent(credential)}`。
  - 可见 `role="status"` 提示「入场链接已复制」，2 秒复位；失败提示「复制失败，请手动复制」。
  - 提示「请私下发送给持票人」。
- 轮换后旧链接失效；卡片显示新 credential 和新链接。

## 8. 生命周期与安全

| 对象 | 规则 |
| --- | --- |
| 票据 | `issued`/`redeemed` 可看票面；`revoked`/`expired` 拒绝；轮换后旧 credential 失效；`/t` 不改变票据状态 |
| 活动 | `active`/`closed` 可看票面/现场；`draft`/`archived` 返回未公开；`closed` 不轮询、不显示投票 |
| 当前节目 | 只读 formal active release；current 指针必须匹配已发布 `entryId`；test/rehearsal 永不出现 |
| 投票入口 | 只取 formal、open 的最新 session；test/rehearsal/closed 不出现 |
| credential | fragment + POST body；不进查询串/日志；限流；签名校验；响应不回显 |
| 响应内容 | 票号/状态/活动公开信息/公开节目/投票 locator；不含参与者答案、其他票据、私有材料、评分 |

## 9. Test architecture

### 9.1 契约与能力

- 不新增 capability；ticket lookup 是只读投影，不进入 `executeCommand` 的 receipt/audit/outbox。
- `ticketing` 与 `schedule` 的既有生命周期不变；`entryId` 是 release snapshot 的附加字段。
- 不扩展 `plus/tools/contracts/src/harness/adapters/`；没有新的 capability adapter。

### 9.2 消费者、读模型、路由、事件、topic

`graph:check` 保持零 unresolved：

- 新增路由 `POST /api/public/tickets/lookup`、`GET /api/public/activities/:publicCode/current`、`GET /api/public/activities/:publicCode/voting`（Web 调用）；
- 新增 Web 路由 `/t`；扩展 `/e/$publicCode`；
- 扩展 `ScheduleSnapshotEntry`（附加 `entryId`）；
- 不新增表、不新增 command/event、不新增 realtime topic。

### 9.3 生命周期边界、终态与 mode 隔离

- 票据状态：`issued → redeemed`，`revoked`/`expired` 为拒绝态；lookup 不写状态。
- 活动：`draft/active/closed/archived`；只对 `active|closed` 公开票面/现场。
- 当前节目：只读 formal active release；最新 release 撤销 → current null；rehearsal/test 指针不出现。
- 投票入口：formal、open 的最新 session；closed/rehearsal/test 不出现。
- 旧快照无 `entryId` → current null；不重写快照。

### 9.4 适配器

不新增 capability adapter。服务测试使用真实 PostgreSQL：
`plus/packages/runtime/test/ticket-read-service.test.ts`、
`plus/packages/runtime/test/public-live-service.test.ts`；
扩展 `plus/packages/runtime/test/schedule-service.test.ts` 的 release 快照断言。

### 9.5 故障注入与恢复状态

| 故障 | 注入方式 | 断言 |
| --- | --- | --- |
| 无效 credential | 篡改签名/版本 | `INVALID_TICKET`；不读票、不写状态 |
| 已撤销/过期票据 | seed revoked/expired | `TICKET_REVOKED`/`TICKET_EXPIRED`；不生成票面 |
| 轮换旧 credential | rotate 后再用旧 credential | `INVALID_TICKET`；新 credential 可用 |
| 活动 archived/draft | 更新 activity.status | lookup/current/voting 返回未公开；不泄露票面 |
| 最新 schedule release 撤销 | 发布 v2 后撤销 v2 | current null；不回退 v1 |
| 旧快照无 entryId | 插入无 entryId 的 snapshot | current null；next 仍按前 5 条 |
| rehearsal current | 只推进 rehearsal 指针 | 公开 current 仍取 formal；rehearsal 不出现 |
| 投票场次 closed | 关闭 session | voting 返回 null；不返回 closed locator |

不使用任意 sleep；用真实命令/顺序状态构造。

### 9.6 现有测试为什么不够

- 现有 `vote-page.spec.ts` 只覆盖 credential 兑换投票，不覆盖只读票面/二维码/当前节目；
- 现有 `schedule-service.test.ts` 不覆盖 `entryId` 快照与公开 current；
- 现有公开读测试不覆盖票据 lookup、投票入口、活动站现场区；
- 现有 a11y 不覆盖 `/t` 无 credential 状态。

### 9.7 防膨胀 / anti-bloat 决定

- 新增 `ticket-read-service.test.ts` 与 `public-live-service.test.ts` 两个聚焦服务测试；不复制投票/排期模板。
- 扩展 `vote-page.spec.ts` 作为电子票 + 投票的唯一 E2E 旅程；不新建重复的票据签发流程。
- 扩展 `schedule.spec.ts` 的“下一位”后活动站当前节目断言；不新建现场大屏套件。
- `/t` 的页面测试与活动站现场区测试放在现有页面测试文件；不新增组件级 per-field 套件。
- 不做 per-status 矩阵；只测有效/撤销/过期/未公开四个分支。

### 9.8 聚焦门禁

```powershell
Set-Location plus
pnpm run check
$env:ARTFLOW_PLUS_DATABASE_URL = "postgresql://artflow:artflow_dev@127.0.0.1:5433/artflow_plus"
$env:REQUIRE_DB = "1"
pnpm run test
pnpm run schema:check
pnpm run build:prod
$env:NO_PROXY = "127.0.0.1,localhost,::1"
pnpm --filter @artflow-plus/web test:e2e -- vote-page.spec.ts schedule.spec.ts a11y.spec.ts
```

仓库级：

```powershell
uv run pytest tests/gates -q
uv run python tests/golden/validate_fixtures.py
pwsh -NoProfile -File scripts/check_docs.ps1
```

## 10. 实施顺序

1. `ScheduleSnapshotEntry.entryId` + release/release normalization + schedule 测试；
2. `lookupTicketByCredential` + `ticket-read-service` + 测试；
3. `public-live-service`（current/vote）+ 测试；
4. API 三条 public 路由 + API 测试；
5. `/t` 页面 + API client + 单测；
6. 活动站「现场」区 + 单测；
7. Ops `TicketsCard` 复制入场链接 + 单测；
8. E2E、a11y、文档、全量门禁。

## 11. 风险与待决

- **bearer credential**：拿到链接的人即可看票/入场；这是票据模型本身。页面提示“请勿转发”，但无法阻止转发；需要更强的持票人绑定时另开设计。
- **二维码不等于门岗已接入**：门岗仍用 credential 输入/外部扫码器；本轮不做相机扫码。
- **当前节目依赖 `entryId`**：旧 release 快照无 `entryId`，显示“暂无当前节目”；不猜测匹配。
- **投票入口只给 locator**：不返回候选人/身份策略；投票页仍负责身份与重复投票。
- **无实时推送**：活动站 30s 轮询；断网/慢网时显示上一次数据，恢复后下一次轮询更新。
