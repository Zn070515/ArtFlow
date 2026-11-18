# 参与者个人中心设计

- **Status**: proposed
- **Date**: 2026-11-18
- **Scope**: Portal 参与者面新增 `/me` 与 `/me/$publicCode`；新增 `GET /api/me`、`POST /api/me/notifications/read`；新增 `participant_notification_read` 已读状态表
- **相关**: [公开活动站设计](./2026-11-18-portal-public-event-site-design.md)、[前端视觉方向](../frontend-design-direction.md)、[GOAL](../../../GOAL.md)

## 0. 结论

1. **完整个人中心**：我的报名、审核状态与备注、材料列表与下载、个人赛程、我的赛果、活动主页链接。
2. **通知收件箱采用派生模型**：从当前报名/材料/节目单/赛果/公告状态实时派生通知；只持久化已读状态，不新增 outbox 事件投影。
3. **归档活动只读可见**：参与者能看到自己的报名和材料，但赛程/赛果为空、公开活动页链接隐藏；与“公开下线、内部可见”的既有边界一致。
4. **已读状态是用户偏好，不是业务事实**：直接 upsert，不写 audit/outbox；规格明确记录这一例外。

## 1. 目标

Portal 目前只有报名和补交入口；参与者提交后没有地方查看审核结果、材料状态、个人赛程和赛果。
本设计交付一个登录后的个人中心，让参与者：

- 看到自己参加的所有活动及当前进度；
- 看到审核备注和需要补交的材料；
- 看到属于自己的节目单条目与已发布赛果；
- 收到并处理“报名已通过 / 材料需补交 / 节目单已发布 / 赛果已发布”等通知。

### 非目标

- 不做站内信、推送、邮件通知；
- 不做通知历史时间线（派生模型只反映当前状态）；
- 不允许在 `/me` 直接修改材料内容；编辑仍走 `/join/$publicCode`；
- 不做消息分页、搜索、已读归档清理；
- 不改变报名、材料、赛程、赛果的命令与生命周期。

## 2. 路由与接口

| 路由 | 访问 | 说明 |
| --- | --- | --- |
| `/me` | Portal，RequireSession | 我的活动 + 通知收件箱 |
| `/me/$publicCode` | Portal，RequireSession | 单活动详情 |
| `GET /api/me` | session | 一次返回 `{ events, notifications }` |
| `POST /api/me/notifications/read` | session | 标记通知已读，返回 `{ unreadCount }` |

- 未登录访问 `/me`：`RequireSession` 跳 `/login?next=/me`，登录后回到 `/me`。
- `PortalShell` 主导航增加「我的」。
- API 路由放在新模块 `plus/apps/api/src/routes/me.ts`，导出 `registerMeRoutes(ctx: ApiContext)`，在 `app.ts` 注册；不把路由写进 `app.ts`。

## 3. 读模型

### 3.1 我的活动

按 `registration.participant_id = actor.actorId` 跨活动查询，`ORDER BY registration.updated_at DESC, registration.id`。

```ts
interface MyCenter {
  events: readonly MyEvent[];
  notifications: {
    items: readonly MyNotification[];
    unreadCount: number;
  };
}

interface MyEvent {
  activity: {
    publicCode: string;
    title: string;
    status: "draft" | "active" | "closed" | "archived";
    startsAt: string | null;
    endsAt: string | null;
    venue: string;
    organizer: string;
  };
  registration: {
    status: "draft" | "submitted" | "need_supplement" | "approved" | "rejected" | "withdrawn";
    editable: boolean;
    reviewNote?: string;
    supplementKeys: readonly string[];
    createdAt: string;
    updatedAt: string;
  };
  materials: readonly {
    id: string;
    questionKey: string;
    originalName: string;
    contentType: string;
    byteLength: number;
    status: "uploaded" | "approved" | "needs_supplement";
    reviewNote: string;
    revision: number;
    contentPath: string | null;
    reviewedAt: string | null;
    updatedAt: string | null;
  }[];
  schedule: readonly {
    order: number;
    slotLabel: string;
    title: string;
    note: string;
    startsAt: string | null;
  }[];
  results: readonly {
    stageKey: string;
    publicTitle: string;
    releasedAt: string;
    rank: number;
    score: string;
    unit?: "score" | "percent";
    awards: readonly string[];
  }[];
  links: {
    event: string | null;
    edit: string | null;
  };
  archived: boolean;
}

interface MyNotification {
  key: string;
  kind: "registration" | "material" | "announcement" | "schedule" | "result";
  title: string;
  body: string;
  activity: { publicCode: string; title: string };
  createdAt: string;
  read: boolean;
  href: string;
}
```

实现规则：

- **活动资料**：复用 `getActivityPublicProfile`；`profile.startsAt/endsAt/venue/organizer` 填入活动上下文。
- **报名时间**：`registration.created_at/updated_at`；新增 `listRegistrationsByParticipant` 查询，不修改领域 `RegistrationState`。
- **材料**：`listMaterials` 只取 `current = true`；`StoredMaterial` 增加 `createdAt/updatedAt`（表已有列），用于通知时间。
- **材料下载权限**：只有 `material.ownerActorId === actorId` 时返回 `contentPath`；主办方代传的材料只显示元数据与「由主办方上传」，
  不提供下载链接。原因：现有 `readMaterialForActor` 只允许 owner 或 staff 读取，参与者会话不能下载 staff 代传的文件。
- **个人赛程**：`selectActiveScheduleRelease`（formal、active/closed、最新 release 未撤销）后按 `entry.participantId === actorId` 过滤；没有 release 或没有我的条目 → `[]`。
  分组/团体节目如果组织者没有为每个成员写入条目，个人赛程为空；本轮不做分组映射，页脚提示「没有你的条目」而不是猜测。
- **我的赛果**：`selectPublicResults`（active/closed、active release、未 stale）后按 `decision.contestantId === actorId` 和 `award.contestantId === actorId` 过滤；同一 release 的排名与该 release 中属于我的全部奖项合并为一条 `results`（`awards` 数组，可为空）。
- **可编辑性**：`editable = getPublicActivity(publicCode).registrationOpen && (status === "draft" || status === "need_supplement")`；
  这同时覆盖活动状态、报名生命周期、名单是否定稿与能力是否齐全。
- **链接**：`event = activity.status === "active" || activity.status === "closed" ? "/e/<publicCode>" : null`；
  `edit = editable ? "/join/<publicCode>" : null`。
- **材料下载**：服务端生成 `contentPath = "/api/activities/<activityId>/materials/<materialId>/content"`；复用现有 owner 可读的受控路由，不在客户端拼内部 ID。
- **归档**：`archived = true` 时 `schedule`、`results` 为空，`event` 为 `null`；报名与材料保留。
- 事件顺序按 `registration.updatedAt` 降序；同一时间按 `publicCode`。

### 3.2 通知派生

通知 key 必须稳定、可重建、不含明文内部 ID 之外的可变状态：

| kind | 生成条件 | key | createdAt | title / body |
| --- | --- | --- | --- | --- |
| `registration` | 状态 ∈ submitted / need_supplement / approved / rejected / withdrawn | 审核态：`<publicCode>:registration:<status>:<reviewedBy ?? "system">:<sha256(reviewNote).slice(0,12)>`；提交/撤回态：`<publicCode>:registration:<status>:<revision>` | `registration.updated_at` | 按状态；need_supplement/rejected 带 `reviewNote` |
| `material` | 状态 ∈ approved / needs_supplement | `<publicCode>:material:<materialId>:<status>:<revision>` | `reviewed_at ?? updated_at` | 材料名 + 审核备注 |
| `announcement` | `profile.announcement` 非空且活动 `active|closed` | `<publicCode>:announcement:<sha256(announcement).slice(0,16)>` | `profile.updatedAt` | 活动公告 + 全文 |
| `schedule` | 我在 active formal release 中 | `<publicCode>:schedule:<releaseId>` | `release.releasedAt` | 节目单已发布 |
| `result` | 我在 active result release 中 | `<publicCode>:result:<releaseId>` | `release.releasedAt` | 赛果已发布 + 我的名次/奖项 |

- 通知按 `createdAt` 降序，同刻按 `key` 升序。
- `read` 来自 `participant_notification_read`；`unreadCount` 是未读条目数。
- 审核态使用 `reviewedBy + reviewNote` 哈希而不是 `registration.revision`：参与者在 `need_supplement` 下修改答案会递增 revision，
  但审核结论没有变化，不应反复生成新通知。提交/撤回态仍用 revision，区分重新提交。
- 同一状态/版本只产生一个条目；状态变化或新 release 产生新 key，旧条目从 feed 消失（派生模型已知取舍）。
- 审核态条目的 `createdAt` 用 `registration.updated_at`；答案编辑会让时间前移，但 key 不变、不会重新变未读。
- 归档活动只保留 `registration` 与 `material` 通知；不生成公告/节目单/赛果通知。
- 通知正文是纯文本，React 负责转义；不渲染 HTML。

## 4. 已读状态

新表 `participant_notification_read`：

| 列 | 类型 | 约束 |
| --- | --- | --- |
| `actor_id` | `varchar(100)` | not null |
| `notification_key` | `varchar(300)` | not null |
| `read_at` | `timestamptz` | not null default `now()` |

主键 `(actor_id, notification_key)`。

- `POST /api/me/notifications/read` body：`{ keys: string[] }`，`1..200` 条，每条 `1..300` 字符。
- 服务端重新计算当前 feed 的 key 集合，只对存在的 key upsert；未知 key 忽略。
- 使用 `on conflict do nothing` 保持首次已读时间；返回当前 `unreadCount`。
- **不写 audit、不写 outbox、不产生业务事件**：这是 actor 自己的 UI 偏好，不改变任何报名/材料/赛程/赛果事实。规格明确记录这一例外；如果未来需要“已读审计”，再升级为命令。
- 表没有 activity FK：key 已包含 publicCode；activity 删除/归档不会影响 actor 的已读偏好。账号删除清理不在本轮。

## 5. 生命周期与权限

- `/api/me*` 一律 `config.access: "session"`；使用 `requestDeps` 的 `actor.actorId`，与 `GET /api/activities/:id/registrations/mine` 同一身份规则。
- 只返回 actor 自己的 registration；材料按 registration 加载；不存在跨 participant 读取路径。
- 赛程/赛果严格复用公开读规则：`active|closed`、formal、active release、未撤销/未 stale；`test`/`rehearsal` 永不出现。
- `archived` 活动：报名/材料只读可见；赛程/赛果为空；公开页链接为 `null`。
- 已读状态不授予任何业务权限，不改变任何命令的权限判断。
- **补充材料**：`/me` 只在 `editable` 时链接 `/join/$publicCode`；如果名单已定稿、主办方另行签发了 supplement token，
  参与者应使用主办方发送的补交链接。`/me` 不读取、不展示、不转发 supplement token。
- 通知 key 中的 `materialId`/`releaseId` 是内部标识，但只出现在 actor 自己的 feed key 中，不作为公开 URL；不向客户端暴露额外内部数据。

## 6. 前端

### 6.1 `/me`

- 1180px 双列：左侧「我的活动」卡片流，右侧「通知」rail；<900px 堆叠。
- 活动卡：标题、活动状态 Badge、报名状态 Badge、更新时间、审核备注、材料 `n/total`（需补交标红）、下一步按钮（查看活动仅在 `links.event` 非空时显示；编辑报名/补充材料仅在 `editable` 时显示）、个人赛程与赛果摘要。
- 通知 rail：未读计数、未读点、kind 标签、标题/正文/时间；点击标记已读并跳 `/me/<publicCode>`；「全部已读」发送当前所有 key。
- 空态：无报名 → 「还没有报名任何活动」+ `/join`；无通知 → 「暂无通知」。
- 归档卡：显示「已归档」，隐藏公开页链接，赛程/赛果显示「活动已归档」。
- 移动端单列；390px 无横向滚动。
- `/me` 查询使用 `staleTime: 0`；`/join` 的保存/提交与 `/me` 的标记已读都 `invalidate(["my-center"])`，避免状态更新后仍显示旧通知。
  标记已读成功后用响应 `unreadCount` 更新本地计数，列表项乐观置为已读。

### 6.2 `/me/$publicCode`

- 返回 `/me`、活动标题/状态、公开页链接（非归档）。
- 报名：状态、审核备注、提交/更新时间、补充材料 key；仅 `editable: true` 时显示「编辑报名」与补充材料入口。
- 材料：名称、大小、状态、审核备注、下载链接（`contentPath`）。
- 个人赛程：时间、slot、标题、备注；无条目显示「节目单尚未发布或没有你的条目」。
- 我的赛果：阶段、名次、分数/百分比、奖项；无结果显示「赛果尚未发布」。
- 归档：只显示报名与材料，隐藏赛程/赛果/公开页链接。

### 6.3 壳与样式

- `PortalShell` 主导航增加「我的」；未登录点击进入 `/me` 后由 `RequireSession` 跳登录。
- 新增 `styles/me.css`，在 `global.css` 中排在 `portal-event.css` 之后；使用 Afterglow 令牌，不挂 WebGL。
- 组件拆分：`MyEventCard`、`NotificationList`、`MeMaterialList`、`MeSchedule`、`MeResults`。
- `document.title`：`我的 · ArtFlow` / `<活动标题> · 我的`。

## 7. 数据与迁移

- `0032_participant_notification_read.ts`：建表。
- `registration-repository.ts` 增加 `listRegistrationsByParticipant`（join activity，返回 registration + activity + 时间戳）。
- `material-repository.ts` 的 `StoredMaterial` 增加 `createdAt/updatedAt`（读取现有列）。
- `participant-notification-repository.ts`：`listNotificationReadKeys`、`markNotificationKeysRead`。
- 生成 `schema.snapshot.json` 与 `db/src/types.ts`；`schema:check` 必须通过。

## 8. Test architecture

### 8.1 契约与能力

- 不新增 capability；不改变任何命令的生命周期或权限。
- `GET /api/me` 是只读投影；`POST /api/me/notifications/read` 是 actor-scoped UI 偏好写入，不进入 `executeCommand` 的 receipt/audit/outbox 路径，理由见 §4。
- 不扩展 `plus/tools/contracts/src/harness/adapters/`；没有新的 capability adapter。

### 8.2 消费者、读模型、路由、事件、topic

`graph:check` 必须保持零 unresolved：

- 新增路由 `GET /api/me`、`POST /api/me/notifications/read`（Web 调用）；
- 新增表 `participant_notification_read`；
- 新增 Web 路由 `/me`、`/me/$publicCode`；
- 扩展 `registration-repository`（新查询）与 `material-repository`（时间戳）；
- 不新增 outbox 事件、不新增 realtime topic、不新增 command/event。

### 8.3 生命周期边界、终态与 mode 隔离

- 活动：`draft → active → closed → archived`；`/api/me` 可返回 archived 的报名/材料，但 `schedule`/`results` 为空、`event` 链接为 null。
- 报名：`draft/submitted/need_supplement/approved/rejected/withdrawn`；通知 key 含 status+revision。
- 材料：`uploaded/approved/needs_supplement`；只有 approved/needs_supplement 生成通知。
- 赛程：只读 formal active release；最新 release 撤销 → 个人赛程为空。
- 赛果：只读 active、confirmed、未 stale 的 release；撤销/替换 → 我的赛果为空。
- `test`/`rehearsal` 的赛程/赛果永不出现在 `/api/me`；测试用例必须显式覆盖。
- 归档不改变已读状态；已读状态不影响归档/恢复。

### 8.4 适配器

不新增 capability adapter。服务测试使用真实 PostgreSQL 与真实读服务：
`plus/packages/runtime/test/participant-center-service.test.ts`；
仓储查询测试扩展已有的 `plus/packages/db/test/registration-repository.test.ts`。

### 8.5 故障注入与恢复状态

| 故障 | 注入方式 | 断言 |
| --- | --- | --- |
| 跨参与者读取 | 两个 participant actor 各有 registration | A 的 `/api/me` 不含 B 的任何活动/材料/通知 |
| 未知/伪造已读 key | 提交不在当前 feed 的 key | 忽略，不新增已读行，`unreadCount` 不变 |
| 重复标记已读 | 同一 key 提交两次 | 只有一行，read_at 保持首次，`unreadCount` 不二次下降 |
| 最新节目单撤销 | 发布 v1、发布 v2、撤销 v2 | 个人赛程为空；不出现 v1 或 rehearsal 条目 |
| 赛果撤销/替换 | 发布后撤销或 unlock | 我的赛果为空；不返回旧 release |
| 归档活动 | 归档带 registration + material 的活动 | 报名/材料可见；schedule/results 为空；event 链接 null；公告/赛程/赛果通知不生成 |
| 无 profile / 无材料 / 无 release | 只有 registration | 默认空 profile；materials/[]；schedule/results []；不抛 500 |
| 通知状态变化 | approved → need_supplement | 旧 key 消失，新 key 出现；已读行保留但不影响 feed |

不使用任意 sleep；并发用顺序命令构造确定性竞态。

### 8.6 现有测试为什么不够

- 现有 `registration-read.test.ts` 只覆盖按活动读取，不覆盖跨活动聚合、个人赛程/赛果、通知；
- 现有 `registration-loop.spec.ts` 只覆盖提交与审核，不覆盖 `/me`；
- 现有公开读测试不覆盖 actor 过滤与归档只读；
- 现有 graph/gates 没有 `/api/me` 路由与 `participant_notification_read` 表。

### 8.7 防膨胀 / anti-bloat 决定

- 新增一个 `participant-center-service.test.ts`，覆盖聚合、隔离、派生通知、已读；不复制现有报名测试模板。
- 扩展 `registration-loop.spec.ts` 作为 `/me` 的唯一 E2E 旅程，不新建重复的参与者注册流程。
- 通知派生用一个纯函数 `buildMyNotifications(events)`，在 service 测试里直接断言 key/顺序；不为每种 kind 建独立测试文件。
- 已读仓储只测 upsert/忽略未知 key/幂等三条，不做 per-key 矩阵。
- 不引入通知框架、不新增事件投影、不做分页/搜索抽象。

### 8.8 聚焦门禁

```powershell
Set-Location plus
pnpm run check
$env:ARTFLOW_PLUS_DATABASE_URL = "postgresql://artflow:artflow_dev@127.0.0.1:5433/artflow_plus"
$env:REQUIRE_DB = "1"
pnpm run test
pnpm run schema:check
$env:NO_PROXY = "127.0.0.1,localhost,::1"
pnpm --filter @artflow-plus/web test:e2e -- registration-loop.spec.ts a11y.spec.ts
```

仓库级：

```powershell
uv run pytest tests/gates -q
uv run python tests/golden/validate_fixtures.py
pwsh -NoProfile -File scripts/check_docs.ps1
```

## 9. 实施顺序

1. 迁移 0032 + 已读 repository + registration/material 查询扩展 + 测试；
2. `participant-center-service.ts`（聚合、个人赛程/赛果、通知派生、已读）+ runtime 测试；
3. API `routes/me.ts` + `app.ts` 注册 + API 测试；
4. `api/me.ts` + `/me` 页面 + 组件 + CSS + 单测；
5. `/me/$publicCode` 详情页 + 入口 + 单测；
6. E2E 扩展 + a11y + 文档 + 全量门禁。

## 10. 风险与待决

- **派生通知无历史**：状态变化/撤销后旧条目消失；这是刻意取舍。若客户需要审计级通知历史，另开事件投影设计。
- **已读状态无审计**：actor-scoped UI 偏好，非业务事实；若合规要求“谁何时读了什么”，升级为命令并写 audit。
- **个人赛程依赖 `participantId` 匹配**：如果组织者在节目单里没有绑定参与者 ID，个人赛程为空；错误提示为“没有你的条目”，不猜测匹配。分组/团体节目同理，本轮不做分组映射。
- **材料下载权限**：主办方代传的材料（`ownerActorId` 不是参与者）只显示元数据，不提供下载；参与者自己的上传才可下载。若客户需要“参与者可读所有自己的材料”，需扩展 `readMaterialForActor` 的参与者读规则。
- **补充材料 token**：名单定稿后的补交依赖主办方发送的 supplement 链接；`/me` 不持有 token。若要把补交入口收进个人中心，需要新增 token 关联/重发模型。
- **归档活动可见性**：参与者仍能看到自己的报名和材料；如果客户要求归档后完全不可见，改为排除 archived 即可，但会失去个人历史。
