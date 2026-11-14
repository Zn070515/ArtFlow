# ArtFlow-Plus M8c：Studio 设计

状态：已确认（2026-10-26）
范围：Studio 活动创建（Guided Pack）、定义草稿/编译/发布（Expert JSON）、执行
会话 test/rehearsal/formal start/close。
非目标：Live 现场操作、Ops 报名（M8b 已完成）、数据导入/cutover（M8e）。

## 权限与 actor

- 新增权限 `studio.manage`；Studio 的所有 mutation 与状态读取都要求它。
- 修复现有 engine mutation 路由：`POST /api/activities`、`activate`、
  `definitions/compile`、`definitions/release`、`executions`、
  `executions/:id/close` 改为 `requestDeps` + `requirePermission("studio.manage")`，
  不再使用 base/system deps。
- `GET /api/activities` 列表允许 `studio.manage` 或 Ops 的
  `registration.review`/`manage`。
- `GET /api/activities/:id/studio` 新增，要求 `studio.manage`。
- 现有 API 测试改为注入 studio actor 或用 studio bearer token；E2E 管理员增加
  `studio.manage`。

## Studio 状态 DTO

```ts
{
  activity: { id, publicCode, title, status, revision, enabledCapabilities, activeDefinitionVersion },
  draft: { revision, package } | null,
  compiled: { draftRevision, contentHash, capabilities: string[] } | null,
  releases: [{
    version, contentHash, releasedAt, sourceDraftRevision,
    declaredScopes, capabilityVersions, active
  }],
  sessions: [{ id, scope, mode, status, revision, openedAt, closedAt? }]
}
```

- `compiled` 只代表当前 draft revision 的编译结果；旧编译不返回。
- `releases` 只返回 Studio 需要的元数据；不返回完整 compiled artifact。
- 会话按 openedAt 排序。

## Studio 页面

- `/studio`：活动列表 + “新建活动”；`studio.manage` 才显示入口。
- `/studio/new`：
  - 标题、Pack 选择、Guided 问题 checkbox、capability enable/disable；
  - 调 `POST /api/packs/:id/instantiate` 预览 enabled capabilities + definition；
  - 创建 `POST /api/activities`（packId + answers + title），成功后跳工作区。
- `/studio/:activityId`：
  - 状态卡：activity status/revision、enabled capabilities；
  - draft 面板：revision、Expert JSON 编辑器（完整 Package），compile；
    编译诊断逐条显示；
  - release 面板：当前 active version、历史 release、release 按钮
    （需要 active activity + compiled draft）；
  - session 面板：从 active release 的 `declaredScopes` 选择 scope + mode
    (test/rehearsal/formal) 启动；列出会话并可 close；
  - Guided 摘要：Pack/capability 列表与 draft manifest，不是第二个编辑器。
- 视觉复用 Afterglow shell；编辑区用等宽字体、深色面板；JSON 解析错误在客户端
  提示，服务端诊断原样展示。

## 测试

- API：studio state 权限/形状；无 studio.manage 的 mutation 403；有权限的
  create→activate→compile→release→start→close；现有测试更新。
- Web 单元：JSON 解析/诊断、Pack 预览、权限导航。
- E2E：Studio 管理员登录 → 新建活动（Singer Pack 默认）→ 激活 → 编译 →
  发布 → 启动 rehearsal session → 关闭；断言 release active 与 session closed。
- 全量门禁 + 两个 CI job。

## 数据/部署

- 无新迁移；复用 definition_draft/definition_released/execution_session。
- `studio.manage` 是 actor permission；生产账号需显式授予。
- 现有无鉴权的 engine mutation 缺口在本 slice 关闭。
