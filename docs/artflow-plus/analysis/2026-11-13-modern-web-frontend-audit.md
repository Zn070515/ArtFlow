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
