# ArtFlow-Plus 前端视觉方向：Portal / Console 双壳

状态：**Proposed**（2026-10-27）——方向已固定，前端实现与页面迁移留到下一轮。
范围：`plus/apps/web` 的视觉语言、桌面布局、组件契约与验收方式。
相关：[ADR-0016](../architecture/adr/0016-web-shell-and-public-portal.md)（Afterglow 公开门户）、
[ADR-0034](../architecture/adr/0034-portal-console-shell-split.md)、
[M8a Web Shell 设计](specs/2026-10-26-m8a-web-portal-design.md)。

## 1. 背景与结论

Afterglow（深墨底、香槟金、FBM 极光、金属圆环、Fraunces 展示字体）是为**公开结果页**
建立的品牌语言。它在 `/` 与 `/results/*` 上是成立的：结果页需要仪式感，也需要一个可分享的
视觉记忆点。

问题在于后续 Ops / Studio / Live / Judge 沿用了同一个 `RootLayout`、同一套 hero 标题和
同一组玻璃卡样式。于是运营工具页同时具备了：

- 营销页的视觉公式（全屏极光、超大衬线标题、渐变金字、宽字距眉标、玻璃卡、光晕）；
- 工具页的内容密度（表格、表单、会话控制、长 ID、多次操作）；
- 却没有工具页应有的信息架构（侧栏、当前 section、活动上下文、主列 + 固定侧栏）。

结果就是“AI 味很重”和“电脑上布局不好”同时出现：**不是品牌方向错了，而是页面类型没有分开。**

本文件固定两级结论：

1. **保留 Afterglow，但只属于 Portal。**
2. **新建 Console 壳，承接 Ops / Studio / Live / Judge。**
3. 两壳共享颜色与品牌标记，不共享页面骨架、字号体系、动效和卡片密度。

下一轮先按本文件实现 Console Shell 与 Ops 页面，再逐页迁移；公开 Portal 只做收敛，不做第二次重设计。

## 2. 现状证据

| 问题 | 位置 |
|---|---|
| 全屏 WebGL 背景挂载在所有路由 | `src/routes/__root.tsx:13` 无条件渲染 `AuroraScene` |
| 内部页复用公开结果页的标题样式 | `src/routes/ops.tsx:45`、`opsActivity.tsx:61`、`studio.tsx:45`、`studioActivity.tsx:102`、`live.tsx:45`、`liveActivity.tsx:63`、`judge.tsx:120` 均使用 `display results-title` |
| 内部标题最大 6.4rem（约 102px） | `src/styles/global.css:972` |
| 内容区顶部 8vh、底部 12vh | `src/styles/global.css:152` |
| 玻璃卡统一 26px 模糊 + 30/90 阴影 | `src/styles/global.css:463`、`:977`、`:167` |
| 只有 720px 与 900px 两个布局断点 | `src/styles/global.css` 的 `@media` |
| 15 种字号，5 种低于 0.75rem（约 9.9–11.8px） | `src/styles/global.css` 字号统计 |
| 使用但 CSS 未定义的 class | `button-primary`、`button-secondary`、`grouping-card`、`question-field`、`review-panel`、`studio-editor`、`voting-actions`、`voting-new`、`voting-sessions` |
| 投票卡缺布局，桌面截图出现控件重叠 | `VotingCard.tsx:189` 的 `.voting-sessions` 未定义；`:210` 的 `.voting-new` 未定义；CSS 只定义了相邻的 `.voting-session-row`（`global.css:1332`） |
| 主按钮命名不一致 | `GroupingCard.tsx:220` 使用 `button-primary`，CSS 实际是 `primary-button` |
| 大量裸 `<button>` / `<input>` | VotingCard、ReviewPanel、Studio Session/Release 面板等 |
| 中文标题字体依赖系统回退 | `tokens.css:16` 的 Noto Serif SC / Songti SC / SimSun；包内只装了 Fraunces 与 Space Grotesk（`package.json:17-18`） |

这些不是“审美偏好”问题，而是页面类型、组件契约与桌面密度同时缺失的证据。

## 3. 设计原则

1. **Portal 讲故事，Console 做事。** 同一品牌，不同页面骨架。
2. **金色是强调色，不是背景色。** Console 的中性表面占 90%，金色只给主操作、active、关键数值。
3. **字号是信息层级，不是装饰。** 工具页 H1 不超过 32px；展示衬线只用于 Portal 和结果数字。
4. **数据下面不放动效。** 表格、表单、会话控制所在页面不挂 WebGL，不做无限扫光。
5. **先有 primitive，再有页面。** Button / Input / Select / Card / Table / Badge 是契约，页面不直接写浏览器默认控件。
6. **桌面优先验证。** Console 以 1440×900 为参考视口，再向下适配；不能只靠 390px 通过。

## 4. 双壳定义

### 4.1 Portal Shell（`/`、`/results/*`、`/vote/*`）

- 保留 Afterglow：深墨底、香槟金、余烬红、Fraunces、超大标题、极光/圆环。
- 只在 `/` 与 `/results/*` 挂载 WebGL；`/vote/*` 使用静态渐变，避免投票页被动画干扰。
- 标题仍是品牌资产：landing 可到 8.8rem，结果页可到 6.4rem；但只出现在这两个场景。
- 结果页保留冠军扫光；投票页不做扫光、不做无限动画。
- 公开页的单列/居中是对的：它们只有一个任务（看结果、投票）。
- `/vote/*` 在桌面从 640px 单列升级为 960px 两列：左侧候选，右侧投票说明/状态/CTA。

### 4.2 Console Shell（`/ops/*`、`/studio/*`、`/live/*`、`/judge/*`、`/join/*`、登录）

Console 是新壳，不复用 Portal 的 hero 骨架：

```text
┌──────────────────────────────────────────────────────────────┐
│ Topbar 56px：品牌 / 活动切换 / 当前 section / 账号             │
├──────────────┬───────────────────────────────────────────────┤
│ Sidebar 240  │ Page header 64–80px（H1 24–28px + actions）    │
│ Ops          │ ┌───────────────────────┬───────────────────┐ │
│ Studio       │ │ Main column           │ Rail 360px        │ │
│ Live         │ │ 表格 / 表单 / 工作区  │ 状态 / 快捷操作   │ │
│ Judge        │ │                       │ sticky            │ │
│              │ └───────────────────────┴───────────────────┘ │
└──────────────┴───────────────────────────────────────────────┘
```

- 内容最大宽度 1440px，左右 24px gutter；侧栏 240px，固定，不随内容滚动。
- Topbar 保留品牌 AF 标记，副标题按当前 surface 变化（Ops / Studio / Live / Judge），不再统一写“赛果公示”。
- 页面 H1 24–28px，H2 18–20px；正文 14–15px；标签 12px；行高 1.45–1.55。
- 卡片：`#0f1014` 表面、1px `rgba(255,255,255,.08)` 边框、10px 圆角；不使用 `backdrop-filter`、不用 30/90 大阴影；只有弹层/抽屉使用阴影。
- 表格：表头 12px、行高 44–48px、sticky header、hover 行、操作列固定右侧、工具栏（搜索/筛选/状态）在表格上方。
- 表单：≥1024px 两列；label 12px；输入高度 40–44px；错误文案在字段下方，不用全局 alert 堆叠。
- 按钮：primary / secondary / ghost / danger / icon 五种；高度 36 或 40；不使用浏览器默认按钮。
- 状态：统一 Badge，语义色由 token 提供（success / warning / danger / info / neutral），不再每个页面硬编码十六进制。

## 5. Console 布局规格

### 5.1 视口与断点

| 视口 | 行为 |
|---|---|
| ≥1440 | 240 sidebar + 12 列内容（最大 1440），主列 + 360 rail |
| 1200–1439 | 220 sidebar；rail 340；保持主列 + rail |
| 1024–1199 | rail 移到主列下方，成为 2 列卡片网格 |
| 768–1023 | sidebar 收成 64px 图标栏或顶部菜单；单列 |
| <768 | 顶部导航 + 单列；沿用现有手机布局门禁 |

### 5.2 页面骨架

- **Ops 列表**：页头（标题 28px + 新建活动按钮）+ 工具栏（搜索、状态筛选、数量）+ 紧凑表格 + 分页；不要 102px 的“活动”。
- **Ops 详情**：主列（报名表、投票卡、分组卡）+ 右栏（名单状态、活动摘要、快捷操作）；右栏 sticky，主列卡片不自动排布到右栏造成空洞。
- **Studio**：左编辑区 60%（编辑器 min-height 520），右栏 360（Release / Sessions / Guided 摘要）；右栏 sticky。
- **Live**：左侧回合工作区，右侧固定控制栏（session、roster、评委入口）；锁轮/生成排名不因滚动离开视野。
- **Judge**：单列但最大 720，评分表与提交按钮同屏；不做全屏 hero。
- **Join / Registration**：≥1024 两列字段，文件槽整行；表单宽 960–1040，不把 820px 单列放在 1440 屏幕中间。
- **Login**：保留 Portal 的居中卡片（它只有登录一个任务），但不使用 `results-title` 级字号。

### 5.3 表格与长内容

- 所有内部表格加 `overflow-x: auto` 容器，表头 sticky，首列不换行，公开码/ID 等长文本用等宽或 `word-break` 控制。
- 活动列表必须有搜索/筛选/分页，不能依赖页面无限增长；E2E 累积数据已经证明会长到数千像素。
- 操作列固定在行尾，按钮组不超过 2 个直接操作，其余进 overflow 菜单。

## 6. 视觉资产与 token

### 6.1 颜色

保留品牌色，但 Console 增加中性表面与语义状态：

```text
--ink / --ink-soft        页面与卡片中性底
--surface / --surface-2    Console 卡片、输入
--line / --line-strong    1px 边框
--gold / --gold-soft      主操作、active、关键数值（仅此）
--success / --warning / --danger / --info / --neutral
```

禁止在业务组件中新增十六进制色值；所有状态色进 token。

### 6.2 字号

| 用途 | Portal | Console |
|---|---|---|
| Display / Hero | 3.4–8.8rem | 不使用 |
| H1 | 2.8–6.4rem | 24–28px |
| H2 | 1.4–2rem | 18–20px |
| Body | 16–18px | 14–15px |
| Label / Meta | 12–13px | 12px |
| Numeric | Space Grotesk / tabular | 同左 |

Console 中文字体建议使用系统 UI 无衬线（Microsoft YaHei / PingFang / Noto Sans）或随包引入
Noto Sans SC Variable；不要再让中文标题落到 SimSun。

### 6.3 间距、圆角、阴影

- 间距刻度：4 / 8 / 12 / 16 / 24 / 32 / 48。
- 圆角：6（输入/按钮）/ 8（小卡）/ 10（大卡）/ 14（弹层）；不再混用 18–28。
- 阴影：Console 默认无阴影；只有 popover/drawer 使用 `0 16px 40px rgba(0,0,0,.35)`。

## 7. 动效与性能

- Console 不挂载 `AuroraScene`；仅保留 120–180ms 的 hover/状态过渡。
- Portal 的 WebGL 只在 `/` 与 `/results/*`；离开路由即卸载。
- Portal 动画遵守 `prefers-reduced-motion`；Console 不依赖动画传达状态。
- 不使用全屏 `backdrop-filter`；玻璃效果只允许在 Portal 的 1–2 个结果卡上出现。
- 所有首屏数据在 shader 之前可读；Console 不加载 three.js chunk。

## 8. 组件契约

下一轮先建立最小 primitive，再迁移页面：

```text
Button      primary / secondary / ghost / danger / icon
Input       text / number / password
Textarea
Select
Card        surface / header / footer
Table       toolbar / sticky head / row action
Badge       status tokens
Tabs / Segmented
EmptyState / ErrorState
```

规则：

- 页面不得直接写裸 `<button>`、裸 `<input>`、裸 `<select>`。
- class 名只使用 `primary-button` 一套；删除 `button-primary` 等别名。
- 每个 className 必须在 CSS 中有定义，或来自明确的 utility 集合。
- 状态徽章、表格数字、错误文案都走 primitive，不复制样式。

## 9. 验收与门禁

1. **类名覆盖测试**：扫描 `src/**/*.tsx` 的静态 className，与 `global.css`/模块 CSS 对比；未定义即失败。
2. **视觉回归**：Playwright 在 1440×900、1024×768、390×844 三档截取 Ops 列表、Ops 详情、Studio、Live、Vote、Results；只比较布局关键区域，允许字体抗锯齿差异。
3. **布局断言**：关键页面无元素重叠；Console 存在 sidebar、topbar、main、rail；表格有 sticky 容器；按钮高度一致。
4. **可访问性**：正文对比度 ≥4.5:1；可点击目标 ≥40px；焦点环可见；所有表单有 label。
5. **人工 review**：每个迁移页对照第 5、6 节检查，不把“能看见”当作通过。

## 10. 迁移顺序

1. 建立 Console token 与 primitive（不动 Portal 路由）。
2. Console Shell + Ops 列表 / Ops 详情。
3. Studio（编辑器 + 右栏）。
4. Live / Judge（现场控制优先，减少装饰）。
5. Join / Registration / Vote（桌面两列与表单 primitive）。
6. 删除全局 `AuroraScene` 在 Console 路由的挂载；清理未定义 class、别名和 fallback 色值。
7. 最后再对 Portal 做小幅收敛（vote 静态背景、标题只在 hero 使用）。

每一步单独验证，不把“壳搭好了”当作页面完成。

## 11. 非目标与待决

- 不做整体品牌重做；Afterglow 的配色、标志与结果页仪式感保留。
- 不引入大型 UI 框架；primitive 仍由仓库自持，避免第二套设计系统。
- 是否提供浅色主题：本轮不做，先固定深色 Console。
- 中文字体：系统 UI 字体 vs 随包 Noto Sans SC，下一轮实现前二选一；选择会影响构建体积与 FOUT。
- Console 最大宽度 1440 是起始值；如果实际显示器以 1920 为主，可在 token 层调整，不改页面。

## 12. 完成定义

- 内部页面不再出现 `results-title`；Console H1 ≤32px。
- 未定义 className 为 0；裸 button/input 为 0。
- 1440 下 Ops 详情无空列洞、投票卡无重叠；Studio/Live 右栏 sticky。
- 三档视觉回归与布局断言通过。
- 公开 Portal 的 Afterglow 仍然保留，且只在公开路由加载 WebGL。
