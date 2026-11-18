# 现场观众伴侣设计

状态：设计已评审（2026-11-18）
范围：ArtFlow-Plus Portal `/e/$publicCode` 的现场观众体验
前序：`docs/artflow-plus/specs/2026-11-18-portal-public-event-site-design.md`、
`docs/artflow-plus/specs/2026-11-18-audience-tickets-design.md`

## 0. 审阅结论

现场观众扫活动二维码后，需要在不登录、不装 App 的前提下，3 秒内回答两个问题：
**现在演到谁 / 下一个是谁**，以及 **我现在该做什么**。现有活动站已经聚合了介绍、
现场、节目单、赛果与分享，但缺少一个稳定的"现场优先"首屏，也缺少对活动结束、
日程重发、赛果撤销、投票关闭这些生命周期的显式处理。

本设计只做现场观众这一阶段：不新增路由、不新增聚合接口、不新增公开写入口，
只扩展现有公开读与前端组织方式，并修复投票候选直接显示原始 `candidateId` 的
展示缺陷。活动发现、公开 API/widget、票务钱包、参与者公开主页留到后续阶段。

## 1. 目标

- 扫码进入活动站后，首屏无需滚动即可看到当前节目与下一个节目。
- 投票开放时，主行动在首屏可见；候选显示姓名而不是内部 ID。
- 活动结束后自动退出"现场"状态，主行动切到赛果。
- 弱网、断网、轮询失败时不白屏，保留最近一次数据并可恢复。
- 现场公告更新后，已关闭公告条的观众重新看到。

## 2. 非目标

- 不公开实时分数、排名、评委或未正式发布的赛果。
- 不做活动发现目录、搜索、公开只读 API、嵌入 widget。
- 不做电子票钱包、转赠、座位/区域。
- 不做参与者公开主页、头像或媒体上传管线。
- 不新增公开写命令、权限、事件或 topic。
- 不引入服务端聚合接口、公开 SSE/WebSocket 或新的实时通道。

## 3. 决策

### 3.1 一个路由，三种状态

`/e/$publicCode` 不新增页面，按活动状态与 `current` 渲染三种形态：

| 条件 | 首屏 | 主行动 |
| --- | --- | --- |
| `active` 且 `current` 存在 | 压缩 Header + NOW 卡 + 行动卡 | 投票 > 赛果 > 报名 |
| `active` 且 `current` 为空 | 压缩 Header + 中性卡「暂无进行中的节目」 | 同上；不把 `next` 称为"接下来" |
| `closed` | 完整 Hero + 赛果 | 只看赛果 |

`draft` / `archived` 继续返回 404。活动状态以最新一次 `current` 查询返回的
`activity.status` 为准（15 秒内），不依赖活动站查询的 60 秒缓存；这样活动结束后
最多 15 秒退出 NOW 状态。

### 3.2 公开进度与公开赛果的边界

现场进度（当前/下一个节目、公告、投票是否开放）可以公开；分数、排名、评委
信息在正式 release 之前不公开。公开赛果仍只来自 `selectPublicResults` 的
active + confirmed + source 非空 + 非 stale 快照。现场状态不能替代或推断赛果。

### 3.3 不新增聚合接口

复用现有公开读：

- `GET /api/public/events/:publicCode`
- `GET /api/public/activities/:publicCode/current`
- `GET /api/public/activities/:publicCode/voting`
- `GET /api/public/vote/:sessionId`

现场伴侣不新增后端聚合端点。弱网优化通过轮询节奏、保留旧数据、手动刷新实现，
而不是再造一个读模型。

### 3.4 候选显示名是展示数据

投票会话快照冻结候选 ID，姓名在读取时从该活动的报名答案解析，与公开赛果
解析 `contestantName` 的方式一致。姓名变化、报名失效都属于展示数据变化，不改变
投票会话的权威快照，也不影响 ballots 的有效性。

### 3.5 分享与二维码使用规范 URL

分享与二维码一律使用 `location.origin + "/e/" + encodeURIComponent(publicCode)`，
不使用 `window.location.href`，避免把 fragment（票据/评委凭证）或查询参数带进
二维码。二维码在浏览器本地用已有 `qrcode` 依赖生成，不经过服务端。

## 4. 数据与契约

### 4.1 `PublicVoteSession` 增加可选 `candidateName`

`packages/contracts/src/voting.ts` 的公开投票候选：

```text
{ optionId, candidateId, candidateName? }
```

保持 `additionalProperties: false`。运行时只在解析到姓名时返回该字段，缺省不返回。

### 4.2 姓名查询复用

新增 `packages/db` 的 `selectParticipantNames(db, activityId, participantIds)`：
按活动与参与者 ID 读取 `registration.answers`，复用现有 `participantName`
解析键（`name` / `displayName` / `title` / `program`），返回 `Map<string, string>`。
`publishing-repository` 改为复用同一查询，删除重复的私有解析逻辑。

`readPublicVoteSession` 用该查询补 `candidateName`；只在存在候选时查询，只取
候选引用到的参与者 ID。

### 4.3 无迁移

本轮不新增表、列、索引或迁移。`schema.snapshot.json` 与 `src/types.ts` 不变。

## 5. 前端结构

### 5.1 组件

新增（`plus/apps/web/src/components/portal/`）：

- `NowNextCard.tsx`：`NOW 03 / 12`、姓名、曲目、下一个 1–2 位、最近更新时间、
  手动刷新；`aria-live="polite"` 只在当前节目变化时播报。
- `OnsiteActionPanel.tsx`：主按钮（投票/赛果/报名）与次级链接（节目单/分享/二维码）。
  文件名不能叫 `OnsiteActions.tsx`：在 Windows 上会与纯函数 `onsiteActions.ts` 大小写撞名。
- `AnnouncementBanner.tsx`：可关闭，`role="note"`。
- `onsiteActions.ts`：纯函数 `deriveOnsiteActions()`、`matchCurrentProgram()`、
  `displayCandidateName()`、`looksOpaqueId()`。

修改：

- `routes/publicEvent.tsx`：查询编排、三种状态、行动优先级。
- `components/portal/EventProgram.tsx`：当前项高亮与「回到现在」。
- `components/portal/EventShare.tsx`：规范 URL + 本地二维码（原生 `<dialog>`）。
- `components/portal/EventHero.tsx`：`compact` 变体。
- `routes/vote.tsx`：候选显示 `candidateName` 回退链。

删除：

- `components/portal/EventLive.tsx` 及其测试。它现在承担"现在/下一个 + 投票按钮"，
  会被 `NowNextCard` + `OnsiteActions` 完全替代；保留会形成第二条渲染路径。

### 5.2 轮询与新鲜度

| 查询 | 条件 | 节奏 | 失败处理 |
| --- | --- | --- | --- |
| 活动站 | 页面可见 | `staleTime 60s`，每 60s | 首次失败显示错误页；后续失败保留旧数据 |
| `current` | `active` | 每 15s，`staleTime 10s` | 网络/5xx 保留旧卡；404 视为已下线并隐藏 |
| `voting` | `active` | 每 15s | 隐藏投票动作，不显示错误 |
| 投票会话 | 投票页 | 现有一次性读取 | 提交时 `VOTE_SESSION_CLOSED` 兜底 |

- 页面不可见时 react-query 暂停轮询；回到前台重新拉取。
- 手动刷新同时触发 `current` 与 `voting`。
- 活动站 60s 轮询用于把**赛果撤销的可见延迟限定在 60 秒内**；这是生命周期与
  负载的明确取舍。
- 最近更新时间使用本地单调计时（"刚刚 / 12 秒前"），不依赖客户端绝对时钟。

### 5.3 公告

公告来自活动站 `profile.announcement`。非空时显示在行动卡之上；关闭后写入
`sessionStorage`，键为公开码，值为公告文本；文本变化即重新出现。`sessionStorage`
不可用时静默降级为"每次都显示"。

### 5.4 节目单高亮

先按 `order` 匹配 `current`；未命中再按 `姓名 + 曲目` 匹配；仍不命中则不高亮，
不猜测、不滚动。高亮项带 `aria-current="true"` 与「现在」徽章；「回到现在」只在
存在高亮项时出现。

### 5.5 投票候选展示

`displayCandidateName(candidate, ordinal)`：

1. 有 `candidateName` 用之；
2. 否则用 `candidateId`（主办方可能直接传可读名称）；
3. 若 `candidateId` 匹配内部 ID 形态（前缀 + 16 位以上十六进制，或 UUID），
   显示「候选 N」。

投票页与活动站不直接渲染原始内部 ID。

## 6. 错误与可见性

| 情况 | 行为 |
| --- | --- |
| 活动站首次加载失败 | 现有错误页 + 重试 |
| 活动站后续刷新失败 | 保留上一份数据 + 顶部细提示 |
| `current` 网络/5xx | 保留上一张 NOW 卡 + 「更新失败 · 重试」 |
| `current` 404 | 视为活动已下线或无日程，隐藏 NOW 卡 |
| `voting` 失败 | 隐藏投票动作，不影响节目与赛果 |
| 429 | NOW 卡内提示「刷新过于频繁」，保持 15s 节奏，不叠加重试 |
| 断网 | 非阻塞条「网络不稳定，展示最近一次数据」；恢复后自动刷新 |
| 赛果撤销 | 活动站 60s 内刷新，赛果与主行动一起消失 |
| 投票恰好关闭 | 投票页提交时返回 `VOTE_SESSION_CLOSED` 文案；行动卡 15s 内移除 |
| 姓名解析不到 | `candidateId` 或「候选 N」；不报错、不阻塞投票 |

## 7. 生命周期与终态

1. **活动**：`active` 才显示 NOW 与投票；`closed` 只保留 Hero、节目单、赛果；
   `draft`/`archived` 404。状态取最新 `current` 响应，15 秒内退出。
2. **报名**：主行动只在 `registrationOpen` 时出现；它已要求 activity active、
   registration lifecycle `open`、roster 非 `final`、问卷与材料编译成功。
   活动站 60 秒缓存内可能仍显示报名按钮，点击后由服务端拒绝，UI 不自行放行。
3. **投票会话**：公开入口只认 `formal` + `open`，取最新开启的一个；会话关闭后
   入口在 15 秒内消失。投票页本身不轮询（避免重复的 browser-identity 写入），
   关闭竞态由提交错误兜底。
4. **多个 formal 投票会话**：公开页一次只暴露一个投票入口；同时多开的会话
   不在本轮范围，后续若需要由 Ops 选择"当前公开场次"。
5. **赛果 release**：只有 active + confirmed + source 非空 + 非 stale 才公开；
   撤销或 supersede 后，打开着的页面在 60 秒内（或回到前台时）移除。
6. **日程 release**：撤销即 fail closed，不回落旧版本；`current` 只读 `formal`。
   重发日程后 `current` 指针可能失配，此时不高亮、不把 `next` 说成"接下来"。
7. **节目与 current 的短暂不一致**：活动站 60 秒、`current` 15 秒，重发后可能
   短暂不同步；NOW 卡以 `current` 为准，节目单以最新公开 release 为准，不伪造
   一致。
8. **姓名**：投票会话冻结候选 ID，姓名在读取时解析；报名改名或失效会反映在
   展示层，不改变会话快照与既有 ballots。
9. **分享/二维码**：使用规范 URL，不含 fragment 或查询参数；公开码不可变，
   页面关闭后二维码仍指向同一活动。
10. **模式隔离**：公开 current、schedule、program、vote entry、公开投票会话与
    赛果都只读 `formal`；test/rehearsal 数据不进入公开面。

## Test architecture

### 契约与能力

- 契约：`packages/contracts/src/voting.ts` 的 `PublicVoteSession` 候选增加可选
  `candidateName`；`additionalProperties: false` 不变。
- 能力：`voting` 的公开读；`publishing` 的姓名查询复用。无新命令、事件、topic、
  权限或适配器方法。

### 消费者与读模型

- 前端消费者：公开活动站、节目单、分享、投票页。
- 读模型：`PublicEventSite`、`PublicCurrentProgram`、`PublicVoteEntry`、
  `PublicVoteSession`。
- 不新增 route 或 event edge；`graph:check` 的 unresolved 与 `uiGaps` 应保持不变。
- `selectParticipantNames` 由 `publishing-repository` 与 `voting-read-service`
  共同消费，属于 DB 读取辅助，不是新的业务能力。

### 生命周期、终态与 mode 隔离

- 覆盖 active/closed/draft/archived 四种活动状态；closed 不显示 NOW 与投票。
- 覆盖 vote session 的 draft/open/closed；公开入口只认 formal + open。
- 覆盖 result release 的 active/revoked/superseded/stale；撤销后 60 秒内不可见。
- 覆盖 schedule release 的 active/revoked；撤销 fail closed，current 只读 formal。
- 覆盖 roster final 与 registration lifecycle；报名行动不自行放行。
- 覆盖日程重发导致的 current 失配：不高亮、不谎报"下一个"。
- 覆盖 test/rehearsal 隔离：公开读不返回非 formal 数据。

### 适配器

- 无新增适配器。现有 `voting` 适配器不修改，因为本轮没有命令或生命周期变化。
- 姓名查询使用真实 PostgreSQL 与真实 registration 数据，不 mock repository。
- 组件层用可控 fetch 验证降级，不替换业务服务。

### 故障注入与恢复

- `current` 轮询拒绝：保留最近 NOW 卡，显示重试；恢复后更新。
- `voting` 轮询拒绝：隐藏投票动作，页面其余部分可用。
- `current` 404：隐藏 NOW 卡，不保留已下线数据。
- 活动站刷新失败：保留旧数据，不白屏。
- 投票在打开页面后关闭：提交返回 `VOTE_SESSION_CLOSED`，页面显示结束文案。
- 赛果撤销：活动站刷新后赛果与主行动消失（组件用可控响应，不等待真实 60 秒）。
- 姓名缺失/报名缺失：回退到 `candidateId` 或「候选 N」，投票仍可提交。
- 故障用例使用可控 fetch 或 fake timers，不使用任意 sleep；断言故障中行为与
  恢复后的最终状态。

### 现有测试为什么不够

现有公开站测试覆盖 404、结果发布与 formal 过滤，但不覆盖 live/closed 布局切换、
行动优先级、公告关闭后复现、轮询失败保留、`current` 为空语义、节目高亮、二维码、
候选姓名回退。E2E 只覆盖移动端壳与部分流程，没有"扫码进入现场伴侣"的观众旅程。
因此需要新增纯函数、组件、运行时与 E2E 四层证据，而不是只看一条页面快照。

### 防臃肿（anti-bloat）

- 扩展现有活动站与节目单组件，删除被替代的 `EventLive`，不保留并行渲染路径。
- 只新增一个纯函数模块与三个展示组件；不新增路由、聚合接口、表、事件、topic。
- 契约只增加一个可选字段；姓名查询与 publishing 共用，减少重复。
- 不引入逐函数套件、笛卡尔积矩阵或实现细节契约；测试按优先级矩阵与真实
  生命周期边界组织。

### 聚焦门禁与验收证据

- `pnpm -C plus run check`
- `pnpm -C plus --filter @artflow-plus/web test`
- `REQUIRE_DB=1 pnpm -C plus --filter @artflow-plus/runtime test`
- `pnpm -C plus --filter @artflow-plus/contracts test`
- `pnpm -C plus run graph:check`（unresolved 0，`uiGaps` 不增加）
- `pnpm -C plus run audit:check`（baseline 不增加）
- `pnpm -C plus run build:prod`
- `uv run pytest tests/gates -q`
- `pwsh -NoProfile -File scripts/check_docs.ps1`
- `pnpm -C plus --filter @artflow-plus/web test:e2e --project=chromium` 与
  `--project=mobile`

验收证据：投票候选显示姓名；活动关闭后 NOW 与投票消失；赛果撤销后不再显示；
`current` 为空时不出现"接下来"；移动端新控件 ≥44px 且无横向滚动。

## 8. 实施顺序

1. **契约与姓名（先红后绿）**：先写运行时测试断言 `candidateName`，确认失败；
   新增 `selectParticipantNames`，让 publishing 复用，补 `readPublicVoteSession`。
2. **纯函数**：`deriveOnsiteActions`、`matchCurrentProgram`、`displayCandidateName`、
   `looksOpaqueId` 与优先级矩阵测试。
3. **组件**：`NowNextCard`、`OnsiteActions`、`AnnouncementBanner`、节目单高亮、
   分享二维码；删除 `EventLive`。
4. **路由编排**：三态、轮询、失败降级；组件测试覆盖 active/closed/current 为空。
5. **E2E 与移动端**：幂等种子 + 观众旅程；mobile project 断言触控与无横向滚动。
6. **收尾**：`graph:check` / `audit:check` / `check_docs` / 聚焦测试全绿；更新
   相关文档与变更记录。

## 9. 风险与待决

- **活动站 60 秒轮询的 DB 负载**：观众规模大时，每分钟每用户一次活动站查询。
  本轮接受；若实测压力过高，再加短 TTL 的服务端缓存或 CDN 条件请求，不改变
  对外契约。
- **投票页不轮询**：会话关闭只能提交时发现。理由是避免重复的 browser-identity
  写入；若后续需要"结束即灰"，应单独设计只读的会话状态轮询，不复用身份写入。
- **多会话**：同时多个 formal 投票会话时公开入口只取最新一个。若主办方需要
  并行投票，需增加"当前公开场次"选择，属于后续能力。
- **姓名实时性**：姓名是读取时解析的展示数据；若活动规则要求姓名冻结，应在
  投票会话快照里冻结姓名，而不是在 UI 层缓存。
- **公开码可枚举**：公开码是定位符不是授权凭证；本设计不增加任何按公开码
  可写的入口。
