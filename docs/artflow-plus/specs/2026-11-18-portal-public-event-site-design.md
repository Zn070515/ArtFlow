# Portal 公开活动站设计

- **Status**: proposed
- **Date**: 2026-11-18
- **Scope**: `plus/apps/web` Portal 面新增 `/e/$publicCode` 活动站；`plus/apps/api` 新增公开聚合读与活动公开资料命令；`schedule_entry` 增加 `starts_at`
- **相关**: [前端视觉方向](../frontend-design-direction.md)、[ADR-0016 公开门户](../../architecture/adr/0016-web-shell-and-public-portal.md)、[ADR-0034 Portal/Console 双壳](../../architecture/adr/0034-portal-console-shell-split.md)、[GOAL](../../../GOAL.md)

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
- 不引入新的 UI 框架或第二套设计系统。

## 2. 现状与缺口

| 能力 | 现状 | 缺口 |
| --- | --- | --- |
| 公开活动 | `GET /api/public/activities/:publicCode` 只返回 `id/publicCode/title/status/registrationOpen` | 没有介绍、时间、地点、主办方、联系方式、公告 |
| 公开结果 | `GET /api/public/results/:publicCode` | 只有结果，没有活动上下文 |
| 公开节目单 | `GET /api/public/programs/:publicCode`；页码 `program.tsx` 使用内联样式 | 没有统一活动站；没有逐条开始时间 |
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

### 3.3 公开页是一个聚合读，不是新业务

`GET /api/public/events/:publicCode` 只组合现有公开读（活动、节目单、日程、赛果）与公开资料，
不复制业务规则。可见性统一为：

```text
draft      → 404
active     → 可见
closed     → 可见（状态显示“已结束”）
archived   → 404
```

公开 DTO 剥离内部 ID：节目只出 `name/song/note`，日程只出 `slotLabel/title/note`，
赛果只出姓名。`test` / `rehearsal` 数据永不进入公开读；日程只读 `formal` 模式的活动 release。

### 3.4 日程条目增加 `starts_at`

`schedule_entry` 增加可空 `starts_at timestamptz`；`schedule_release.snapshot.entries`
增加 `startsAt: string | null`。这是**附加字段**：

- snapshot 的 `version` / `schemaVersion` 保持 1；
- 读取旧快照时把缺失的 `startsAt` 规范化为 `null`，不重写历史快照；
- 写入时校验 ISO 时间可解析；`endsAt`/`startsAt` 的跨条目先后不作为硬约束，组织者可以为
  非顺序节目留空。

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
| `time_zone` | `varchar(64)` | not null default `'Asia/Shanghai'` |
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
都增加 `startsAt: string | null`。

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
  "timeZone": "Asia/Shanghai",
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
| `timeZone` 必须能被 `Intl.DateTimeFormat` 接受 | `INVALID_INPUT` |
| `expectedRevision` 与当前行不一致 | `STALE_REVISION` |
| 活动不存在 | `NOT_FOUND` |
| 活动 `archived` | `ACTIVITY_ARCHIVED` |
| 无 `studio.manage` | `FORBIDDEN` |

`schedule.entry.upsert` 增加可选 `startsAt`：

- 新条目省略或传 `null` → 无时间；
- 更新条目省略 → 保留原值；传 `null` → 清空；非法 ISO → `INVALID_INPUT`。

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
    registrationOpen: boolean;
  };
  profile: {
    tagline: string;
    description: string;
    venue: string;
    startsAt: string | null;
    endsAt: string | null;
    timeZone: string;
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

- `schedule` 与 `program` 同时存在时，页面只渲染节目单区（以 schedule 为准），避免同一批条目重复展示；
- `results` 只包含 `active` 且来源已确认、未 stale 的 release；没有发布结果时为 `null`；
- 聚合读是投影，不是权威：所有字段来自现有公开读与公开资料，页面不得据此反推或改写业务事实；
- 限流 `public-event:<publicCode>` 120/min；`cache-control: no-store`。

## 7. 前端

### 7.1 公开活动站 `/e/$publicCode`

Portal 壳，静态渐变背景，不加载 WebGL：

```text
Topbar（副标题“活动主页”）
Hero：状态徽章 · 标题 · 标语 · 时间/地点/主办方 · [立即报名] [分享]
锚点导航：概览 / 节目单 / 赛果 / 报名（有内容才出现）
公告条（有公告才出现）
关于本次活动（有介绍才出现）
节目单：开始时间 + slotLabel + 标题 + 备注；主持大字；打印
赛果：最新阶段前三名 + 奖项 + “查看完整赛果 →”
报名 CTA（开放 / 已截止 / 已结束）
页脚：主办方 · 联系方式 · 公开码
```

规则：

- 空内容不渲染空壳；全空时显示“活动内容正在准备中”与报名入口；
- CTA 文案：`registrationOpen` → “立即报名”；活动 `active` 但报名未开放 → “报名已截止”；活动 `closed` → “活动已结束”，主 CTA 改为查看赛果；
- 时间用 `profile.timeZone` 格式化，多天时按日期分组；没有 `startsAt` 的条目归入“未排时间”；
- 分享优先 `navigator.share`，回退 `navigator.clipboard`，可见 `role="status"`，2 秒复位；
- 打印 `@media print` 切白底黑字，隐藏导航、分享、背景装饰；
- `document.title`、`meta description`、`og:title`/`og:description` 随数据更新；
- 390px 无横向滚动；桌面内容宽 1180px。

组件拆分：`EventHero`、`EventAbout`、`EventProgram`、`EventResults`、`EventShare`。
样式新增 `styles/portal-event.css`，在 `global.css` 中排在 `portal.css` 之后。

### 7.2 Studio 公开主页编辑 `/studio/$activityId/public`

Console 壳，权限 `studio.manage`：

- 左列表单：标语、介绍、地点、起止时间、时区、主办方、联系方式、公告；
- 右列 sticky：预览卡（复用 `EventHero`/`EventAbout`）、保存、查看公开页；
- 保存带 `expectedRevision`；`STALE_REVISION` 提示刷新，不覆盖；
- `archived` 活动只读；
- Studio 活动页头部与 Workspace 活动卡增加“公开主页”入口。

### 7.3 Ops 节目排期

`ScheduleCard` 增加：

- 新增条目时的 `datetime-local` 开始时间；
- 条目行显示格式化后的时间；
- 行内“编辑”表单（slot、标题、备注、开始时间），保存走 `schedule.entry.upsert` 的 `entryId` 分支；
- 已发布节目单仍显示版本与撤销入口，不改变现有生命周期。

### 7.4 公开壳

`PortalShell`：

- `/e/*` 副标题“活动主页”，使用静态背景（与 `/vote/*` 同类），不挂 WebGL；
- `/results/*` 保持“赛果公示”；
- `/` 保持现状，不改变公开码入口的“查看赛果”语义。

## 8. 错误与可见性

| 情况 | 行为 |
| --- | --- |
| 公开码不存在 / draft / archived | 404：“活动不存在或尚未公开” |
| 加载失败 | 错误态 + 重试 |
| 报名关闭 | CTA 变“报名已截止”，页面保留 |
| closed | 状态徽章“已结束”，赛果保留 |
| 编辑冲突 | “已被其他操作更新”，刷新后重试 |
| 无权限 | Studio 编辑页 EmptyState：“缺少 studio.manage” |
| 日程 release 被撤销 | 公开页不再显示日程/节目单，回到报名与赛果 |

## 9. Test architecture

### 9.1 契约与能力

- 不新增 capability；`activity.public_profile.update` 是 engine 命令，沿用 `activity.rename` 的命令形状。
- `schedule.entry.upsert` 扩展一个可选字段，不改变生命周期与命令范围。
- 不新增 lifecycle 模板；不扩展 `plus/tools/contracts/src/harness/adapters/`（无 schedule adapter）。
- 公开页是只读投影，不产生业务事实。

### 9.2 消费者、读模型、路由、事件、topic

`graph:check` 需要保持零 unresolved：

- 新增路由 `GET /api/public/events/:publicCode`（`/api/public/` 前缀，API-only）；
- 新增路由 `POST /api/activities/:id/public-profile`（Web 编辑器调用）；
- 新增命令 `activity.public_profile.update`（engine 前缀）；
- 新增事件 `ActivityPublicProfileUpdated`（`Activity` 前缀）；
- 新增表 `activity_public_profile`；
- 扩展 `StudioState`、`ScheduleView`、`ScheduleSnapshotEntry`、`PublicProgramEntry`；
- 新增 Web 路由 `/e/$publicCode`、`/studio/$activityId/public`；
- 不新增 realtime topic。

### 9.3 生命周期边界、终态与 mode 隔离

- 活动生命周期：`draft → active → closed → archived`；公开站只在 `active`/`closed` 可见；
- `archived` 拒绝公开资料编辑；`draft`/`active`/`closed` 可编辑；
- 日程仍只允许 `active` 活动写入；公开日程只读 `formal` 模式的 active release；
- `test`/`rehearsal` 的节目、评分、签到事实不得出现在 `/api/public/events` 响应中；
- 公开资料是活动级数据，没有 mode 维度；测试/彩排不产生独立公开资料。

### 9.4 适配器

不新增 capability adapter。命令与读模型用真实 PostgreSQL 和真实命令路径测试：
`plus/packages/runtime/test/public-profile-service.test.ts`、
`plus/packages/runtime/test/public-event-service.test.ts`；扩展
`plus/packages/runtime/test/schedule-service.test.ts`。

### 9.5 故障注入与恢复状态

| 故障 | 注入方式 | 断言 |
| --- | --- | --- |
| 事务内事件写入失败 | `RuntimeDeps.newEventId` 抛错 | profile 行、receipt、audit、outbox 均无残留；改用正常 deps 重试同一 `commandId` 成功 |
| 并发更新 | 两个相同 `expectedRevision` 的更新顺序执行 | 第二个 `STALE_REVISION`，第一个完整落库；无半写 |
| 重复命令 | 同一 `commandId` 重放 | 只写一次，返回 replay 标记，版本不二次递增 |
| 公开读依赖缺失 | 无 profile / 无 schedule release / 无结果 | 聚合读返回默认 profile、`null` 区段，不抛 500 |
| 旧快照无 `startsAt` | 插入 v1 快照 | 读取规范化为 `null`，不重写快照 |

不使用任意 sleep；并发用顺序命令构造确定性竞态。

### 9.6 现有测试为什么不够

- `public-results.spec.ts` 只覆盖赛果与 landing，不覆盖活动资料、聚合读、可见性；
- `schedule-service.test.ts` 覆盖条目与发布，但不覆盖 `startsAt`、旧快照兼容、公开节目时间；
- `activity-service.test.ts` 覆盖 rename/close/archive，不覆盖公开资料命令；
- Studio E2E 覆盖定义/发布，不覆盖公开资料编辑；
- 现有 API 测试没有 `/api/public/events`。

### 9.7 防膨胀决定

- 扩展 `schedule-service.test.ts`，不新建 schedule 测试套件；
- 新增一个聚焦的 `ScheduleCard.test.tsx`（当前只有 `schedule.spec.ts` E2E 覆盖），只覆盖 `startsAt` 与行内编辑，不复制现有 E2E 模板；
- 公开页新增一个 `public-event.spec.ts` E2E，因为它是一条独立用户旅程，不能塞进赛果用例；
- 命令测试独立成 `public-profile-service.test.ts`，因为它是新的 engine 命令面，但只覆盖一条命令；
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

## 10. 迁移与兼容

- `0030_activity_public_profile.ts`：建表；
- `0031_schedule_entry_starts_at.ts`：加列；
- `ScheduleSnapshot.entries[*].startsAt` 为附加字段，旧快照读取时补 `null`；
- 旧活动没有 profile 行时返回默认空资料，公开页仍按标题/节目/赛果渲染；
- 公开聚合读不替代现有 `/api/public/activities|programs|schedule|results`，旧链接继续可用。

## 11. 实施顺序

1. 迁移 + repository + `activity.public_profile.update` + runtime 测试；
2. `starts_at` 仓储/命令/发布快照 + schedule 测试；
3. 公开聚合读 + API 路由 + API 测试；
4. `/e/$publicCode` 页面 + 组件 + CSS + 单测；
5. `/studio/$activityId/public` 编辑器 + 入口 + 单测；
6. Ops `ScheduleCard` 时间与行内编辑 + 单测；
7. E2E seed、a11y、文档、门禁。

每一步单独提交；迁移与生成文件同一次改动完成。

## 12. 风险与待决

- **公开资料审核**：本版没有“提交审核/批准”流程，`studio.manage` 直接发布；如果客户需要双人复核，后续为 profile 增加 `status` 与审批命令。
- **时区**：默认 `Asia/Shanghai`，编辑页允许输入 IANA 时区；显示按活动时区而非访客时区。若客户跨时区运营，需要再做一次确认。
- **时间冲突**：本版不校验同一天条目的时间重叠；冲突提示属于 Ops 排期增强，不在本轮。
- **打印样式**：只覆盖节目单与活动概览；票券/签到码打印不在本轮。
