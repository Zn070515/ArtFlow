# 前端现代化审计（Modern Web Guidance，2026-11-13）

## 方法

- `modern-web-guidance list`：目录共 208 条指南。
- `legacy-scan plus/apps/web/src`：只覆盖约 20% 的确定性规则，首次命中 1 条
  `dynamic-sibling-animations`（已修复，见下）。
- 其余按应用实际模式逐条 `search`/`retrieve`：对话框、抽屉、标签页、复制按钮、
  响应式表格、后台渲染、表单、主题、排版、容器查询。
- 每条发现都指到现有代码；这是审计，不是“把目录逐条套一遍”。

## 已修复

| 指南 | 证据 | 修复 |
|---|---|---|
| `dynamic-sibling-animations` | `portal.css` 的 4 条 `.rank-row:nth-child` 延迟规则 | 改为 `sibling-index()` + `--sibling-index` 回退，保留原时间轴（merge `ac3acef8`） |

## 待办发现（按优先级）

### P1：可访问性与电池

1. **原生 `window.prompt` / `window.confirm`**
   - 证据：`LiveRoundPanel.tsx:119,131`。
   - 指南：`dialog`、`light-dismiss-a-dialog`、`platform-controls-dismiss-dialog`、
     `prevent-page-scroll-under-modal-dialog`。
   - 现状：浏览器原生弹窗无法主题化、移动端体验差、无法承载校验/审计说明。
   - 建议：新增 `<dialog>` 基元（`showModal()`、`aria-labelledby`、`autofocus`、
     `closedby="any"` + 回退、`dialog:modal` / `::backdrop` 的 `overscroll-behavior`），
     替换两处调用。

2. **Attendance 标签页缺少可见选中态与键盘语义**
   - 证据：`AttendanceCard.tsx:233-246` 使用 `role="tablist"`/`role="tab"`，但
     `attendance-tabs` 在任何 CSS 中都没有定义；没有 `tabpanel`、没有方向键移动、
     没有 `hidden` 面板。
   - 指南：`tabs`。
   - 建议：补 `role="tabpanel"` + `aria-labelledby`；用 roving tabindex 或
     `focusgroup`（带 polyfill 检测）；选中态用边框/下划线而非仅颜色；
     面板切换用 `hidden="until-found"`（渐进增强）。

3. **响应式表格仍在用视口断点，且 `thead` 只做视觉隐藏**
   - 证据：`ui.css:157-201` 用 `@media (max-width: 767px)` 把表格变成卡片；
     `thead` 用 `position:absolute` + `clip` 隐藏；`Table.tsx` 的 `.ui-table-wrap`
     没有 `tabindex`/`role="region"`。
   - 指南：`responsive-table`。
   - 已做：wrapper 加 `tabindex="0"`、`role="region"` 和 `aria-labelledby`
     （指向 caption 的 id）；手机卡片模式 `thead { display: none }`。
   - 推迟：容器查询。Console 主列在桌面也会窄于视口（240 侧栏 + 360 rail），
     按容器宽度卡片化会让 1024 的 Ops 表格也变成卡片，破坏桌面表格语义；
     需要先按组件逐页决定容器阈值，再做试点。

4. **Aurora WebGL 在页面隐藏后仍在渲染**
   - 证据：`AuroraCanvas.tsx` 的 `<Canvas>` 没有 `frameloop` 控制，也没有
     `visibilitychange`/`contentvisibilityautostatechange` 处理。
   - 指南：`efficient-background-processing`。
   - 建议：监听 `document.visibilityState`（并在支持时监听
     `contentvisibilityautostatechange`），隐藏时把 R3F `frameloop` 设为 `"never"`，
     恢复时回到 `"always"`；这是电池/CPU 收益，不改变视觉。

### P2：表单、主题与反馈

5. **复制反馈只有屏幕阅读器可见，且不会复位**
   - 证据：`WorkspaceActivityCard.tsx:56-83` 的 `role="status"` 位于 `sr-only`，
     `copyState` 永不回到 `idle`。
   - 指南：`copy-button`。
   - 建议：可见的成功/失败提示与 `role="status"` 共用一个元素；2 秒后清理；
     不要禁用按钮；保留 `navigator.clipboard` 失败提示。

6. **缺少 `<meta name="color-scheme">` 与 `accent-color`**
   - 证据：`index.html` 只有 `theme-color`；`themes.css` 有 `color-scheme`，
     但没有 `accent-color`。
   - 指南：`dark-mode`、`browser-ui-theming`、`brand-consistent-forms`。
   - 建议：`<meta name="color-scheme" content="light dark">` 减少首屏白闪；
     在主题根上设置 `accent-color`，让原生 checkbox/radio/range 跟随品牌色。

7. **标题没有 `text-wrap: balance`，正文没有 `text-wrap: pretty`**
   - 证据：`grep text-wrap` 无结果；标题/段落使用默认 greedy 换行。
   - 指南：`typography`、`improve-text-layout-and-legibility`。
   - 建议：只对 `h1-h6`、`.ui-page-title`、`.display` 等短标题加 `balance`；
     对 `.lede`、`.ui-state__copy` 等正文块加 `pretty`（渐进增强，不支持则忽略）。

### P3：更大范围的现代化

8. **交互态使用 `transform` 而不是独立 `translate`/`scale`**
   - 证据：`ui.css:32`、`forms.css:83`、`portal.css:123` 等。
   - 指南：`individual-transform-properties`。
   - 建议：对会 hover/active 的元素设置 identity（`translate: 0; scale: 1;`），
     再把 hover/active 改为单独属性，避免覆盖整条 transform 链。

9. **组件响应式仍以视口断点为主**
   - 证据：`workspace.css`、`studio.css`、`console-components.css` 的 `@media`。
   - 指南：`size-aware-styling`、`responsive-design`。
   - 建议：先对一个高复用组件（活动卡/统计卡）引入 `container-type: inline-size`
     与 `@container`，验证“同一卡片在窄 rail 内也能正确换行”后再推广。

10. **移动端 Console 抽屉是自定义 transform 实现**
    - 证据：`console-shell.css:265-299`；`ConsoleShell.tsx` 手写 Escape 与焦点恢复。
    - 指南：`navigation-drawer`。
    - 现状：没有 inert/焦点陷阱/backdrop/滑动关闭；桌面又是常驻侧栏。
    - 建议：采用指南的“抽屉兼侧栏”变体（`popover="manual"` + `inert` +
      `aria-modal` + 滑动），或先补 `inert`/backdrop/焦点陷阱，再分阶段迁移。

## 建议批次

1. **P1 可访问性与电池**：1（dialogs）、2（tabs）、3（table）、4（WebGL pause）。
2. **P2 表单与主题**：5（copy）、6（meta/accent）、7（text-wrap）。
3. **P3 渐进**：8（transform）、9（container query 试点）、10（drawer）。

## 高强度代码审查后的修正

- **评分事实读模型的 mode 隔离**：`advancement_decision` 没有 mode 列，读投影会把
  formal 晋级决策配到 rehearsal/test 排名上。读服务现在用决策指纹反查来源 ranking
  快照，只有 mode 与当前 session 一致时才返回 advancement。
- **查询并行化**：facts / ranking / advancement / performances 改为 `Promise.all`，
  corrections 依赖 facts 后单独查询；不再串行 8 次。
- **修正历史扫描**：`listLatestCorrectionsForScoreFacts` 改用
  `distinctOn("score_fact_id")` + `created_at desc`，数据库只返回每个事实的最新一条。
- **分组创建重试**：重复 `stageKey` 的检查移到晋级来源解析之前，重试返回准确的
  `GROUPING_STAGE_EXISTS`，不再被 `STALE_ADVANCEMENT` 掩盖；同时去掉重复的
  `getRound`。
- **`score.write` 的 UI 门槛**：Live 页对只有评分权限的账号隐藏准备/激活/锁轮/
  重开/重置/生成排名与会话控制，只保留修正、平局/晋级和只读排名。
- **`<dialog>` 的模块级引用**：`HTMLDialogElement` 检测改为 `typeof` 守卫；
  不支持时 `showModal` 不执行，关闭态由 `.ui-dialog:not([open])` 隐藏，不会
  因模块求值白屏。
- **Attendance 标签切换**：`keepPreviousData` 下切换标签时用 `isFetching` 判断，
  显示“正在加载…”而不是把上一标签的空行误报成“当前筛选下没有主体”。
- **再次修正**：`recalculated`/`cancelled` 只是当前修正的终态；同一评分事实可
  再开新修正，面板显示「再次修正」。

### 保留的权衡

- **`thead { display: none }`**：这是 `responsive-table` 指南的明确要求；卡片
  标签由 `td::before` 提供，属于该指南的标准堆叠模式。旧 `clip` 方案保留了表头
  但会与标签重复播报，二者不可兼得。
- **测试夹具重复**：API 与 runtime 各有一份竞赛种子；仓库没有共享 test-support
  包，两份文件用互相指向的注释记录了同步义务。

## P3 已交付

- **独立 transform 属性**：按钮的 hover/active 从 `transform: translateY/scale`
  改为 `translate`/`scale`，并在基础态设置 identity，避免只有状态变化时创建
  新的 stacking context。
- **容器查询试点**：`.workspace-activity-card` 设为 `container-type: inline-size`，
  卡片自身宽度 <420px 时头部/底部改为纵向排列；这是按组件阈值决定，不再用
  视口断点推断卡片宽度。
- **移动端 Console 抽屉**：移动断点下抽屉是 `role="dialog"` + `aria-modal`，
  打开时 topbar/main `inert`、有可点击 backdrop 与显式关闭按钮，关闭后焦点回到
  菜单按钮；桌面断点仍是普通侧栏，不暴露 dialog 角色。
- **暂缓**：指南的 scroll-snap 滑动手势需要把侧栏重构成横向 scroller；本轮先补
  模态语义、焦点与关闭路径，滑动作为后续独立改造。

## 第二轮高强度审查后的修正

- **权限拆分**：`canManageCompetitionSetup` 只认 `competition.manage`；新增
  `canPrepareCompetitionRound`（含 `competition.round.prepare`）、
  `canResolveCompetition`（含 `competition.score.write`）、
  `canManageLiveSession`（`studio.manage`/`competition.manage`），与后端
  `requireSetupPermission` / `requireResolutionPermission` / `requireSessionManager`
  逐一对齐。评分员能看到「生成排名」，但看不到锁轮/重开/重置。
- **晋级 mode 判定可测**：抽出 `advancementMatchesMode` 纯函数并直接测试
  “rehearsal ranking + formal decision” 的拒绝路径，不再依赖一个恰好 `ranking=null`
  的集成场景。
- **Attendance 过滤刷新**：`isFetching` 时始终显示“正在加载…”，并禁用行内
  签到/撤销，避免旧行在新搜索/签到点/模式加载期间仍可点击。
- **锁定提示分支**：评分员看到的是“请联系具备 competition.manage 权限的人员
  重开本轮”，而不是一个对他们隐藏的按钮。
- **Console hover**：补 `translate: 0`，与 `scale: 1` 一起取消主按钮的 1px 上浮。
- **模态滚动**：保留指南的 `dialog:modal`/`::backdrop` `overscroll-behavior`
  方案，不采用 `body { overflow: hidden }`——指南明确禁止修改根滚动容器，
  会移除滚动条、造成布局位移并破坏 sticky。该行为按渐进增强处理。

## 工程韧性补强（2026-11-13）

- **路由级 error boundary**：`createRouter` 配置 `defaultErrorComponent` /
  `defaultPendingComponent`，渲染异常落到 `ErrorState`，不再白屏；懒加载期间
  显示“正在加载…”。
- **路由拆分**：所有路由改为 `lazyRouteComponent`，主包从 **178.5 KB gzip**
  降到 **107.6 KB gzip**；Studio、Live、Ops、Vote、Judge、Workspace 等按路由
  拆成独立 chunk，Aurora 3D 保持独立懒加载。`defaultPreload: "intent"` 让 hover
  时预取。
- **axe smoke**：新增 `e2e/a11y.spec.ts`，覆盖 `/`、`/login`、`/workspace`、
  `/ops`、`/studio`、`/live`、`/results/E2E-DEMO`，只拦截 serious/critical。
  首跑发现 12 个 `color-contrast` 节点（`ui-badge--success/warning` 的彩色小字
  在浅色主题上只有 4.3:1）；badge 改为“底色 + 边框承载 tone，文字使用正常
  text 色”，重跑 0 violations。
- **token 基线**：badge 文字色变化后重生成 `tokens-1440.png` / `tokens-390.png`。
- **仍未做**：Ops/Studio/Live/Vote/Results 的 1440/1024/390 全页视觉基线；
  长列表虚拟化/content-visibility 仍等数据量证明需要。

## 选手姓名投影（2026-11-13）

- **公开赛果**：`selectPublicResults` 从当前活动的 registration answers
  (`name`/`displayName`/`title`) 解析 `contestantName`，无值时回退 contestantId；
  release snapshot 仍只冻结 ID，姓名是读取时投影，不改变不可变发布记录。
- **Live 表格**：轮次表演表与排名表改用 `state.participantNames`；修正面板与
  平局面板此前已投影姓名。
- **仍存在 ID**：归档包/导出、部分内部诊断表仍以 contestantId 为准；这些是
  运维/集成输出，下一轮按需补 display contract。
