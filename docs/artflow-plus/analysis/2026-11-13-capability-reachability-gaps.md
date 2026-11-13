# 能力与用户可达性缺口审计（2026-11-13）

## 0. 结论

底层能力本身没有“孤儿命令”：78 条 command 全部至少有一条 HTTP route
（`commandsWithoutRoute = 0`），Starter Pack 的 readiness 诊断也是 0 finding。
缺口集中在**能力存在、但普通用户/组织者没有页面入口**：

- `graph` 报告 18 条无 Web 消费者的 mutation route；逐条人工核对后，
  **17 条是真实缺口**，1 条是重复路由（`competition/rounds/:roundKey/prepare`）。
- 另有 3 条“路由可达、参数不可达”（同一 `/scores` 路由只允许 UI 传
  `direct_judge`，纸面/代录/快速评分三种 source 无法选择）。
- 1 条死命令：`competition.performance.advance` 声明并实现，但没有 route、
  没有调用方。
- 2 条读路径有数据但没有页面：归档包状态/下载、事件与执行状态只读诊断。
- 公开结果页与 Live 表格仍直接显示 `contestantId`，而报名/Live 选择器已经投影
  了姓名；这是 #57 的残留部分。

## 1. 复现方式

```powershell
pnpm -C plus --filter @artflow-plus/contract-tools run graph
pnpm -C plus --filter @artflow-plus/contract-tools run readiness
```

输出：

- `plus/.artifacts/consumer-graph.json`：capability、command、route 与消费者边；
- `plus/.artifacts/ui-gaps.json`：未被 Web 调用的 mutation 入口；
- `plus/.artifacts/pack-readiness.json`：Starter Pack 的联动诊断。

命令级可达性由“route → serves symbol → calls* → invokes-command”反向计算，
再用 `apps/web/src/api/**` 的 wrapper、页面 `<a href>` 和动态 route 模板人工复核。

## 2. 能力矩阵

| 能力 | command | 静态无 UI | 核对后的真实缺口 |
| --- | ---: | ---: | --- |
| archive | 2 | 0 | 读路径缺 UI：归档包列表/下载 |
| attendance | 6 | 2 | 签到点、工作人员的改名/停用 |
| competition | 20 | 11 | 6 个真实操作 + 3 个参数级缺口 + 1 条死命令 + 1 条误报 |
| grouping | 7 | 0 | `roundSource` 只允许 `all_approved`，`round_advanced` 不可达 |
| materials | 3 | 1 | 单文件审核没有页面（报名级审核已有） |
| publishing | 6 | 3 | 解锁赛段结果、撤销发布、编辑 publication |
| registration | 8 | 2 | 补交授权 + 公开补交流程没有页面 |
| tasks | 6 | 5 | 误报：动态路由 `/tasks/:taskId/:action` 扫描不到 |
| ticketing | 8 | 4 | 票据发放、撤销、轮换、会话撤销全无页面 |
| voting | 3 | 0 | 无缺口 |

## 3. 已确认的产品缺口

### P1：异常/补录路径走不通

1. **票据生命周期（ticketing）**
   - 后端：`POST /api/activities/:id/tickets`、`/tickets/:ticketId/rotate`、
     `/tickets/:ticketId/revoke`、`/ticket-sessions/:sessionId/revoke`。
   - Web：只有公开核销 `POST /api/tickets/redeem`；`apps/web/src/api/voting.ts`
     没有发放/轮换/撤销 wrapper。
   - 后果：singer pack 默认启用 ticketing，评委入口可以生成，但组织者无法在
     Console 发放入场票据；`vote-page.spec.ts` 只能用 `page.request` 直接调 API。
     该缺口在 `plans/2026-10-27-participant-vote-page.md:1034` 被记录为
     “Ticket-policy sessions stay blocked until a ticket UI exists”，属于已登记
     的待办，不是意外。

2. **竞赛异常路径（competition）**
   - 无 UI 的 6 个操作：
     - `PATCH .../scores/:scoreFactId`（编辑既有评分）
     - `POST .../scores/:scoreFactId/corrections`（开修正）
     - `POST .../corrections/:correctionId/close`（关修正）
     - `POST .../corrections/:correctionId/recalculate`（重算）
     - `POST .../ties/:tieId/decide`（平局裁决）
     - `POST .../advancement/finalize`（晋级定稿）
   - Web 只暴露 `reopen-for-correction` 和 `resolve`。组织者可以把轮次重开，
     但后续的修正、重算、平局裁决、晋级定稿都只能调 API，形成“重开之后没有下一步”
     的死角。
   - `advancement/finalize` 还影响 grouping：`createGroupingStage` 支持
     `rosterSource: "round_advanced"`，但 Web 硬编码 `all_approved`；没有晋级
     定稿，按晋级名单分组的路径在 UI 上不可用。

3. **发布撤回（publishing）**
   - 无 UI：`POST .../stage-results/:stageKey/unlock`、
     `POST .../releases/:releaseId/revoke`、`PATCH .../publications/:stageKey`。
   - Web 有 `confirm`、`release`、`recompute`，但没有撤回。结果一旦发布，
     Console 上无法撤销或修正，只能直接操作 API。

4. **补交流程（registration）**
   - 无 UI：`POST .../registrations/:registrationId/supplement`（细粒度补交授权），
     以及公开补交的 `POST /api/public/supplement/claim`、
     `GET /api/public/supplement/context`、`PUT .../materials/:questionKey/content`、
     `POST /api/public/supplement/submit`。
   - Web 只有报名审核里的 `need_supplement` 状态；登录用户可重新编辑全部答案，
     但“只开放指定字段”和“无需登录的补交链接”两条产品路径不可达。

### P2：运营完整性与可辨认性

5. **签到点/工作人员编辑**：只能创建，不能改名或停用
   （`attendance.point.update`、`attendance.staff.update`）。
6. **单文件审核**：`materials.review` 两个 route 无 UI；报名级审核可以覆盖大部分
   场景，但按文件批准/退回不可达。
7. **归档包读取**：`GET /api/activities/:id/archive` 与 `/archive/file` 无 UI。
   `specs/2026-10-26-m8a-web-portal-design.md:6` 把“归档下载”列为非目标，属于
   已登记的 deferred，但运营上仍无法从 Console 取回归档包。
8. **只读诊断**：`GET /api/activities/:id/events`、
   `/execution-state`、`/api/operations/outbox` 无页面；事故时只能查 API/日志。
9. **公开结果仍显示内部 ID**：`ResultsView` 的 `rank-contestant` 与
   `award-owner` 直接渲染 `contestantId`；Live 表格的“选手”列同理。
   报名与 Live 选择器已有 `participantNames` 投影，说明数据可用，只是结果页
   没有用它。`Read-model display contract`（2026-11-11 分析 #57）只修复了一部分。

## 4. 并非产品缺口的部分

- **`POST .../competition/rounds/:roundKey/prepare`**：与 Web 使用的
  `POST .../competition/rounds` 是同一命令的重复入口，应像
  `/rounds/:roundKey/prepare` 一样在 `api-only.json` 声明，而不是新增 UI。
- **`tasks.*` 的 5 条命令**：route 通过
  `/tasks/:taskId/${action}` 动态注册，Consumer Graph 的静态扫描看不到模板
  展开；`TasksCard` 实际可达。
- **`GET .../materials/:materialId/content`、`GET .../exports/:kind`**：
  页面用 `<a href>` 下载，`ui.ts` 只扫描 `apiFetch/fetch`，属于扫描盲区。
- **`POST /api/activities/:id/runtime-facts`**：测试/运维 seam，生产默认关闭。
- **healthz/readyz/openapi/capabilities/outbox**：基础设施或只读诊断接口。

## 5. 图扫描本身的盲区

当前 `extractWebCalls` 只识别 `apiFetch(...)` / `fetch(...)` 的首参字面量，
建议补两类，否则每次审计都要人工复核：

1. 页面 `<a href="/api/...">` 下载与跳转（至少 materials content、exports）；
2. `app.get/post(\`/api/.../${action}\`)` 这类动态 route 模板的展开（tasks）。

这两类不修，`ui-gaps.json` 会持续把“可达”报成“不可达”，降低报告的可信度。

## 6. 建议修复顺序

1. **先补异常路径的 UI 入口**：publishing 的 unlock/revoke、competition 的修正/
   平局/晋级、attendance 的编辑。它们对应“现场出错后无法收场”的风险。
2. **票据 UI 单独开 slice**：发放、轮换、撤销、会话撤销四个动作，配套
   `vote-page` 的票据 journey。
3. **补交公开流程**：要么补页面，要么在文档里明确“只支持登录用户补交”。
4. **结果与 Live 表格投影姓名**：先把 `participantNames` 用到结果页表格与
   Live 排名表，再做公开结果的 read-model contract。
5. **归档与诊断页面**：按运营需要排期；若不做，保持非目标记录。
6. **收紧报告**：修完一类后把对应的 `ui-gaps` 类别接成失败门禁，避免回退。

## 7. 2026-11-14 闭环更新

本轮已消除以下条目，`ui-gaps.json` 的 `uiGaps` 已降为 0：

- **票据生命周期**：新增 Ops `TicketsCard`（签发/轮换/撤销票据、撤销会话），配套只读
  `GET /api/activities/:id/ticketing/state`；`gap-baseline.json` 的 10 条 `ui-route`
  豁免全部移除。
- **签到编辑**：`AttendanceCard` 支持签到点与工作人员的改名/停用。
- **材料审核**：新增 `MaterialsReviewPanel`，按文件批准或退回。
- **补交**：新增 `/supplement?token=…` 公开补交页（领取、上传、提交），以及
  Ops `SupplementPanel` 的细粒度授权与一次性补交链接展示。
- **发布编辑**：Live `PublicationEditor` 接入 `PATCH .../publications/:stageKey`。
- **归档与诊断**：Ops 新增 `ArchiveCard`（版本化下载）与 `DiagnosticsCard`
  （outbox 健康度、投影 stale/blocked、最近事件）。
- **重复路由**：`POST .../competition/rounds` 已声明为 API-only；Web 改用
  `POST .../competition/rounds/:roundKey/prepare`。

仍然开放（未在本轮处理）：

- `competition.performance.advance` 仍无 HTTP route / UI；
- `/scores` 只允许 `direct_judge`，纸面、代录、快速评分三种 source 仍不可达；
- grouping 的 `rosterSource: "round_advanced"` 仍不可选；
- 图扫描对 `<a href>` 下载与动态 route 模板的盲区未修。
