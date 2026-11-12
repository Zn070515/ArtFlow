# ArtFlow-Plus 主办方工作台设计

状态：已确认（2026-11-12）

## 1. 目标

ArtFlow-Plus 已经具备 Studio、Ops、Live、Portal 四个可工作的产品面，但用户进入系统后只能被动地进入某个工具页：登录后的落点由角色决定，活动列表在各个产品面重复出现，用户无法快速判断活动目前处于什么阶段、哪里有待处理事项、下一步应该进入哪个工作区。

本设计新增一个面向活动主办方的体验层，先把现有能力编排成“活动工作台”，不重写任何 capability 的权威规则。第一阶段完成后，主办方可以从一个入口选择活动、查看活动健康状态和进度、定位待处理事项，并直接进入对应的 Studio、Ops、Live 或公开结果入口。

参与者、评委/现场工作人员和最终统一角色入口属于后续三个独立子项目；它们复用本阶段建立的活动上下文、导航和状态呈现约定，不在本规格中实现。

## 2. 方案与边界

### 2.1 选择的方案

采用“体验层编排现有能力”的方案：新增角色化工作台和活动上下文，但优先消费已有 API/read contracts，不新增业务写模型，不把 UI 判断提升为领域权威。

当前阶段不新增聚合 API。工作台按权限和 capability 并行读取已有的：

- `GET /api/activities`：活动摘要列表；
- `GET /api/activities/:id/operations/analytics`：运营汇总和稳定 attention code；
- `GET /api/activities/:id/studio`：Studio 配置、release 和执行会话状态；
- `GET /api/activities/:id/live`：Live 回合、评委席位、表演和排名状态；
- `GET /api/public/results/:publicCode`：公开赛果入口的可用性。

如果实际测量证明这些查询造成不可接受的首屏等待，再单独提出 read-model/facade 规格；本阶段不因为“未来可能需要”预先引入第二套权威事实。

### 2.2 新增路由

- `/workspace`：主办方活动总览。
- `/workspace/$activityId`：单个活动工作台。

`/login` 成功后的主办方默认落点改为 `/workspace`；带有合法 `next` 的深链仍优先回到原目标。现有 `/ops`、`/studio`、`/live` 和公开 Portal 路由保持可直接访问。

### 2.3 非目标

- 不新增数据库表、迁移、事件类型或实时 topic。
- 不复制 Studio/Ops/Live 的命令处理，不在前端绕过 API 权限。
- 不把 analytics attention 变成命令门禁；它只负责提示和导航。
- 不在这一阶段重做参与者报名表、Judge 评分表或 Live 回合控制。
- 不替换 Portal 的 Afterglow 视觉语言；工作台使用现有 Console token 和布局。

## 3. 用户流程

### 3.1 活动总览

主办方登录后看到活动卡片列表，每张卡片包含：

- 活动标题、状态、公开码；
- 已启用 capability 的简短标签；
- 当前活动的待处理数量或“暂无待处理事项”；
- 一个明确的主操作，例如“继续配置”“处理报名”“进入现场”“查看赛果”；
- 次级操作：打开活动工作台、复制公开码、打开公开结果页（仅当公开结果入口可用时）。

列表支持现有 Studio/Ops 的搜索、状态筛选和分页习惯；筛选只改变展示，不改变服务端事实。

空状态按权限分支：有 `studio.manage` 时显示“新建活动”，无创建权限时解释当前账号可访问的工作区并提供返回公开门户入口。活动列表查询失败显示可重试错误，不把空数组误报为服务故障。

### 3.2 活动工作台

活动工作台使用 Console 的“页头 + 主列 + 右栏”骨架：

- 页头：返回活动总览、活动标题、状态、公开码、复制按钮和公开结果入口；
- 主列：按流程顺序展示“配置 → 报名 → 审核/名单 → 现场/评分 → 结果”进度；
- 右栏：当前最值得处理的一项、各产品面的快捷入口和 capability 摘要。

工作台只显示用户有权限或活动已启用的模块。一个模块不可用时显示解释性状态，例如“该活动未启用 Live”或“当前账号没有 Studio 权限”，不显示会导致 403 的死链接。

### 3.3 下一步规则

下一步提示使用已有事实：

- 优先展示 analytics `attention` 中最紧急的稳定 code；
- 若没有 attention，则根据活动状态和 Studio release/session 状态提示配置、发布或进入现场；
- 若活动已有正式公开结果，则主操作转为“查看赛果”；
- 提示是导航建议，不替代服务端命令校验；用户进入目标页面后仍由目标 API 决定是否允许操作。

attention code 到中文文案和目标路由的映射集中放在工作台的纯展示 helper 中，并有独立单元测试，避免在多个页面复制业务状态判断。

## 4. 前端结构

第一阶段预计新增或修改以下文件：

```text
plus/apps/web/src/
├── api/workspace.ts
├── components/workspace/
│   ├── ActivitySwitcher.tsx
│   ├── WorkspaceActivityCard.tsx
│   ├── WorkspaceNextAction.tsx
│   ├── WorkspaceProgress.tsx
│   └── workspaceState.ts
├── routes/
│   ├── workspace.tsx
│   └── workspaceActivity.tsx
├── styles/workspace.css
├── auth/SessionProvider.tsx
├── components/shell/ConsoleShell.tsx
├── router.tsx
└── styles/global.css
```

设计原则：

1. `workspaceState.ts` 只做已读取事实到展示状态的纯映射；不发请求、不调用命令。
2. `ActivitySwitcher` 负责活动上下文切换和当前路由高亮；它不拥有活动数据源，由路由通过 props 注入。
3. 活动卡片和进度组件只消费明确的 DTO，避免直接依赖 `@artflow-plus/runtime` 或数据库类型。
4. `ConsoleShell` 只提供全局导航和当前工作区标识；活动级导航留在工作台页头，防止 shell 变成第二个业务系统。
5. 所有新增交互遵循已有 Console primitive/class 命名；不引入大型 UI 框架，不把 Portal 的 WebGL 资产加载到工作台。

## 5. 数据流与错误处理

活动总览先读取 `/api/activities`。活动工作台在活动摘要确定后并行读取 analytics，并按当前 actor 权限与活动 capability 启用 Studio/Live 查询；公开结果链接不预取完整赛果，只在用户点击后进入既有 Portal 查询。

每个面板独立处理状态：

- 总览请求 pending：展示单一骨架/加载提示；
- 总览请求失败：展示可重试错误态；
- analytics 失败：保留活动身份和快捷入口，显示“运营摘要暂不可用”；
- Studio/Live 没有权限：显示不可用说明，不把 403 当成全页错误；
- 活动 ID 不存在或不在列表中：显示“活动不可用”并提供返回总览；
- mutation 后的过期 revision：目标产品面继续显示既有冲突错误，工作台重新拉取摘要，不静默覆盖状态。

TanStack Query key 使用活动 ID 分片；登录、登出和切换活动时清理或失效工作台查询，避免跨账号或跨活动残留。

## 6. 可访问性与响应式

- 工作台主标题使用 Console H1 级别，不使用 Portal display 标题。
- 每个状态不仅用颜色表达，还包含文字和可识别的 badge/图标。
- 卡片主操作和活动切换目标最小 40px，键盘焦点始终可见。
- 桌面端使用主列 + 右栏；`<1024px` 右栏落到主列下方；`<768px` 活动切换改为可展开的单列控件。
- 页面事实全部存在于 DOM；不依赖动画或 Canvas 传达状态。

## 7. 后续子项目接口约定

本阶段只建立约定，不实现后续功能：

- 参与者阶段将增加“我的活动/我的报名”专用只读查询，不复用运营活动列表权限；工作台活动上下文格式保持一致。
- 评委/现场阶段继续使用活动 ID 和公开码作为上下文，Judge 入口 token 只由既有 capability 入口产生，工作台不读取或展示 token。
- 统一入口阶段再决定 `/` 是否按会话显示角色首页；公开访客仍保留赛果公开码入口，避免破坏分享链接。

## 8. Test architecture

### Contracts and capabilities

本阶段扩展现有 Web 消费，不新增共享 contract。触及的能力是 activity、registration/operations analytics、studio、competition/live、publishing 的现有只读表面；它们继续由各自 runtime service 提供事实。没有新增 capability descriptor、command 或事件。

### Consumers, read models, routes, events and topics

新增 Web 消费者为 `/workspace` 和 `/workspace/$activityId`，并修改登录默认落点与 Console 活动导航。已有消费者包括 `/studio`、`/ops`、`/live` 和 `/results/:publicCode`。本阶段不新增 read model、API route、event 或 realtime topic；`graph:check` 必须确认新路由消费的既有端点均可发现，且没有 unresolved edge。

### Lifecycle, terminal guards and mode isolation

工作台不发出生命周期命令，因此不增加 lifecycle edge 或 terminal guard。Studio 的 draft/active/closed/archived、registration 的 submitted/approved/need_supplement、competition 的 round/performance 状态和 publishing 的 formal release 只作为只读事实展示。`test`、`rehearsal`、`formal` 仍由既有 DTO 区分，工作台不得合并统计或把排练状态呈现为正式赛果。

### Adapters and integration seam

不新增 contract adapter。集成验证复用现有真实 PostgreSQL/API 路径与已有 capability adapters；Web 单元测试在 `apiFetch` 边界注入 DTO，避免把 adapter 复制成第二套业务实现。必要的浏览器 journey 通过真实 API 和 `artflow_e2e` schema 验证完整导航。

### Fault injection and recovery assertions

至少覆盖以下故障：

1. 活动列表 API 失败后点击重试，最终恢复到可筛选的活动列表。
2. analytics API 失败，活动身份和入口仍可用；恢复后 attention/进度重新出现。
3. Studio/Live 读权限不足，工作台保持可用并显示权限说明；切换到有权限账号后重新出现入口。
4. 活动详情读取到过期或不存在的 activity ID，返回总览后不残留旧活动数据。
5. 账号切换/退出后，上一账号的活动与 attention 不出现在新会话。
6. 实时不可用不影响工作台；工作台只依赖 HTTP 读取，恢复后由目标 Live 页面负责刷新。

每个故障都要断言故障期间的可见状态和恢复后的最终状态，不使用任意 sleep。

### Why existing tests are insufficient

现有测试分别验证 Studio、Ops、Live 和 Portal 页面能加载，但没有验证跨产品面的活动上下文、默认落点、下一步提示、权限降级和账号切换隔离。因此单个页面全绿仍可能让用户进入错误工具或丢失上下文。

### Anti-bloat decision

本阶段扩展现有 `ConsoleShell`、活动列表查询、analytics attention 和产品面入口，不新建聚合表、流程引擎、通用 wizard 或每个 capability 一份测试模板。下一步映射只保留一个纯 helper；卡片测试覆盖状态分支，不为每个活动类型复制一套组件。

### Focused gates and proof

实现阶段至少运行：工作台 helper/component/route focused Vitest、`pnpm -C plus/apps/web run check`、`pnpm -C plus/apps/web run build`、Consumer Graph `graph:check`、相关 Web E2E journey，以及在 PostgreSQL 可用时的 Plus integration tests。证明标准是：跨页面导航、权限/空态/错误态、账号隔离和已有核心页面回归均有可执行通过证据，而不是只看截图或组件数量。

## 9. 完成定义

第一阶段完成必须满足：

1. 主办方登录后能从 `/workspace` 选择活动并进入活动工作台。
2. 工作台能展示至少活动身份、当前状态、能力摘要、待处理事项和下一步入口。
3. 入口按权限和 capability 正确隐藏或解释，不产生可预见的 403 死链。
4. Studio/Ops/Live/公开结果仍由各自既有页面和 API 负责权威行为。
5. 列表、详情、空态、错误态、权限态、账号切换和小屏布局有测试证据。
6. 无新迁移、无未声明 route/event/topic consumer、无未定义 CSS class。

