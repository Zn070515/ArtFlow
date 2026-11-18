# 公开活动发现与传播设计（Phase 3）

状态：实施中（2026-11-18）
范围：`/events` 公开活动目录、搜索、分享元信息、日历订阅
前序：`docs/artflow-plus/specs/2026-11-18-public-content-blocks-design.md`

## 1. 目标

让不知道公开码的人也能找到活动：主办方选择把活动列入公开目录，公众在 `/events`
浏览与搜索，进入 `/e/$publicCode`；同时提供分享用的 OG/摘要元信息与 `.ics` 日历下载。

## 2. 非目标

- 不做服务端渲染或爬虫专用 HTML；OG 标签在浏览器端设置，不承诺爬虫抓取。
- 不做公开写入口、报名或购票；目录只读。
- 不做活动推荐、排序算法或分页（先限 100 条，客户端搜索）。
- 不新增独立活动详情页；详情仍是 `/e/$publicCode`。

## 3. 决策

### 3.1 目录是 opt-in

`activity_public_profile` 增加 `listed_publicly` boolean，默认 false。只有
`active`/`closed` 且该字段为 true 的活动出现在目录。公开码本身仍是定位符，
不是授权凭证；目录不改变任何访问权限。

### 3.2 列表读模型

新增 `GET /api/public/events`（与现有 `/api/public/events/:publicCode` 并存）：

```text
[{ publicCode, title, tagline, venue, startsAt, endsAt, organizer }]
```

只返回活动状态 active/closed、profile 存在且 `listed_publicly = true` 的行；
按 `starts_at` 倒序、空值靠后，最多 100 条。不返回报名人数、材料、内部 id 或联系方式。

### 3.3 搜索在客户端

`/events` 页加载一次列表，按标题/标语/地点/主办方做大小写不敏感过滤；不引入
服务端搜索索引。空结果有明确空态。

### 3.4 分享元信息在浏览器端

`/e/$publicCode` 在数据加载后设置 `og:title`、`og:description`、`og:type`、
`og:url`、`twitter:card` 与 canonical。已知限制：不执行 JS 的爬虫看不到这些标签；
需要爬虫级分享卡时，后续再加服务端渲染或分享专用 HTML，不在本轮范围。

### 3.5 日历在浏览器端生成

`buildCalendarEvent(site)` 纯函数生成 RFC 5545 `.ics`：UID 用公开码，DTSTART/DTEND
取 profile 的 `startsAt`/`endsAt`（缺失则不显示下载入口），SUMMARY 用活动标题，
DESCRIPTION 用标语/介绍截断，LOCATION 用地点，URL 用公开活动页。下载通过 Blob，
不经过服务端。

## 4. 生命周期与可见性

- `draft`/`archived` 不进入目录，详情继续 404。
- `listed_publicly` 关闭后，下一次目录查询即移除；没有缓存或索引需要失效。
- 目录只读；活动关闭后仍可出现（作为历史活动），由 `listed_publicly` 控制。
- `startsAt`/`endsAt` 仍由公开资料命令校验；日历只在两者可解析时生成。
- 分享元信息跟随活动站查询；活动下线后页面回到 404，元信息不再更新。

## Test architecture

契约：复用公开活动站读模型与公开资料命令，仅扩展 profile 字段与一个只读列表接口；
不新增共享 TypeBox 文件。消费者：`/events` 页、公开活动站、Studio 公开资料编辑器、
`PublicEventSite` 与新的公开活动摘要读模型。生命周期：只列 active/closed 且
`listed_publicly` 的活动，draft/archived 不出现；关闭目录开关后立即不可见；日历只在
时间可解析时生成。适配器：无新增；列表与详情使用真实 PostgreSQL，页面用可控 fetch
组件测试。故障：列表为空显示空态；搜索无结果显示空态；时间缺失不渲染日历入口；
坏 URL/HTML 不进入元信息与日历。现有测试不够：没有目录、搜索、OG 与 ICS 的覆盖。
防臃肿：复用 profile 表与命令，不新增表、事件或页面路由以外的业务能力；目录页与
ICS 生成器各一个文件，搜索为纯函数。门禁：`check`、db/runtime/api/web 测试、
`schema:check`、`graph:check`、`audit:check`、`build:prod`、结构门禁、`check_docs`、
Playwright 的 discovery/public-event/mobile。

## 5. 实施顺序

1. 迁移 0034 + schema snapshot/types。
2. DB repository 字段与列表查询。
3. runtime 校验、列表读模型、ICS 纯函数。
4. API 列表路由与 body schema。
5. Studio 开关、`/events` 页、公开站元信息与日历按钮。
6. 测试与门禁。
