# Studio 引导向导与就绪清单设计

- **Status**: proposed
- **Date**: 2026-11-18
- **Scope**: `plus/apps/web` Studio 面：`/studio/new` 六步创建向导；Studio 活动页增加就绪清单；不新增后端接口或表
- **相关**: [GOAL](../../../GOAL.md)、[前端视觉方向](../frontend-design-direction.md)、[ADR-0018 Studio 引导/专家与权限](../../architecture/adr/0018-studio-guided-expert-and-authority.md)、[公开活动站设计](./2026-11-18-portal-public-event-site-design.md)

## 0. 结论

1. **创建走六步向导**：模板 → 基本信息 → 报名与材料 → 评审与现场 → 运营与发布 → 检查与创建；复用现有 `previewPack` 与 `createStudioActivity`，不改后端。
2. **活动页增加就绪清单**：把 `StudioState` 投影成可执行步骤，不重复命令逻辑；编译/发布仍由现有 `DefinitionEditor` / `ReleasePanel` 执行。
3. **生命周期顺序以实际约束为准**：**定义已保存 → 活动已激活 → 当前草稿已编译 → 已发布当前定义**。
   现有 `ReleasePanel` 的 `canRelease` 要求活动已激活，向导不能把顺序写成“编译→发布→激活”。
4. **公开主页资料是建议步骤**，不阻塞；`closed`/`archived` 不提供发布动作，归档活动只读。
5. **既有生命周期缺口一并修正**：`definition.compile` 当前只拒绝“无 draft”的 closed/archived，已有 draft 时仍可编译改写；
   本设计给该命令加 `draft|active` 守卫，并让 Studio 编辑器在 closed/archived 只读。

## 1. 目标

- 让第一次创建活动的组织者不面对 20+ 能力与原始 JSON，而是按业务语言逐步完成配置。
- 创建后立即看到“还差什么才能上线”的清单，并知道每一步去哪里操作。
- 所有步骤都来自现有 Pack/StudioState，不新增第二套业务模型。

### 非目标

- 不把 `DefinitionEditor` 重做成 Guided 业务语言编辑器；
- 不在创建前保存草稿；
- 不新增 Pack 字段、不改变能力组合/编译语义；
- 不新增后端接口、表、迁移、命令或事件；仅给既有 `definition.compile` 增加生命周期守卫；
- 不做 Ops 风险看板 / Live 控制台（后续子项目）。

## 2. 创建向导

### 2.1 步骤

```text
1 选择模板
2 基本信息
3 报名与材料
4 评审与现场
5 运营与发布
6 检查与创建
```

| 步骤 | 内容 | 完成条件 |
| --- | --- | --- |
| 1 选择模板 | Pack 卡片：标题、说明、已包含能力；默认选中第一个 | 已选 Pack |
| 2 基本信息 | 活动标题（必填）；提示公开码创建后生成 | 标题 trim 后非空 |
| 3 报名与材料 | 问题开关：`registration` / `questionnaire` / `materials`；显示默认字段与材料限制 | 可跳过（使用默认） |
| 4 评审与现场 | `competition` 基线说明 + `grouping` / `voting` / `ticketing` 问题；显示默认回合/评分 | 可跳过 |
| 5 运营与发布 | `tasks` / `attendance` / `incident` / `archive` 问题；`publishing` 默认阶段说明 | 可跳过 |
| 6 检查与创建 | 完整摘要、Pack 组合错误、创建按钮 | 预览成功且标题非空 |

### 2.2 问题分组

Pack 问题按 `question.capability` 分组：

```text
registration, questionnaire, materials -> 报名与材料
competition, grouping, voting, ticketing -> 评审与现场
tasks, attendance, incident, archive, publishing -> 运营与发布
其他 -> 运营与发布
```

- `pack.baselineCapabilities` 显示为“已包含”，不可关闭；基线能力不显示可关闭的开关；
- 问题默认值来自 `question.default`；切换答案更新预览；
- **切换 Pack 时 answers 重置为新 Pack 的默认值**，title 保留；预览随新 Pack 刷新，避免旧答案污染新组合；
- 未出现在问题中的能力只通过基线或后续 Studio 编辑获得，向导不猜测。

### 2.3 实时预览

- 使用 `previewPack(packId, { title, answers })`（现有 `POST /api/packs/:id/instantiate`）作为 `useQuery`：
  - key：`["pack-preview", packId, title, answers]`；
  - `enabled: pack !== undefined`；
  - 返回 `enabledCapabilities` + `definition`；
  - 422/组合错误时显示 `ApiError.details`，并禁用“创建”。
- 右侧 rail 显示：
  - 已启用能力；
  - `summarizeDefinition` 的报名字段、回合/评委、评分、材料、发布阶段、投票；
  - 折叠的原始 JSON（高级）。
- 预览随答案变化自动刷新；不做“预览按钮”。

### 2.4 创建

- `createStudioActivity({ title, packId, answers })`（现有 `POST /api/activities`）。
- 成功后导航 `/studio/$activityId`，由就绪清单接管下一步。
- 创建失败：显示 `apiErrorText`；组合错误/冲突不丢失用户已填内容。
- 步骤可回退到已完成步骤；前进由“下一步”控制；最后一步“创建活动”。

### 2.5 交互与布局

- 顶部 stepper：6 个步骤，当前步高亮，已完成可点击回退；
- 桌面：左侧步骤内容 + 右侧 360px 预览 rail；<1024px rail 堆叠到下方；
- 390px 单列，无横向滚动；
- 设置 `document.title = "新建活动 · Studio"`。

## 3. 就绪清单

### 3.1 步骤与派生

在 Studio 活动页 header 下方渲染 `StudioReadiness`；步骤全部来自 `StudioState`：

| # | 步骤 | 完成条件 | 状态/动作 |
| --- | --- | --- | --- |
| 1 | 定义已保存 | `state.draft !== null` | 未完成：锚点 `#definition-editor` |
| 2 | 活动已激活 | `state.activity.status !== "draft"` | 未完成：调用页面现有 `activate()` |
| 3 | 当前草稿已编译 | `state.compiled !== null`（当前 draft revision） | 未完成：锚点 `#definition-editor` 的“编译定义” |
| 4 | 已发布当前定义 | 存在 `active` release 且 `activeRelease.contentHash === state.compiled.contentHash` | 未完成：锚点 `#release-panel` |
| 5 | 公开主页资料 | `tagline.trim() !== "" || description.trim() !== ""` | 建议步骤：链接 `/studio/$id/public` |
| 6 | 去 Ops 准备 | 步骤 1–4 完成 | 链接 `/ops/$id`；显示“活动已上线” |

- 步骤 4 的 active release 的 `contentHash` 与当前 compiled 不同 → 状态 `stale`，文案“有新改动未发布”，动作仍是 `#release-panel`；
  用 contentHash 而不是 `sourceDraftRevision`，避免“同一内容重新编译”被误报为未发布；
- `state.compiled === null`（当前 draft 未编译）→ 步骤 3 未完成；若存在 active release，步骤 4 同时显示 stale；
- `state.sessions.some(status === "running")` → 步骤 4 额外提示“先关闭运行中的会话”，锚点 `#session-panel`；不自行关闭；
- `archived` → 整卡只读，显示“已归档，不能继续发布”；不提供激活/编译/发布/资料动作；
- `closed` → 步骤 1–4 按实际状态显示，但不提供激活/编译/发布动作；步骤 6 显示“活动已结束”；
  若 release 与当前 compiled 不一致，显示“活动已结束，不能重新发布”，不渲染可执行发布锚点；
- 步骤 5 不阻塞 ready；ready 只要求 1–4。
- ready 的 1–4 只在 `active` 活动上成立；`closed`/`archived` 不显示“已就绪”而是终态说明。

### 3.2 状态与视觉

```text
done     success  ✓
current  warning  当前建议操作（第一个未完成）
pending  neutral  未开始
stale    danger   已发布但不是当前草稿
```

- 桌面横向 stepper；<900px 纵向列表；
- 每步：序号/对勾、标题、一句状态说明、动作链接或按钮；
- 卡片标题“上线就绪度”，右侧显示 `n/4`；
- 全部完成：显示“活动已就绪” + Ops 链接；
- 不重复 `ReleasePanel`/`DefinitionEditor` 的命令按钮：编译/发布用锚点，激活用页面已加载的 handler。

### 3.3 锚点

- `DefinitionEditor` 的外层 `Card` 增加 `id="definition-editor"`；
- `ReleasePanel` 的外层 `Card` 增加 `id="release-panel"`；
- `SessionPanel` 的外层 `Card` 增加 `id="session-panel"`；
- 页面 `scroll-margin-top` 由 CSS 提供，锚点跳转不被 topbar 遮住。

## 4. 组件与文件

| 文件 | 责任 |
| --- | --- |
| `plus/apps/web/src/components/studio/StudioWizard.tsx` | 步骤状态、步骤内容、预览 rail、创建 |
| `plus/apps/web/src/components/studio/StudioReadiness.tsx` | 就绪步骤派生、动作、锚点 |
| `plus/apps/web/src/routes/studioNew.tsx` | 承载向导；替换现有单页表单 |
| `plus/apps/web/src/routes/studioActivity.tsx` | 渲染就绪清单；传 `onActivate` |
| `plus/apps/web/src/components/studio/DefinitionEditor.tsx` | 外层增加 `id="definition-editor"`；closed/archived 只读，禁用编译 |
| `plus/apps/web/src/components/studio/ReleasePanel.tsx` | 外层增加 `id="release-panel"` |
| `plus/apps/web/src/components/studio/SessionPanel.tsx` | 外层增加 `id="session-panel"` |
| `plus/packages/runtime/src/definition-service.ts` | `compileDefinition` 增加 `draft\|active` 生命周期守卫 |
| `plus/packages/runtime/test/activity-service.test.ts` | 扩展 compile-on-closed/archived 守卫用例 |
| `plus/apps/web/src/styles/studio-wizard.css` | stepper、pack 卡片、wizard 布局、readiness |
| `plus/apps/web/src/styles/global.css` | 在 `studio.css` 后导入 |
| 测试 | `StudioWizard.test.tsx`、`StudioReadiness.test.tsx`、更新 `studioNew.test.tsx` / `studioActivity.test.tsx`、E2E |

## 5. 生命周期与错误

- 活动：`draft → active → closed → archived`；激活只允许 draft；`closed`/`archived` 不再发布。
- 定义：**`definition.compile` 只允许 `draft`/`active`**；`closed` → `INVALID_TRANSITION`，`archived` → `ACTIVITY_ARCHIVED`。
  这修正了“已有 draft 的归档活动仍可被重新编译改写”的既有缺口。
- 发布：draft 必须编译当前 revision 才能发布；发布要求活动 active、无运行中会话、未创建回合。
- 发布是否当前：比较 active release 与当前 compiled 的 `contentHash`；相等即当前，**不用 `sourceDraftRevision`**。
  同一内容重新编译会 bump draft revision，但 contentHash 不变，不应显示 stale。
- 创建向导：预览 422 组合错误禁用创建；创建 409/422 显示原因，不丢答案。
- `closed`/`archived`：DefinitionEditor 只读（禁用编译），ReleasePanel 不可发布，readiness 只读；
  `closed` 上若 release 与当前 compiled 不一致，显示“活动已结束，不能重新发布”，不渲染发布锚点。
- 不做 optimistic UI；所有完成状态来自刷新后的 `StudioState`。

## 6. Test architecture

### 6.1 契约与能力

- 不新增 capability、命令、事件、路由或表；向导是现有 Pack 预览/创建 API 的 UI 组合。
- 就绪清单是 `StudioState` 的只读投影，不进入 `executeCommand` 的 authority 路径。
- 不扩展 `plus/tools/contracts/src/harness/adapters/`。

### 6.2 消费者、读模型、路由、事件、topic

- 复用 `POST /api/packs/:id/instantiate`、`POST /api/activities`、`GET /api/activities/:id/studio`；
- 不新增 API 路由；`/studio/new` 与 `/studio/$activityId` 的页面行为变化；
- 不新增 read model、event、realtime topic；`graph:check` 仍为零 unresolved。

### 6.3 生命周期边界、终态与 mode 隔离

- 就绪清单只覆盖活动生命周期与定义发布，不涉及 execution mode；test/rehearsal 会话只作为“运行中会话”提示，不改变发布规则；
- `closed`/`archived` 只读：不提供激活/编译/发布；`definition.compile` 的守卫是权威，UI 只读是体验层；
- 发布 stale 判定必须比较 active release 与当前 compiled 的 `contentHash`，不能用 `sourceDraftRevision`（同一内容重编译会 bump revision）；
- 激活是发布前置；编译可在激活前后，但发布要求已激活 + 当前草稿已编译；
- 创建向导的 Pack 切换必须重置 answers，避免旧答案进入新组合的预览/创建。

### 6.4 适配器

不新增 capability adapter。测试用 mock API 的组件测试 + 现有真实后端 E2E；不新增数据库测试。

### 6.5 故障注入与恢复状态

| 故障 | 注入方式 | 断言 |
| --- | --- | --- |
| 预览组合错误 | `previewPack` 返回 422 issues | 检查步骤显示问题，创建按钮禁用，用户答案保留 |
| 创建冲突 | `createStudioActivity` 返回 409/422 | 显示原因，停留在检查步骤，不丢答案 |
| 旧 release | active release 的 `sourceDraftRevision` 落后 | 就绪步骤 4 stale，提示重新发布 |
| 运行中会话 | `state.sessions` 有 running | 步骤 4 提示先关闭会话，不自行关闭 |
| 归档活动 | `state.activity.status === "archived"` | 就绪卡只读，无激活/发布动作 |
| 公开资料为空 | `publicProfile` 空 | 步骤 5 建议补全，ready 不阻塞 |
| 步骤回退 | 在检查步骤点“上一步” | 答案、Pack、标题保持；预览不丢 |
| 同一内容重新编译 | 再次编译同一 package | draft revision bump、contentHash 不变；readiness 步骤 4 仍为 done，不显示 stale |
| closed/archived 编译 | 直接调 `compileDefinition` | `INVALID_TRANSITION` / `ACTIVITY_ARCHIVED`；draft 不变；编辑器只读 |
| 切换 Pack | 先答旧 Pack 问题，再换 Pack | answers 重置为新 Pack 默认值；预览/创建只含新 Pack 能力 |

### 6.6 现有测试为什么不够

- 现有 `studioNew.test.tsx` 只覆盖单页创建，不覆盖步骤、校验、预览错误；
- 现有 `studio.spec.ts` 只从单页直接创建，不覆盖向导与就绪清单；
- 现有 `DefinitionEditor`/`ReleasePanel` 测试不覆盖“是否已就绪”的派生；
- 现有 a11y 只审计 `/studio` 列表，不覆盖 `/studio/new`。

### 6.7 防膨胀 / anti-bloat 决定

- 新增 `StudioWizard.test.tsx` 与 `StudioReadiness.test.tsx` 两个聚焦组件测试；不复制页面测试模板。
- 扩展 `studio.spec.ts` 作为唯一 E2E 旅程；不新建第二个创建流程。
- 就绪清单用一个纯函数 `deriveReadiness(state)`，在组件测试里直接断言 6 种状态；不做 per-capability 矩阵。
- 生命周期守卫扩展现有 runtime 测试（`activity-service.test.ts` 或 definition-service 相关用例）一条，不新建命令测试套件；
- 其余为 UI 组合层，不新增数据库测试或契约 adapter。
- 不引入表单框架、步骤库或第二套设计系统。

### 6.8 聚焦门禁

```powershell
Set-Location plus
pnpm run check
pnpm --filter @artflow-plus/web test -- StudioWizard StudioReadiness studioNew studioActivity
$env:ARTFLOW_PLUS_DATABASE_URL = "postgresql://artflow:artflow_dev@127.0.0.1:5433/artflow_plus"
$env:NO_PROXY = "127.0.0.1,localhost,::1"
pnpm --filter @artflow-plus/web test:e2e -- studio.spec.ts a11y.spec.ts
pnpm run test
pnpm run build:prod
pnpm --filter @artflow-plus/contract-tools graph:check
```

仓库级：

```powershell
uv run pytest tests/gates -q
uv run python tests/golden/validate_fixtures.py
pwsh -NoProfile -File scripts/check_docs.ps1
```

## 7. 实施顺序

1. `definition.compile` 的 `draft|active` 守卫 + runtime 测试；
2. `deriveReadiness` + `StudioReadiness` + 组件测试；
3. `StudioWizard` 步骤/预览/创建 + 组件测试（含 Pack 切换 reset）；
4. `studioNew.tsx` 接入向导；`studioActivity.tsx` 接入就绪清单 + 锚点 + `DefinitionEditor` closed/archived 只读；
5. 样式、a11y、E2E 更新；
6. 全量门禁、合并、CI。

## 8. 风险与待决

- **Pack 问题分组是约定**：如果未来 Pack 新增能力而未分组，归入“运营与发布”；不会丢失问题。
- **就绪清单不替代命令校验**：它只是提示；真正的拒绝仍来自 `ReleasePanel`/编译器/命令。
- **公开资料是建议**：不填也能上线；如果客户要求必须填写才能上线，后续把步骤 5 提升为硬门槛。
- **向导状态不持久化**：离开页面会丢失未创建的选择；需要草稿保存时另开设计。
- **同一内容重编译**：draft revision 会 bump，但 contentHash 不变；就绪判定只看 contentHash，避免假 stale。
- **closed/archived 编译**：已加命令守卫；如果外部客户端仍调用旧编译接口，会得到 `INVALID_TRANSITION` / `ACTIVITY_ARCHIVED`，draft 不变。
