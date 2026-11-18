# Portal 公开活动站设计

- **Status**: proposed
- **Date**: 2026-11-18
- **Scope**: `plus/apps/web` Portal 面新增 `/e/$publicCode` 活动站；`plus/apps/api` 新增公开聚合读与活动公开资料命令；`schedule_entry` 增加 `starts_at`；归档包增加公开资料快照
- **相关**: [前端视觉方向](../frontend-design-direction.md)、[ADR-0016 公开门户](../../architecture/adr/0016-web-shell-and-public-portal.md)、[ADR-0034 Portal/Console 双壳](../../architecture/adr/0034-portal-console-shell-split.md)、[GOAL](../../../GOAL.md)

## 0. 审阅结论（2026-11-18）

本轮生命周期审阅确认并采纳：

1. **归档 = 公开下线，不是内部下线。** 公开读（`/e`、`/results`、`/program`、`/schedule`）对 `archived` 返回 404 / null；
   Ops、Studio、Admin、归档包等内部读**不受影响**，工作人员和管理员仍可查看归档活动并执行 `unarchive`
   等既有恢复操作。本变更不扩大归档活动的业务写权限；归档仍是 `unarchive` 之外不可编辑的终态。
2. **时间处理沿用现有约定。** 使用 `timestamptz` + ISO 字符串；前端按浏览器本地时区显示，
   与 `ResultsView.formatReleasedAt` 一致。不新增活动时区字段，也不引入墙上时间字符串。
   跨时区组织者/访客的显示差异记录为已知限制。
3. **归档包包含公开资料快照。** 归档时冻结 `activity_public_profile`，写入 `public-profile.json`。

同时修复审阅发现的现有 fail-open：

- `getPublicProgram` 在最新节目单被撤销后回退到已审核报名，违反 `selectActiveScheduleRelease` 的 fail-closed 意图；
- `selectPublicResults` 不过滤活动状态，导致归档活动的公开结果仍可见；
- 公开活动 DTO 无法区分“未启用报名”和“报名已截止”；
- 首次保存公开资料时 profile 行不存在的并发路径需要明确锁顺序。

## 1. 目标

Portal 目前只有“输入公开码看赛果”“节目单”“报名”“投票”几个彼此孤立的页面。
本设计把一个活动的公开信息组织成一个可分享、可打印、移动端可读的活动站：

- 一个公开链接 `/e/<publicCode>` 承载活动介绍、时间地点、主办方、公告、节目单/日程、赛果；
- 组织者在 Studio 维护公开资料，不依赖开发改数据；
- 节目单条目支持真实开始时间，公开页可以按时间排序和展示；
- 公开页只暴露已审核/已发布的内容，内部 ID、私有材料、测试/彩排数据不出现在响应里。

### 非目标

- 不做公开参与者名录、当前节目/实时状态、公告历史、在线购票；
- 不做多语言、SSR、静态站点生成；
- 不改变 `/` 作为“赛果公示”入口的定位；`/e/<code>` 是组织者分享的活动站；
- 不改变归档活动的内部读写权限与命令生命周期；
- 不引入新的 UI 框架或第二套设计系统。

## 2. 现状与缺口

| 能力 | 现状 | 缺口 |
| --- | --- | --- |
| 公开活动 | `GET /api/public/activities/:publicCode` 只返回 `id/publicCode/title/status/registrationOpen` | 没有介绍、时间、地点、主办方、联系方式、公告；无法区分“未启用报名” |
| 公开结果 | `GET /api/public/results/:publicCode` | 只有结果，没有活动上下文；未过滤归档活动 |
| 公开节目单 | `GET /api/public/programs/:publicCode`；页码 `program.tsx` 使用内联样式 | 没有统一活动站；最新节目单撤销后会回退到已审核报名 |
| 公开日程 | `GET /api/public/schedule/:publicCode` 已存在 | **没有页面**；条目只有有序 slot，没有开始时间 |
| 活动编辑 | Studio 只能改标题 | 没有公开资料编辑入口 |
| 公开壳 | `PortalShell` 副标题固定“赛果公示” | `/e/*` 需要“活动主页”语义与静态背景 |

## 3. 决策

### 3.1 公开资料是活动元数据，不是 capability

新增 `activity_public_profile` 表，与 `activity` 1:1，拥有独立 `revision`。
不把介绍写进 `publishing` 定义：publishing 的领域是赛果发布，改一句介绍不应要求重新编译发布；
也不给 `activity` 加多个大文本列，避免公开内容编辑与活动生命周期命令争用同一 `activity.revision`。

### 3.2 公开资料编辑走 engine 命令

命令 `activity.public_profile.update` 与 `activity.rename` 同形：`capability: "engine"`，
`studio.manage`，`executeCommand` 事务内完成 receipt、audit、`ActivityPublicProfileUpdated`
事件与 outbox。`archived` 活动拒绝编辑；`draft` / `active` / `closed` 可编辑。
锁顺序固定为 **activity 行 → profile 行**：活动行锁同时序列化首次创建，避免两个首次保存撞主键。

### 3.3 公开页是一个聚合读，不是新业务

`GET /api/public/events/:publicCode` 只组合现有公开读（活动、节目单、日程、赛果）与公开资料，
不复制业务规则。公开可见性统一为：

```text
draft      → 404
active     → 可见
closed     → 可见（状态显示“已结束”）
archived   → 404
```

该规则只作用于**公开读模型**。内部 `getPublishingState`、`getScheduleState`、`getArchiveState`、
Ops/Studio/Admin 活动列表与归档包读取保持不变；工作人员仍可查看归档活动并执行 `unarchive`。

公开 DTO 剥离内部 ID：节目只出 `name/song/note`，日程只出 `slotLabel/title/note`，
赛果只出姓名。`test` / `rehearsal` 数据永不进入公开读；日程只读 `formal` 模式的活动 release。

**Fail-closed 修正（现有缺陷）**：`getPublicProgram` 目前只用 `selectActiveScheduleRelease`；
最新 release 被撤销时返回 `null`，它继续回退到 approved registrations。新设计区分：

- 从未发布过节目单 → 回退 approved registrations；
- 发布过但最新版本已撤销 → 返回 `null`（公开节目单下线），不回退旧版或报名名单。

实现上新增 `getNewestScheduleRelease`：返回最新 release（不过滤 `revoked_at`），
`selectActiveScheduleRelease` 在它之上做 revoked 检查；`getPublicProgram` 用前者区分两种情况。

**归档可见性修正（现有缺陷）**：`selectPublicResults` 当前不检查活动状态，归档活动的 active release
仍会通过 `/api/public/results` 暴露。新设计给 `selectPublicResults`、`getPublicProgram`、
`getPublicSchedule` 三个公开读模型统一加 `active|closed` 过滤；聚合读 `/e` 同样 404。

### 3.4 日程条目增加 `starts_at`

`schedule_entry` 增加可空 `starts_at timestamptz`；`schedule_release.snapshot.entries`
增加 `startsAt: string | null`（ISO 字符串）。这是**附加字段**：

- snapshot 的 `version` / `schemaVersion` 保持 1；
- 读取旧快照时把缺失的 `startsAt` 规范化为 `null`，不重写历史快照；
- 写入时校验 ISO 时间可解析；条目之间的 `startsAt` 先后不作为硬约束；
- 条目之间是否时间重叠不作为硬约束。

时间表示沿用仓库现有约定：后端存 `timestamptz`，API 返回 ISO，前端按浏览器本地时区格式化
（与 `ResultsView.formatReleasedAt` 相同）。`datetime-local` 的值在浏览器本地时区与 ISO 之间转换；
空值转 `null`。跨时区组织者/访客会看到本地换算后的时间，这是与现有赛果页一致的已知限制。

逐条时间只在 `formal` 模式的已发布快照里公开；`test`/`rehearsal` 条目不公开。

## 4. 数据模型

### 4.1 `activity_public_profile`

| 列 | 类型 | 约束 |
| --- | --- | --- |
| `activity_id` | `varchar(100)` | PK，FK → `activity.id`，on delete cascade |
| `tagline` | `varchar(160)` | not null default `''` |
| `description` | `text` | not null default `''`，API ≤4000 |
| `venue` | `varchar(200)` | not null default `''` |
| `starts_at` | `timestamptz` | null |
| `ends_at` | `timestamptz` | null |
| `organizer` | `varchar(200)` | not null default `''` |
| `contact` | `varchar(200)` | not null default `''` |
| `announcement` | `text` | not null default `''`，API ≤2000 |
| `revision` | `integer` | not null default 0 |
| `updated_by` | `varchar(100)` | not null default `''` |
| `updated_at` | `timestamptz` | not null default `now()` |

读写通过 `plus/packages/db/src/activity-public-profile-repository.ts`。
无 profile 行时读模型返回默认空值（`revision: 0`），不要求每条活动先写一行。

### 4.2 `schedule_entry.starts_at`

迁移 `0031_schedule_entry_starts_at.ts`：`alterTable("schedule_entry").addColumn("starts_at", "timestamptz")`。
`StoredScheduleEntry`、`ScheduleSnapshotEntry`、`ScheduleEntryView`、`PublicProgramEntry`
都增加 `startsAt: string | null`（ISO）。

## 5. 命令与校验

`POST /api/activities/:id/public-profile`（需要 `idempotency-key`）：

```json
{
  "expectedRevision": 0,
  "tagline": "春日声场",
  "description": "……",
  "venue": "大学生活动中心剧场",
  "startsAt": "2026-04-18T11:00:00.000Z",
  "endsAt": "2026-04-18T13:30:00.000Z",
  "organizer": "校学生会文艺部",
  "contact": "……",
  "announcement": "初赛抽签结果已公布。"
}
```

校验：

| 规则 | 失败 |
| --- | --- |
| `tagline` 去空格后 ≤160；`description` ≤4000；`announcement` ≤2000；`venue/organizer/contact` ≤200 | `INVALID_INPUT` |
| `startsAt`/`endsAt` 必须是可解析 ISO；同时存在时 `endsAt >= startsAt` | `INVALID_INPUT` |
| `expectedRevision` 与当前行不一致 | `STALE_REVISION` |
| 活动不存在 | `NOT_FOUND` |
| 活动 `archived` | `ACTIVITY_ARCHIVED` |
| 无 `studio.manage` | `FORBIDDEN` |

命令返回完整 profile（含新的 `revision`）；编辑器必须用响应中的 `revision` 更新本地
`expectedRevision`，否则连续保存第二次会得到 `STALE_REVISION`。

`schedule.entry.upsert` 增加可选 `startsAt`（ISO）：

- 新条目省略或传 `null` → 无时间；
- 更新条目省略 → 保留原值；传 `null` → 清空；非法 ISO → `INVALID_INPUT`；
- 编辑器空字符串必须转成 `null`，不能把 `""` 当时间。

## 6. 接口

| 路由 | 访问 | 说明 |
| --- | --- | --- |
| `GET /api/public/events/:publicCode` | public | 聚合活动站读模型 |
| `POST /api/activities/:id/public-profile` | session + `studio.manage` | 更新公开资料 |
| `GET /api/activities/:id/studio` | studio | 返回增加 `publicProfile`，编辑器直接复用 |
| `POST /api/activities/:id/schedule/entries` | 既有 | body 增加 `startsAt` |

聚合响应：

```ts
interface PublicEventSite {
  activity: {
    publicCode: string;
    title: string;
    status: "active" | "closed";
    registrationEnabled: boolean;
    registrationOpen: boolean;
  };
  profile: {
    tagline: string;
    description: string;
    venue: string;
    startsAt: string | null;
    endsAt: string | null;
    organizer: string;
    contact: string;
    announcement: string;
  };
  schedule: {
    entries: readonly {
      order: number;
      slotLabel: string;
      title: string;
      note: string;
      startsAt: string | null;
    }[];
  } | null;
  program: {
    entries: readonly {
      order: number;
      name: string;
      song: string;
      note: string;
      startsAt: string | null;
    }[];
  } | null;
  results: {
    activityTitle: string;
    results: readonly {
      stageKey: string;
      publicTitle: string;
      releasedAt: string;
      decisions: readonly { rank: number; contestantName: string; score: string; unit?: "score" | "percent" }[];
      awards: readonly { award: string; contestantName: string }[];
    }[];
  } | null;
}
```

- `activity.registrationEnabled` 的精确定义：`enabledCapabilities` 同时包含
  `registration`、`questionnaire`、`materials`；`registrationOpen` 在此基础上再叠加
  活动 `active`、release 存在、报名生命周期为 `open`、名单未定稿，以及 questionnaire/materials
  的 release artifact 有效；
- `schedule` 与 `program` 同时存在时，页面只渲染节目单区（以 schedule 为准）；
  `program` 是有效的公开节目单：有 active release 时来自快照；从未发布时来自已审核报名；
  最新 release 已撤销时为 `null`；
- `results` 只包含 `active` 且来源已确认、未 stale 的 release，且活动必须是 `active|closed`；
  没有发布结果时为 `null`；页面展示“最新”阶段时按 `releasedAt` 降序、同刻按 `stageKey` 升序；
  `stageKey` 是发布定义的分组键（非数据库 ID），保留用于分组；不暴露 `releaseId` 与 `participantId`；
- 聚合读是投影，不是权威：所有字段来自现有公开读与公开资料，页面不得据此反推或改写业务事实；
- 限流 `public-event:<publicCode>` 120/min；`cache-control: no-store`。

公开读状态过滤：

| 读模型 | 规则 |
| --- | --- |
| `selectPublicResults` | 活动 `active|closed`；否则 `null` |
| `getPublicProgram` | 活动 `active|closed`；最新 release 已撤销 → `null`；从未发布 → 回退 approved |
| `getPublicSchedule` / `selectActiveScheduleRelease` | 活动 `active|closed`；最新 release 已撤销 → `null` |
| `getPublicEventSite` | 活动 `active|closed`；否则 `null` |

内部读不套用该过滤；归档活动仍可被 Ops/Studio/Admin/归档包读取和恢复。

## 7. 前端

### 7.1 公开活动站 `/e/$publicCode`

Portal 壳，静态渐变背景，不加载 WebGL：

```text
Topbar（副标题“活动主页”）
Hero：状态徽章 · 标题 · 标语 · 时间/地点/主办方 · [立即报名] [分享]
锚点导航：概览 / 节目单 / 赛果 / 报名（有内容才出现）
公告条（有公告才出现）
关于本次活动（有介绍才出现）
节目单：有 schedule 时显示开始时间 + slotLabel + 标题 + 备注；
         只有 program 时显示名称 + 曲目 + 备注；主持大字；打印
赛果：最新阶段前三名 + 奖项 + “查看完整赛果 →”
报名 CTA（开放 / 已截止 / 无需报名 / 已结束）
页脚：主办方 · 联系方式 · 公开码
```

规则：

- 空内容不渲染空壳；全空时显示“活动内容正在准备中”与报名入口（若启用报名）；
- CTA 优先级：活动 `closed` → “活动已结束”，主 CTA 改为查看赛果（无赛果时不显示该 CTA）；
  `registrationOpen` → “立即报名”；启用报名但未开放 → “报名已截止”；
  未启用报名 → “本活动无需报名”，不显示报名按钮；
- 时间用与 `ResultsView.formatReleasedAt` 同一套 `Intl.DateTimeFormat("zh-CN", { dateStyle, timeStyle })`
  浏览器本地时区显示；节目单条目按 `startsAt` 升序，无时间的条目按 `position` 排在最后；
  多天时按本地日期分组；只有 program（无 schedule）时不显示时间列；
- 分享优先 `navigator.share`，回退 `navigator.clipboard`，可见 `role="status"`，2 秒复位；
- 打印 `@media print` 切白底黑字，隐藏导航、分享、背景装饰；
- `document.title`、`meta description` 随数据更新；**per-event Open Graph 不做**：
  纯 SPA 的 `og:` 标签社交爬虫读不到，需要服务端渲染 meta 端点，列为后续增强；
- 390px 无横向滚动；桌面内容宽 1180px；
- `/results/$code` 与 `/program/$code` 增加“返回活动主页”链接；`/join/$code` 报名完成后回链。

组件拆分：`EventHero`、`EventAbout`、`EventProgram`、`EventResults`、`EventShare`。
样式新增 `styles/portal-event.css`，在 `global.css` 中排在 `portal.css` 之后。

### 7.2 Studio 公开主页编辑 `/studio/$activityId/public`

Console 壳，权限 `studio.manage`：

- 左列表单：标语、介绍、地点、起止时间、主办方、联系方式、公告；
- 右列 sticky：预览卡（复用 `EventHero`/`EventAbout`）、保存、查看公开页；
  草稿活动提示“活动激活后公开页才可见”；
- 保存带 `expectedRevision`；成功后用响应 `revision` 更新本地状态；`STALE_REVISION` 提示刷新，不覆盖；
- `archived` 活动只读；
- Studio 活动页头部与 Workspace 活动卡增加“公开主页”入口。

### 7.3 Ops 节目排期

`ScheduleCard` 增加：

- 新增条目时的 `datetime-local` 开始时间（浏览器本地时区 ↔ ISO，空值转 `null`）；
- 条目行显示格式化后的时间；
- 行内“编辑”表单（slot、标题、备注、开始时间），保存走 `schedule.entry.upsert` 的 `entryId` 分支；
- 已发布节目单仍显示版本与撤销入口，不改变现有生命周期。

### 7.4 公开壳与 `/program`

`PortalShell`：

- `/e/*` 副标题“活动主页”，使用静态背景（与 `/vote/*` 同类），不挂 WebGL；
- `/results/*` 保持“赛果公示”；
- `/` 保持现状，不改变公开码入口的“查看赛果”语义。

`/program/$code`：

- 最新节目单已撤销或从未发布时，不再显示笼统的“加载失败”，而是“节目单未发布或已撤回”；
- 活动归档时返回未找到；
- 有 `startsAt` 时显示开始时间（浏览器本地时区，格式化规则同活动站）；
- 增加“返回活动主页”链接。

## 8. 错误与可见性

| 情况 | 行为 |
| --- | --- |
| 公开码不存在 / draft / archived | 404：“活动不存在或尚未公开” |
| 加载失败 | 错误态 + 重试 |
| 报名未启用 | “本活动无需报名”，不显示报名按钮 |
| 报名启用但关闭 | CTA 变“报名已截止”，页面保留 |
| closed | 状态徽章“已结束”，赛果保留 |
| archived | 公开读 404/null；Ops/Studio/Admin 内部仍可见；`unarchive` 回到 closed 后公开页恢复 |
| 最新节目单撤销 | 公开日程/节目单下线；不回退旧版或报名名单 |
| 编辑冲突 | “已被其他操作更新”，刷新后重试 |
| 无权限 | Studio 编辑页 EmptyState：“缺少 studio.manage” |

## 9. Test architecture

### 9.1 契约与能力

- 不新增 capability；`activity.public_profile.update` 是 engine 命令，沿用 `activity.rename` 的命令形状。
- `schedule.entry.upsert` 扩展一个可选字段，不改变生命周期与命令范围。
- archive 包增加一个只读快照，不改变 archive 命令生命周期。
- 不新增 lifecycle 模板；不扩展 `plus/tools/contracts/src/harness/adapters/`（无 schedule/archive adapter）。
- 公开页是只读投影，不产生业务事实。

### 9.2 消费者、读模型、路由、事件、topic

`graph:check` 需要保持零 unresolved：

- 新增路由 `GET /api/public/events/:publicCode`（`/api/public/` 前缀，API-only）；
- 新增路由 `POST /api/activities/:id/public-profile`（Web 编辑器调用）；
- 新增命令 `activity.public_profile.update`（engine 前缀）；
- 新增事件 `ActivityPublicProfileUpdated`（`Activity` 前缀）；
- 新增表 `activity_public_profile`；
- 扩展 runtime `PublicActivity` 与 web `api/registrations.ts` 的 `PublicActivity`
  （`registrationEnabled`）、`StudioState`（`publicProfile`）、
  `ScheduleView`、`ScheduleSnapshotEntry`、`PublicProgramEntry`；
- 归档包新增 `public-profile.json` artifact；
- 新增 Web 路由 `/e/$publicCode`、`/studio/$activityId/public`；
- 不新增 realtime topic。

### 9.3 生命周期边界、终态与 mode 隔离

- 活动生命周期：`draft → active → closed → archived`；公开站只在 `active`/`closed` 可见；
- `archived` 拒绝公开资料编辑；`draft`/`active`/`closed` 可编辑；
- `archived` 公开读全部下线，但内部读与 `unarchive` 不受影响；`unarchive` 回到 `closed` 后公开读恢复；
- `duplicateActivity` 不复制公开资料；新活动没有 profile 行；
- 日程仍只允许 `active` 活动写入；公开日程只读 `formal` 模式的 active release；
- `test`/`rehearsal` 的节目、评分、签到事实不得出现在 `/api/public/events` 响应中；
- 公开资料是活动级数据，没有 mode 维度；测试/彩排不产生独立公开资料。

### 9.4 适配器

不新增 capability adapter。命令与读模型用真实 PostgreSQL 和真实命令路径测试：
`plus/packages/runtime/test/public-profile-service.test.ts`、
`plus/packages/runtime/test/public-event-service.test.ts`；扩展
`plus/packages/runtime/test/schedule-service.test.ts`、
`plus/packages/runtime/test/archive-package.test.ts`（精确 artifact 列表断言）、
`plus/packages/runtime/test/archive-service.test.ts`、
`plus/packages/runtime/test/golden-archive-identity.test.ts`。

### 9.5 故障注入与恢复状态

| 故障 | 注入方式 | 断言 |
| --- | --- | --- |
| 事务内事件写入失败 | `RuntimeDeps.newEventId` 抛错 | profile 行、receipt、audit、outbox 均无残留；改用正常 deps 重试同一 `commandId` 成功 |
| 两个首次保存并发 | 并发发起两个相同 `expectedRevision: 0` 的更新；测试用顺序 `await` 保证确定性，activity 行锁负责序列化 | 第一个创建成功；第二个 `STALE_REVISION`；只有一行 |
| 重复命令 | 同一 `commandId` 重放 | 只写一次，返回 replay 标记，版本不二次递增 |
| 最新节目单撤销 | 发布 v1、发布 v2、撤销 v2 | `getPublicSchedule` 与 `getPublicProgram` 都为 `null`，不回退 v1 或 approved registrations |
| 从未发布节目单 | 只有 approved registrations | `getPublicProgram` 回退 approved；`getPublicSchedule` 为 `null` |
| 归档公开下线 | 归档带 active result release 的活动 | `/e`、`/results`、`/program`、`/schedule` 四个公开面都返回 `null`/404；内部 `getPublishingState`/`getScheduleState` 仍返回数据；unarchive 后恢复 |
| 公开读依赖缺失 | 无 profile / 无结果 | 聚合读返回默认 profile、`null` 区段，不抛 500 |
| 旧快照无 `startsAt` | 插入 v1 快照 | 读取规范化为 `null`，不重写快照 |
| mode 隔离 | 创建 rehearsal schedule release 与 formal release | 公开读只返回 formal；rehearsal 永不出现 |

不使用任意 sleep；并发用顺序命令构造确定性竞态。

### 9.6 现有测试为什么不够

- `public-results.spec.ts` 只覆盖赛果与 landing，不覆盖活动资料、聚合读、归档可见性；
- `schedule-service.test.ts` 覆盖条目与发布，但不覆盖 `startsAt`、旧快照兼容、公开节目时间、
  最新 release 撤销后的 `getPublicProgram`；
- `activity-service.test.ts` 覆盖 rename/close/archive，不覆盖公开资料命令与 duplicate 不复制；
- `archive-package.test.ts` 的精确 artifact 列表会因新增 `public-profile.json` 失败；
- `archive-service.test.ts` / `golden-archive-identity.test.ts` 不覆盖公开资料 artifact；
- Studio E2E 覆盖定义/发布，不覆盖公开资料编辑；
- 现有 API 测试没有 `/api/public/events`。

### 9.7 防膨胀 / anti-bloat 决定

- 扩展 `schedule-service.test.ts`，不新建 schedule 测试套件；
- 新增一个聚焦的 `ScheduleCard.test.tsx`（当前只有 `schedule.spec.ts` E2E 覆盖），只覆盖 `startsAt`
  与行内编辑，不复制现有 E2E 模板；
- 公开页新增一个 `public-event.spec.ts` E2E，因为它是一条独立用户旅程，不能塞进赛果用例；
- 命令测试独立成 `public-profile-service.test.ts`，因为它是新的 engine 命令面，但只覆盖一条命令；
- 归档测试扩展现有 `archive-package.test.ts`、archive/golden 用例，不新建归档套件；
- 不引入通用“页面配置”框架、不做 per-field 抽象、不新增第二个 UI 设计系统。

### 9.8 聚焦门禁

```powershell
Set-Location plus
pnpm run check
$env:ARTFLOW_PLUS_DATABASE_URL = "postgresql://artflow:artflow_dev@127.0.0.1:5433/artflow_plus"
$env:REQUIRE_DB = "1"
pnpm run test
pnpm run schema:check
pnpm --filter @artflow-plus/web test:e2e -- public-event.spec.ts schedule.spec.ts a11y.spec.ts
```

仓库级：

```powershell
uv run pytest tests/gates -q
uv run python tests/golden/validate_fixtures.py
pwsh -NoProfile -File scripts/check_docs.ps1
```

迁移后必须重新生成 `plus/packages/db/schema.snapshot.json` 与 `plus/packages/db/src/types.ts`。

## 10. 归档包

归档时冻结公开资料，写入 `public-profile.json`：

```json
{
  "activityId": "act-...",
  "tagline": "春日声场",
  "description": "……",
  "venue": "大学生活动中心剧场",
  "startsAt": "2026-04-18T11:00:00.000Z",
  "endsAt": "2026-04-18T13:30:00.000Z",
  "organizer": "校学生会文艺部",
  "contact": "……",
  "announcement": "……",
  "revision": 3,
  "updatedBy": "user-...",
  "updatedAt": "2026-04-01T10:00:00.000Z"
}
```

- 无 profile 行时写入 `null`；
- `ArchivePackageInput.publicProfile` 设为可选；缺失时按 `null` 处理，避免破坏直接调用
  `buildArchivePackage` 的现有测试；
- `README.txt` 的“包含”行增加“活动公开资料快照（如有）”；
- 不改变 `ArchiveManifest.counts`；artifact 列表增加一项；
- 归档包的公开资料是冻结快照，归档后编辑公开资料不会改写已封包内容。

## 11. 迁移与兼容

- `0030_activity_public_profile.ts`：建表；
- `0031_schedule_entry_starts_at.ts`：加列；
- `ScheduleSnapshot.entries[*].startsAt` 为附加字段，旧快照读取时补 `null`；
- 旧活动没有 profile 行时返回默认空资料，公开页仍按标题/节目/赛果渲染；
- 公开聚合读不替代现有 `/api/public/activities|programs|schedule|results`，旧链接继续可用；
- 归档包新增 artifact 是加法变更，`schemaVersion` 保持 1；`archive-package.test.ts` 的精确 artifact
  列表与 golden archive identity 用例同步更新。

## 12. 实施顺序

1. 迁移 + repository + `activity.public_profile.update` + runtime 测试；
2. `starts_at` 仓储/命令/发布快照 + schedule 测试；
3. 公开读 fail-closed/归档过滤修正 + `registrationEnabled` + 聚合读 + API 测试；
4. `/e/$publicCode` 页面 + 组件 + CSS + 单测；
5. `/studio/$activityId/public` 编辑器 + 入口 + 单测；
6. Ops `ScheduleCard` 时间与行内编辑 + 单测；
7. 归档包 `public-profile.json` + archive 测试；
8. E2E seed、a11y、文档、门禁。

每一步单独提交；迁移与生成文件同一次改动完成。

## 13. 风险与待决

- **跨时区**：时间按访客浏览器本地时区显示，与现有赛果页一致；跨时区组织者/访客会看到换算后的时间。
  若客户需要按活动时区显示，后续增加活动 `time_zone` 与经过测试的换算工具。
- **公开资料审核**：本版没有“提交审核/批准”流程，`studio.manage` 直接发布；如果客户需要双人复核，
  后续为 profile 增加 `status` 与审批命令。
- **时间冲突**：本版不校验同一天条目的时间重叠；冲突提示属于 Ops 排期增强，不在本轮。
- **打印样式**：只覆盖节目单与活动概览；票券/签到码打印不在本轮。
- **归档后内部操作**：本变更只影响公开读。归档活动的业务写命令仍受既有生命周期约束；
  如果需要在归档后继续编辑节目/结果，需要另开生命周期变更。
