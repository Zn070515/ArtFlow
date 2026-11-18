# 公开活动站内容块设计（Phase 2）

状态：实施中（2026-11-18）
范围：`/e/$publicCode` 的内容深化：公告历史、FAQ、公开链接、可选参与者目录
前序：`docs/artflow-plus/specs/2026-11-18-onsite-audience-companion-design.md`

## 1. 目标

让公开活动站不再只有"介绍 + 节目单 + 赛果"三块，而是能承载活动前后的
说明性内容：多条公告、常见问题、外部链接/文档，以及由主办方选择公开的参与者目录。

## 2. 非目标

- 不做文件上传/相册；公开文档以外部链接（http/https）承载。
- 不做独立页面路由；全部内容块挂在现有 `/e/$publicCode`。
- 不新增命令、权限、事件或迁移以外的能力。
- 不改变现有单条 `announcement` 的语义：它仍是置顶现场公告。

## 3. 决策

### 3.1 内容块属于活动公开资料

公告历史、FAQ、链接与"是否公开参与者"是活动元数据，不是 capability。
它们跟随 `activity_public_profile` 的 revision / 审计 / 权限，复用
`activity.public_profile.update` 命令与 `studio.manage` 权限。

### 3.2 数据形状

`activity_public_profile` 增加四列：

| 列 | 形状 | 限制 |
| --- | --- | --- |
| `announcements` | `[{ id, title, body, publishedAt }]` | ≤20 条；title ≤120；body ≤1000；publishedAt ISO |
| `faq` | `[{ question, answer }]` | ≤20 条；question ≤200；answer ≤1000 |
| `links` | `[{ label, url }]` | ≤10 条；label ≤80；url 仅 http/https，≤500 |
| `participants_visible` | boolean，默认 false | 关闭时不返回参与者目录 |

旧行默认空数组/false；读取时对损坏 JSON 回退为空，不抛错。

### 3.3 参与者目录

`participantsVisible` 为 true 时，公开站额外返回该活动 `approved` 报名者的
姓名与曲目（复用现有 `participantName` / `programAnswer` 解析）。只返回姓名与
节目信息，不返回联系方式、学号或其他答案。活动 `active`/`closed` 才返回；
`draft`/`archived` 继续 404。

### 3.4 展示

- 置顶公告（`announcement`）保持不变；公告历史按 `publishedAt` 倒序显示在下方。
- FAQ 用原生 `<details>`，默认折叠。
- 链接以外部 `<a rel="noreferrer noopener">` 打开；只接受 http/https。
- 参与者目录以姓名 + 曲目列表展示；无内容时整块隐藏。
- 所有文本按纯文本渲染（React 转义），不解释 HTML。

## 4. 生命周期与可见性

- 活动 `draft`/`archived`：公开站 404，内容块不返回。
- 活动 `active`/`closed`：返回内容块；`participantsVisible` 只在 `approved` 报名者上生效。
- 公开资料更新仍要求活动非 archived，写审计，revision CAS；并发保存失败返回冲突。
- 公告历史是主办方发布的内容，不是实时通知；实时置顶公告仍走现有 `announcement`。
- 链接 URL 在写入时校验；读取时再次过滤非 http/https，防止历史脏数据。

## 5. 接口

- `POST /api/activities/:id/public-profile` 请求体增加四个字段；响应
  `StudioPublicProfile` 增加同样字段。
- `GET /api/public/events/:publicCode` 响应增加：
  - `profile.announcements`、`profile.faq`、`profile.links`
  - `participants: [{ name, program }] | null`（`participantsVisible` 为 false 时为 null）
- 不新增路由。

## Test architecture

契约：复用现有公开资料命令与公开活动站读模型；本轮不新增共享 TypeBox 契约文件，
只在 API body schema 与 web 类型中扩展字段。消费者：Studio 公开资料编辑器、
公开活动站、公开活动站读模型 `PublicEventSite`；不新增 route/event edge。
生命周期：覆盖 active/closed 返回内容、draft/archived 404、participantsVisible 开关、
仅 approved 报名者、revision 冲突与 archived 写入拒绝、mode 无关（公开资料不分 mode）。
适配器：无新增；公开读使用真实 PostgreSQL，编辑器用组件测试与可控保存。故障：坏 JSON
回退为空、非 http/https 链接被丢弃、保存校验失败不落库、并发 revision 冲突不覆盖。
现有测试不够：现有测试只覆盖单条公告与基础资料，没有数组校验、参与者可见性、FAQ/
链接渲染与编辑器增删行。防臃肿：复用 profile 表与命令，不新增表、路由、事件或页面；
编辑器新增一个可复用重复行组件，公开页新增一个内容块组件。门禁：`check`、web/api/db
测试、`schema:check`、`graph:check`、`audit:check`、`build:prod`、结构门禁、
`check_docs`、Playwright 的 public-event/onsite-audience/mobile。

## 6. 实施顺序

1. 迁移 0033 + schema snapshot/types。
2. DB repository 字段读写。
3. runtime 校验与公开站读模型（含参与者）。
4. API body schema 与 Studio/web 类型。
5. Studio 编辑器（重复行组件）。
6. 公开站内容块组件与页面接线。
7. 单元/组件/API/E2E 测试与门禁。
