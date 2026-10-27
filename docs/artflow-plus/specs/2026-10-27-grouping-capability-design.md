# ArtFlow-Plus：grouping capability（分组/合唱赛段）

状态：已确认（2026-10-27）
范围：新 `grouping` capability（分组事实、四态生命周期、修正历史、名单来源、
材料窗口状态）、Ops API 与傻瓜式三屏页面、归档阻塞、v1 分组导入。
非目标：组级材料文件/字节、组材料问卷核验、评分节目联动、节目单公开页、
参与者账号认领、bracket/对阵。

## 背景

v1 的 `GroupStage`（`singer_contest/models.py:536`、`singer_contest/group_chorus.py`）
是歌手赛第一轮的分组合唱赛段：分组由外部抽签产生，赛段自己拥有名单来源、材料窗口
和冻结快照。v2 目前完全没有对应物，`export_plus_bundle` 把分组合唱赛段标为
`unsupported`（`common/management/commands/export_plus_bundle.py:143`），
`docs/artflow-plus/shape-validation.md` 也把它列为明确缺口。

本轮把它做成独立 capability，而不是塞进 `competition` 或 `registration`：

- 分组发生在报名截止之后、甚至现场；它与报名的生命周期不同。
- 分组可以在没有比赛的活动里存在；它与比赛轮次的生命周期也不同。
- 独立 capability 让「按组合装配」的架构保持成立。

## 决策

- **D1 组数校验（已定）**：聚合的确认/冻结对照当前 release 的
  `grouping.artifact.groupCount` 校验；未声明则不限制。v1 把这件事放在消费方
  （2026 赛制绑定/准备轮次），v2 的 release 就是冻结赛制，因此提前到确认/冻结。
- **D2 消费边界（已定）**：活动内只要存在任何已确认的 `stage_result`，就拒绝
  `grouping.stage.correct`（`GROUPING_CONSUMED`）。v1 的精确引用（冻结赛制绑定、
  已确认 StageResult 读取）在 v2 没有等价引用，因此采用更保守的活动级边界。
- **D3 材料窗口深度（已定）**：本 slice 只做窗口状态机；「当前成员才能写」
  「补交限定」「伴奏/视频契约」留给媒体 slice。窗口现在是**操作性状态**，
  不代表任何文件已到位。
- **后端严格、前端傻瓜（已定）**：所有不变量只在后端强制；Ops 页面只暴露
  「分组 → 确认 → 冻结」三步，修正/取消/窗口收进「更多操作」，错误码映射成人话。
- **成员唯一性收紧（已定）**：v1 的数据库约束只有 `(group, singer)`，跨组重复靠
  完整性校验拦截；v2 增加 `(stage_id, participant_id) WHERE is_current` 部分唯一
  索引，作为最后一道防线。可接受输入不变。
- **名单来源必须已确定（已定）**：`all_approved` 要求 roster 已 final；
  `round_advanced` 要求来源轮次的最新 advancement decision 状态为 `auto`
  （`needs_review` 表示同分跨切点、尚未决出）。这比 v1 对 `all_approved` 的隐式
  顺序要求更严格，符合 LIFE-07 fail closed。
- **活动类型不设限（已定）**：v1 只允许歌手比赛；v2 由 capability 组合决定。
- **不做 ruleset 草稿机件（已定）**：v1 的 `managed_by` / `replaces_group_stage` /
  `expected_group_stage_binding_revision` 服务于可编辑赛制草稿；v2 release 不可变，
  改分组走 correction，换一套分组走 cancel + 新 stageKey。

## 领域模型

每活动可有多个赛段，用 `stageKey` 区分（与 v1 一致）。

### GroupingStage

| 字段 | 说明 |
|---|---|
| `id` | 命令派生 id |
| `activityId` | 所属活动 |
| `stageKey` | 活动内唯一；非空 |
| `name` | 非空 |
| `status` | `draft` / `confirmed` / `frozen` / `cancelled` |
| `rosterSource` | `all_approved` / `round_advanced`；创建后不可变 |
| `sourceRoundId` | 仅 `round_advanced` 必填，必须属于当前活动 |
| `sourceFingerprint` | 确认/冻结时写入的来源名单指纹 |
| `materialWindow` | `closed`（默认）/ `open` / `supplement_only` |
| `revision` | OCC |
| `confirmedAt/By`、`frozenAt/By`、`cancelledAt/By`、`cancelReason` | 生命周期事实 |

### GroupingGroup

| 字段 | 说明 |
|---|---|
| `id` | 命令派生 id |
| `stageId` | 所属赛段 |
| `groupOrder` | 从 1 开始 |
| `name` | 缺省「第 N 组」 |
| `isActive` | 修正后保留旧组为历史 |

约束：active 组 `(stage_id, group_order)` 与 `(stage_id, name)` 唯一。

### GroupingMembership

| 字段 | 说明 |
|---|---|
| `id` | 命令派生 id |
| `stageId` | 冗余列，供部分唯一索引使用 |
| `groupId` | 所属组 |
| `participantId` | 报名参与者 |
| `isCurrent` | 当前成员 |
| `joinedAt` / `leftAt` | 加入/离开时间 |
| `removedBy` | 修正操作人 |
| `reason` | 修正原因 |

只追加：修正时关闭旧行、写新行，历史不删除。
约束：`(stage_id, participant_id) WHERE is_current` 唯一。

## 不变量

| 编号 | 规则 |
|---|---|
| GRP-01 | 同一赛段内，一名选手最多一条 current 成员关系（数据库部分唯一索引强制） |
| GRP-02 | 确认必须完整覆盖来源名单；冻结重新解析来源并比对 `sourceFingerprint`，不一致拒绝 |
| GRP-03 | 已冻结赛段不可取消；已确认/已冻结可修正，必须带原因且只追加历史 |
| GRP-04 | 未冻结且未取消的赛段阻止归档 |
| GRP-05 | 来源名单未知时 fail closed：roster 未 final / advancement 非 `auto` 都拒绝确认 |
| GRP-06 | 材料窗口只在 confirmed/frozen 可设；取消时自动关闭；同值设置是 no-op |
| GRP-07 | 组数由 release 的 `groupCount` 约束（声明了才检查）；每组人数自由 |
| GRP-08 | `rosterSource` 创建后不可变 |
| GRP-09 | 存在已确认 `stage_result` 时拒绝修正（D2） |

## 命令与查询

| 命令 | 输入要点 | 规则 |
|---|---|---|
| `grouping.stage.create` | `stageKey`、`name`、`rosterSource`、`sourceRoundId?` | 活动 ACTIVE、capability 已启用；stageKey 唯一；round_advanced 必须指定同活动轮次 |
| `grouping.groups.record` | `stageId`、`expectedRevision`、`groups[{name?, participantIds[]}]` | 仅 draft；整体替换组与成员；组非空、名称唯一、成员在来源名单内、一人一组 |
| `grouping.stage.confirm` | `stageId`、`expectedRevision` | draft→confirmed；完整覆盖；来源已确定；组数校验；写指纹 |
| `grouping.stage.freeze` | `stageId`、`expectedRevision` | confirmed→frozen；重算指纹并比对；组数校验 |
| `grouping.stage.correct` | `stageId`、`expectedRevision`、`groups[]`、`reason` | confirmed/frozen；原因必填；完整覆盖；组数校验；追加历史；D2 消费保护 |
| `grouping.stage.cancel` | `stageId`、`expectedRevision`、`reason` | draft/confirmed；已取消幂等；关闭材料窗口；frozen 拒绝 |
| `grouping.window.set` | `stageId`、`expectedRevision`、`window`、`note?` | confirmed/frozen；同值 no-op |
| `grouping.describe`（query） | `activityId` | 赛段 + 组 + 当前成员 + 就绪标志 + release 的 `groupCount` 对照 + 参与者显示名 |

**来源解析**：

- `all_approved`：`getRoster` 必须 `final`；参与者集合 = 当前 approved 报名。
- `round_advanced`：读取来源轮次的最新 advancement decision；`status` 必须为
  `auto`；参与者集合 = `decisions` 中 `advanced: true` 的 contestantId。
- 指纹：`all_approved` = hash(roster revision, finalizedAt, 排序后的参与者 id)；
  `round_advanced` = hash(roundId, decision id, decision revision,
  inputFingerprint, 排序后的晋级 id)。

**显示名**：`grouping.describe` 为每个成员返回 `displayName`——取报名答案里
key 为 `name` 的文本值；没有则用本地账号 `username`。不新增身份概念。

## 事件

`GroupingStageCreated`、`GroupingGroupsRecorded`、`GroupingStageConfirmed`、
`GroupingStageFrozen`、`GroupingStageCorrected`、`GroupingStageCancelled`、
`GroupingMaterialWindowChanged`。

全部经 `appendEngineEvent` 写入 outbox；事件不进 Live 投影（本 slice 无实时 UI）。

## capability 契约

```text
identity: grouping
version: 1
definitionSchemaVersion: 1
dependencies: [registration, competition]
conflicts: []
commands: grouping.stage.create / grouping.groups.record /
          grouping.stage.confirm / grouping.stage.freeze /
          grouping.stage.correct / grouping.stage.cancel /
          grouping.window.set
queries: grouping.describe
events: 见上
permissions: [grouping.manage]
surfaces: [ops]
scopes: []
emptyDefinition: { schemaVersion: 1 }（无组数约束）
```

`groupCount` 定义编译规则：若出现，必须是正整数。

**Pack**：`singer-competition` 增加 guided 问题
`grouping`（「需要第一轮分组/合唱吗？」，默认 `true`），
`definitions.grouping = { schemaVersion: 1, groupCount: 5 }`。
`stage-show` 与 `review-awards` 不启用 grouping。

## 持久化

新迁移 `0016_grouping`（`packages/db/src/migrations.ts`），三张表与上述约束。
不引入新 projection 表：`grouping.describe` 直接读事务内表（与 registration 读服务
同构）。

## 并发

所有写命令：`executeCommand` → `getActivityForUpdate` → `requireActive` →
`expectedRevision` CAS。与 `registration-service.ts` 完全同构，满足
`docs/invariants/concurrency.md` CONC-03。

## 归档

- `archive-service.requireArchiveClosure` 增加
  `enabledCapabilities.includes("grouping")` 分支：存在非 `frozen` 且非 `cancelled`
  的赛段 → `ARCHIVE_GROUPING_NOT_FROZEN`。
- 归档包在活动存在分组时增加 `grouping.json` 与 `grouping.csv`；字段走现有白名单，
  不含 `sourceFingerprint`。

## API

| 方法 | 路径 |
|---|---|
| GET | `/api/activities/:id/grouping` |
| POST | `/api/activities/:id/grouping/stages` |
| PATCH | `/api/activities/:id/grouping/stages/:stageId/groups` |
| POST | `/api/activities/:id/grouping/stages/:stageId/confirm` |
| POST | `/api/activities/:id/grouping/stages/:stageId/freeze` |
| POST | `/api/activities/:id/grouping/stages/:stageId/correct` |
| POST | `/api/activities/:id/grouping/stages/:stageId/cancel` |
| PATCH | `/api/activities/:id/grouping/stages/:stageId/window` |

写路由沿用 `requireIdempotency` + `requestDeps`；权限在 command handler 内检查
`grouping.manage`。读路由要求同一权限。

## Ops 前端（傻瓜式）

活动页在 `enabledCapabilities` 含 `grouping` 时渲染一张分组卡片：

1. **分组**：输入组数 → 「自动平均分组」→ 组卡片预览；成员可用下拉换组；
   顶部实时显示「已分 15/15」。
2. **确认**：一个大按钮；条件不满足时按钮旁直接说明差什么。
3. **冻结**：一个大按钮。

「更多操作」折叠：修正（原因必填）、取消赛段（原因必填）、材料窗口开关。
后端错误码映射为人话，例如：

- `GROUPING_INCOMPLETE` → 「还有 N 人没有分组」
- `GROUPING_SOURCE_CHANGED` → 「晋级名单变了，请重新确认」
- `GROUPING_CONSUMED` → 「结果已确认，不能再改分组」

## legacy 导入

- v1 `export_plus_bundle`：去掉 group_stage 的 `unsupported` 条目，输出 `grouping`
  段（赛段、组、当前成员、材料窗口、状态、名单来源）；`group_material` 继续
  `unsupported`。
- v2 importer：按原状态导入（frozen 保持 frozen），只导 current 成员，历史不导并
  写入报告；id 派生 `legacy-<publicCode>-grouping-<id>`；与活动导入同事务 + 对账。
  `round_advanced` 赛段通过已导入的轮次映射还原来源轮次；映射不到时按
  `all_approved` 导入，并在报告的 `lossy` 条目里写明原因。
- 旧 bundle 没有 `grouping` 段时照常导入。
- **部署依赖**：导出器属于 v1 代码；cutover 真正使用分组导入前，导出器变更需随
  v1 热修发布。没有该热修的 bundle 仍可导入，只是分组缺失。

## 测试

- Domain：definition 编译（含非法 `groupCount`）、registry 组合、singer pack 的
  guided 问题与默认 definition。
- Runtime（真实 PostgreSQL 双连接）：完整生命周期；完整覆盖；指纹变化拒绝冻结；
  修正历史；取消幂等与冻结不可取消；归档阻塞；组数校验；消费保护；并发创建同
  stageKey；并发 freeze/correct。
- API：路由、权限、错误码、幂等重放。
- Web E2E：自动分组 → 确认 → 冻结一条主旅程。
- 顺带修复：`packages/runtime/test/judge-entry-reuse.test.ts` 把 `now` 显式传入
  `authenticateJudgeSession`，消除随时间失效的失败。

## 配置清单同步

`pyright` include、ruff/mypy 模块清单、`tsconfig*.json` include、Tailwind content、
`.env` 模板、`.dockerignore`、`dependabot.yml` 逐一检查；本 slice 预期只新增
TypeScript 文件，均在既有 glob 内。

## 出口

1. `pnpm -C plus run check` 与 `pnpm -C plus run test` 全绿（含修好的测试）。
2. Gates CI 常绿，boundary gate 无新增例外。
3. E2E 主旅程通过。
4. 文档：ADR-0025、`docs/invariants/lifecycle.md` 增 GRP 条目、roadmap 勾选、
   `shape-validation.md` 缺口表更新。
5. 导入报告能表达 grouping；旧 bundle 保持兼容。

## 附：v1 / Oracle / v2 对照

| 语义 | v1 | Oracle | v2 |
|---|---|---|---|
| 聚合 | GroupStage + Group + GroupMembership | — | 同构 |
| 生命周期 | draft/confirmed/frozen/cancelled | `test_group_chorus.py:428` | 同 |
| 确认覆盖 | 完整覆盖来源名单 | `test_group_chorus.py:150` | 同 |
| 来源确定 | 轮次已锁定 | `test_group_chorus.py:574` | roster final / advancement `auto`（收紧） |
| 冻结指纹 | 比对 | — | 同 |
| 修正 | 留历史 + 原因 | `test_group_chorus.py:187` | 同 |
| 冻结后修正 | 被赛制绑定/结果消费才拒绝 | `ruleset/test_group_chorus.py:106`、`results.md:20` | 活动级保守边界（D2） |
| 成员唯一 | (group,singer) + 完整性校验 | — | (stage,participant) 部分唯一（收紧） |
| 组数 | 消费方校验 | `runbook:16` | release `groupCount`（D1） |
| 组大小自由 | 是 | `runbook:16` | 是 |
| 材料窗口 | 3 态 + 补交限定 | `test_group_chorus.py:277` | 3 态 state-only（D3） |
| 组材料契约 | 伴奏/视频 + 问卷核验 | — | 缺口，归媒体 slice |
| 评分节目一致 | PerformanceGroup 强制一致 | `group_chorus.py:116` | v2 无第二份名单，结构性消失 |
| 归档阻塞 | 未冻结未取消阻塞 | `test_group_chorus.py:463` | 同 |
| ruleset 草稿机件 | 有 | — | 不需要（release 不可变） |
| 活动类型 | 仅歌手比赛 | — | 由组合决定（放宽） |
