# Studio Professional Mode 设计（2026-11-14）

## 0. 状态

Implemented and merged (2026-11-14) through PR #98, together with M15.4
Schedule / Program Release. 结构化编辑器与高级 JSON 均保留未知字段。

## 1. 背景

Studio 目前只有两种编辑方式：

- Guided Mode：从 Activity Pack 回答引导问题；
- Expert Mode：直接编辑 Definition Package JSON。

GOAL 要求 Professional Mode：普通组织者应当能结构化地编辑表单、赛制、评分、
发布阶段、排期等定义，而不需要理解 JSON 或能力模型。当前任何 Pack 之外的
定制都必须改 JSON，这是产品可用性的最大缺口。

## 2. 目标

1. 在 `studioActivity` 的 Definition 编辑区提供 **「结构化」/「高级 JSON」** 双 Tab。
2. 为已启用的 capability 提供结构化编辑器：
   - `questionnaire`：问题增删改、类型、必填、文件槽位/扩展名/大小；
   - `registration`：报名生命周期（draft/open/review/final）；
   - `materials`：最大字节数、允许用途；
   - `competition`：回合（key/judgeCount/minimumJudges/advanceCount/scoringMethod）、
     rubric criteria（key/weight/minimum/maximum）、tiePolicy；
   - `publishing`：阶段 key/label；
   - `voting`：单选/多选、最大选择数、身份策略、计分规则；
   - `schedule`：由 M15.4 提供，作为同一 registry 的一个编辑器。
3. 保留 Expert JSON：结构化编辑只修改对应 capability payload，不丢弃未知字段、
   其他 capability、bindings、manifest。
4. 编译/发布流程不变：仍调用现有 `compileStudioDefinition` / `releaseStudioDefinition`，
   继续使用 `expectedDraftRevision` 做 OCC。

## 3. 非目标

- 不做 nodes/edges 自由图编辑器（比赛 DAG 只编辑 rounds/rubric，拓扑由 Pack 默认提供）。
- 不做 bindings 编辑器（保留 JSON 出口）。
- 不在本 slice 做 tasks/grouping/attendance/ticketing 的完整结构化编辑。
- 不新增 capability 定义语言；服务端 compiler 仍是权威。

## 4. 设计

### 4.1 编辑壳

`components/studio/DefinitionEditor.tsx` 改为：

```text
[结构化] [高级 JSON]
（结构化面板按已启用 capability 渲染编辑器）
（高级面板保留现有 textarea、格式化、编译定义）
```

- 内部以解析后的 `pkg` 为结构化编辑的源；每次编辑后同步
  `text = JSON.stringify(pkg, null, 2)`，切 Tab 不丢改动。
- 高级 JSON 仍是唯一可编辑未知字段的出口；JSON 解析失败时只阻塞高级面板的编译，
  不破坏结构化面板的当前 package。
- 编译按钮在两个 Tab 共享；编译成功后展示 hash，失败展示 `ApiError.details`。

### 4.2 Capability editor registry

新增 `components/studio/editors/`：

- `CapabilityEditor.tsx`：按 capability 渲染标题、说明和错误；
- `QuestionnaireEditor.tsx`
- `RegistrationEditor.tsx`
- `MaterialsEditor.tsx`
- `CompetitionEditor.tsx`
- `PublishingEditor.tsx`
- `VotingEditor.tsx`
- （M15.4）`ScheduleEditor.tsx`

每个编辑器只接收 `payload: unknown` 和 `onChange(next: unknown)`；内部用自己的
局部类型守卫，不依赖 `@artflow-plus/domain`（web 不能 import domain 内部类型）。
服务端 compiler 负责最终校验；编辑器只做最少的前端约束（非空 key/label、数字范围）。
未知 capability 不渲染编辑器，提示“该能力请用高级 JSON 编辑”。

### 4.3 保留未知字段

新增 `components/studio/definitionPackage.ts`：

```ts
readCapabilityPayload(pkg: unknown, key: string): unknown
patchCapabilityPayload(pkg: unknown, key: string, payload: unknown): unknown
```

`patchCapabilityPayload` 复制原 package，只替换 `capabilities[key].payload`；
`manifest`、`bindings`、其他 capability、未知顶层字段全部保留。

### 4.4 编译与发布

- 结构化编辑后点“编译定义” → `compileStudioDefinition(activityId, uuid, pkg, draft.revision)`；
- 编译错误按 `ApiError.details` 的 `path` 定位到对应编辑器/字段；
- 发布仍由 `ReleasePanel` 负责；只有当前 draft 已编译时可用。
- 不做自动保存；用户显式点击编译，避免半成品覆盖。

## Test architecture

**Contracts and capabilities touched**

不新增 contracts。只读写已有 `questionnaire`、`registration`、`materials`、
`competition`、`publishing`、`voting` artifact；M15.4 新增的 `schedule` artifact
作为 registry 的第七个编辑器，扩展同一套读写函数。

**Consumers and read models**

唯一消费者是 `studioActivity` 的 Definition 编辑区。compile/release 仍走
`definition-service`；不新增 route、event、topic 或 read model，因此 Consumer Graph
只需保持零未解析边。

**Lifecycle, terminal guards, and mode isolation**

- Draft revision / OCC：结构化编辑不直接写库；编译时带 `expectedDraftRevision`，
  stale revision 由服务端拒绝并显示“数据已更新，请刷新”。
- Release 仍要求当前 draft 已编译；结构化编辑后未编译时 ReleasePanel 保持禁用。
- 不触碰 execution session / mode 分区。

**Adapters**

不新增 contract adapter。编辑器是纯 UI；测试用真实 `definitionPackage` 函数和
局部 fixture，mock 只到 `compileStudioDefinition` 边界。服务端 adapter 不变。

**Fault and recovery cases**

- 编译返回 schema 错误：字段级错误显示，原 package 不丢；
- stale revision：提示刷新，保留用户输入；
- 未知 capability / 未知字段：结构化编辑后仍原样保留；
- JSON 解析失败：切回结构化 Tab 不崩溃，高级 Tab 显示错误；
- 空 key/重复 key/越界数字：前端阻止或由 compiler 返回明确错误；
- 结构化编辑 → 编译 → 发布 → 再次编辑：新 draft revision 正确递增。

**Why existing tests are insufficient**

现有 `studioActivity.test.tsx` 把 `DefinitionEditor` 整体 mock 掉，只验证页面骨架；
`definitionSummary` 只测只读摘要。没有任何测试覆盖“结构化编辑后 package 仍完整、
编译带正确 revision、错误可定位”。

**Anti-bloat decision**

扩展 `DefinitionEditor` + `definitionSummary`，新增一个通用 editor registry；
不为每个 capability 复制一整页。纯函数 `definitionPackage` 负责保留未知字段，
所有编辑器共用。不新增第二套 schema 或第二个 compile 路径。

**Focused gates**

`pnpm -C plus --filter @artflow-plus/web test`、`pnpm -C plus run check`、
`pnpm -C plus --filter @artflow-plus/web exec playwright test e2e/studio.spec.ts`、
`uv run pytest tests/gates -q`、`playwright` 的 Studio 结构化编辑 journey。

## 5. 实施顺序

1. `definitionPackage.ts` + 单元测试（保留未知字段）；
2. `DefinitionEditor` 双 Tab + 现有 JSON 编辑回归；
3. `QuestionnaireEditor` + `RegistrationEditor`；
4. `CompetitionEditor` + `PublishingEditor`；
5. `MaterialsEditor` + `VotingEditor`；
6. 接入 M15.4 `ScheduleEditor`；
7. E2E：Guided 创建 → 结构化编辑问题/回合/阶段 → 编译 → 发布 → Live 启动。
