# ArtFlow-Plus 设计 Token 与响应式基础设计

状态：方向已确认，规格待 review（2026-11-12）

相关：[前端视觉方向](../frontend-design-direction.md)、
[主办方工作台设计](2026-11-12-organizer-workspace-experience-design.md)。

## 1. 目标

前端视觉方向已经固定为 **Portal 三维舞台 + Console Apple HIG 安静模式**，字体组合和动效原型已经确认。当前缺的不是页面稿，而是让这些页面能够被一致地做出来、并且能被后续移动端适配复用的底座。

本设计把现有样式收敛为两层 token（primitive + semantic），建立最小 primitive 组件契约，并固定 390 / 768 / 1024 / 1440 四档响应式规则。移动端不是第二套设计，而是同一套 token 的第二套布局规则。

完成后：

1. 组件不再各自发明字号、间距和圆角；
2. 主题只替换 semantic 别名，不复制组件样式；
3. Console 能在浅色 `paper` 与深色 `graphite` 之间切换；
4. Portal 保留 `afterglow`，并且只加载 Portal 所需的字体与 WebGL；
5. 移动端适配只改布局与动效强度，不改 token 含义。

## 2. 现状证据

2026-11-12 对 `plus/apps/web/src` 的实测：

| 维度 | 现状 | 问题 |
|---|---|---|
| 字号 | 36 个不同 `font-size` 值（0.62–8.8rem，含 11 个 `clamp()`） | 没有字阶，11–12.5px 之间挤了五个值 |
| 间距 | 没有 `--space-*`；`gap` 16 种、`padding` 25 种 | 10/12/14/18/20 同时存在，视觉上无法区分 |
| 圆角 | 8 种（6/8/10/12/14/999/`calc(...)`/50%） | 圆角不表达层级 |
| 阴影 | `--shadow: 0 30px 90px`，另有 `16px 0 40px` | 单一重阴影，没有“只有浮层才抬起”的规则 |
| 颜色 | 三套主题各 21 个 semantic，但 primitive 与 semantic 混写 | `--gold` 在 `violet` 里被改成紫色，语义被塞进 primitive |
| 硬编码 | 19 处 hex 在 TSX；109 处组件直接引用 `--gold`/`--bone`/`--ink` | 主题切换与重构都会断 |
| 字体 | `Fraunces` / `Space Grotesk` 已随包，但中文回退到系统字体 | 中文标题落到微软雅黑粗体，字重不受控 |

这些不是审美问题，是“每个组件自己发明一个值”。本设计要把刻度变成机制，而不是靠评审记住。

## 3. 方案与边界

### 3.1 选择的方案

采用**两层 token**：

```text
primitive（原始值：颜色、间距、字号、圆角、时长）
        ↓ 只允许 semantic 引用
semantic（角色：page/surface/text/accent/space/text/radius/...）
        ↓ 只允许组件引用
component（页面与组件）
```

不建立 component token 层。组件只在确实偏离 semantic 时使用局部变量，并把变量留在组件文件内；不进入全局 token 表。Atlassian 的 37,000 个 token 主要来自组件层，这是明确的反例。

### 3.2 非目标

- 不新增数据库表、迁移、API route、command、event 或 realtime topic。
- 不重做 Studio/Ops/Live/Portal 的业务规则；本次只改样式与组件语法。
- 不一次性重画所有页面；按第 9 节顺序逐页迁移。
- 不引入大型 UI 框架或第二套设计系统；primitive 由仓库自持。
- 不把 Portal 的 WebGL 资产加载到 Console。
- 不在本次实现 3D、粒子、流体等页面级动效编排；这些属于 Portal 动效规格，token 层只提供时长与缓动。

## 4. Token 定义

### 4.1 字阶（8 级）

| Token | 值 | 用途 |
|---|---|---|
| `--text-1` | 12px | caption、表格表头、辅助信息 |
| `--text-2` | 14px | 次要正文、表格行、按钮小号 |
| `--text-3` | 16px | 默认正文、输入、表格主行 |
| `--text-4` | 20px | 小标题、卡片标题 |
| `--text-5` | 24px | 页面 H2、面板标题 |
| `--text-6` | 32px | Console H1、Portal 次标题 |
| `--text-7` | 48px | Portal 展示标题 |
| `--text-8` | 64px | Portal 大标题 |

Portal hero 允许一个语义别名 `--text-hero: clamp(3rem, 7vw, 4rem)`；它不是新的刻度，只是第 7–8 级之间的流体表达。Console 不使用流体字号。

行高：

| Token | 值 | 用途 |
|---|---|---|
| `--leading-tight` | 1.1 | 展示标题 |
| `--leading-ui` | 1.45 | 表格、按钮、单行 UI |
| `--leading-body` | 1.65 | 中文段落 |

字重：

| Token | 值 | 用途 |
|---|---|---|
| `--weight-regular` | 400 | 正文 |
| `--weight-medium` | 500 | 强调、按钮 |
| `--weight-semibold` | 600 | 标题 |

中文不再依赖伪字重：Noto Sans SC Variable 与 Noto Serif SC Variable 提供 100–900 真实轴。

### 4.2 间距（8 级）

| Token | 值 |
|---|---|
| `--space-1` | 4px |
| `--space-2` | 8px |
| `--space-3` | 12px |
| `--space-4` | 16px |
| `--space-5` | 24px |
| `--space-6` | 32px |
| `--space-7` | 48px |
| `--space-8` | 64px |

规则：

- 所有 `padding`、`gap`、`margin` 只能使用这 8 个值；`0`、`1px`（hairline）、`2px`（焦点环）例外。
- 不再出现 10/14/18/20px 这类孤立值。
- 页面级纵向节奏只使用 `--space-7`、`--space-8`。

### 4.3 圆角（5 级 + pill）

| Token | 值 | 用途 |
|---|---|---|
| `--radius-1` | 4px | 小 chip、行内标记 |
| `--radius-2` | 6px | 按钮、输入、下拉 |
| `--radius-3` | 8px | 小卡片、表格容器 |
| `--radius-4` | 12px | 大卡片、面板 |
| `--radius-5` | 16px | Portal 媒体面板、弹层 |
| `--radius-pill` | 9999px | 状态药丸、浮动 CTA |

### 4.4 阴影与层级

| Token | 值 | 用途 |
|---|---|---|
| `--shadow-hairline` | `inset 0 0 0 1px var(--color-line)` | 默认卡片边界 |
| `--shadow-float` | `0 16px 40px rgba(0,0,0,.35)` | 仅 popover / drawer / dialog |

默认不使用投影。层级由 surface 阶梯、hairline 和字号字重表达，不靠阴影堆叠。

### 4.5 动效

| Token | 值 | 用途 |
|---|---|---|
| `--duration-fast` | 120ms | hover、按下、焦点 |
| `--duration-base` | 180ms | 展开、抽屉、状态切换 |
| `--ease-out` | `cubic-bezier(.2,.8,.2,1)` | 所有 UI 过渡 |

规则：

- 只动画 `transform` / `opacity`。
- 不使用 bounce / elastic 作为主要转场。
- 所有动画必须被 `@media (prefers-reduced-motion: reduce)` 关闭或降为瞬时。
- Portal 的 WebGL 编排不进入 token 层；Console 不加载 three.js。

### 4.6 颜色

Primitive 使用 OKLCH，按 50–900 命名；semantic 只引用 primitive：

```text
--p-neutral-0 … --p-neutral-900
--p-accent-500 / --p-accent-600
--p-success-500 / --p-warning-500 / --p-danger-500 / --p-info-500
--p-warm-500（Afterglow 香槟金）
```

Semantic 角色固定为 17 个：

```text
--color-page
--color-surface
--color-surface-raised
--color-surface-hover
--color-line
--color-line-strong
--color-text
--color-text-muted
--color-text-subtle
--color-accent
--color-accent-contrast
--color-focus
--color-success
--color-warning
--color-danger
--color-info
--color-neutral
```

组件不得直接引用 `--p-*`；主题不得改写 `--p-*`；主题只改 semantic 别名。

## 5. 主题

| 主题 | 使用面 | 默认 | 说明 |
|---|---|---|---|
| `paper` | Console | 是 | 浅色 parchment，Apple HIG 安静模式 |
| `graphite` | Console | 否 | 深色，近黑 surface 阶梯 |
| `afterglow` | Portal | 是 | 深墨底、香槟金、展示衬线 |

- `violet` 与 `signal` 退役；`violet` 的取色合并进 `afterglow`，`signal` 改名为 `graphite`。
- 主题通过 `data-theme` 应用；用户选择写入本地偏好，未选择时 Console 用 `paper`，Portal 用 `afterglow`。
- 主题切换只允许改变 semantic 别名，不允许改变布局、字号、间距或组件结构。
- 每个主题必须通过 4.5:1 正文对比度与 3:1 大字号对比度测试。
- 主题切换不重新挂载 WebGL；Portal 的 Canvas 在主题切换时继续运行。

## 6. 字体与加载

### 6.1 字族

| Token | 字族 | 使用面 |
|---|---|---|
| `--font-body` | Inter Variable + Noto Sans SC Variable | Console 正文、Portal 正文 |
| `--font-ui-display` | Inter Variable + Noto Sans SC Variable | Console 标题 |
| `--font-display` | Instrument Serif + Noto Serif SC Variable | Portal 展示标题 |
| `--font-mono` | JetBrains Mono Variable | 编号、公开码、代码 |

规则：

- 拉丁优先、中文兜底；`lang="zh-CN"`。
- 中文正文 16px、行高 1.65；表格行 14px、行高 1.45。
- 字距：正文 0；中文标题 0–0.02em；禁止负字距。
- 数字列使用 `font-variant-numeric: tabular-nums`。
- 中文不使用斜体、`text-transform: uppercase` 或 `word-break: break-all`。
- 混排使用 `text-autospace: ideograph-alpha ideograph-numeric`。

### 6.2 加载策略

- 自托管 Fontsource 包，不走外部 CDN。
- 中文使用 `unicode-range` 分片，浏览器只下载页面实际用到的字块。
- `font-display: swap`，并用 `size-adjust` / `ascent-override` / `descent-override` 做度量匹配 fallback；Safari 不支持 ascent/descent override，但支持 `size-adjust`。
- 只 preload 2 个关键字面：Inter 拉丁、Instrument Serif。
- `Noto Serif SC` 与 `Instrument Serif` 只在 Portal 路由加载；Console 不加载展示字族。
- 首屏字体预算 ≤300KB；最多三个字族（正文、展示、等宽）。
- 字体加载失败时使用系统中文栈，不阻塞首屏内容。

## 7. Primitive 组件契约

新增 `plus/apps/web/src/components/ui/`，页面不得直接写裸控件：

| 组件 | 变体 / 尺寸 | 必须覆盖的状态 |
|---|---|---|
| `Button` | primary / secondary / ghost / danger / icon；32 / 40 | hover、active、focus-visible、disabled、loading |
| `Input` | text / number / password；40 | focus、error、disabled、readonly |
| `Textarea` | 默认 / 自动增高 | focus、error、disabled |
| `Select` | 原生语义包装 | focus、error、disabled |
| `Card` | surface / header / footer | 默认、hover（仅可点击时） |
| `Table` | toolbar / sticky head / row action | loading、empty、error、hover、选中 |
| `Badge` | success / warning / danger / info / neutral | 文字 + 颜色双重表达 |
| `EmptyState` | 默认 / 带操作 | — |
| `ErrorState` | 重试 / 返回 | — |
| `Tabs` / `Segmented` | 默认 / 紧凑 | active、focus、disabled |
| `Dialog` / `Drawer` | 默认 | 焦点陷阱、ESC、遮罩、滚动锁定 |
| `Toolbar` | 搜索 / 筛选 / 计数 | 默认、禁用 |

规则：

- 页面不得直接写裸 `<button>`、`<input>`、`<select>`、`<textarea>`。
- 每个 className 必须在 CSS 中有定义，或来自明确的 utility 集合。
- 状态不能只用颜色表达；Badge 与错误文案必须带文字。
- 可点击目标 ≥40px；移动端 ≥44px；焦点环始终可见。
- Dialog / Drawer 是唯一默认使用 `--shadow-float` 的组件。
- 新增 primitive 必须在 token sheet 中展示三套主题与全部状态。

## 8. 响应式基础

断点：

| 名称 | 宽度 | 主要变化 |
|---|---|---|
| mobile | <768 | 单列；侧栏收为顶部导航；表格变卡片行 |
| tablet | 768–1023 | 主列 + 折叠 rail；表单单列 |
| desktop | 1024–1439 | 侧栏 240；主列 + 360 rail；表单两列 |
| wide | ≥1440 | 内容最大 1440；rail 360；不无限拉伸 |

Console：

- ≥1024：240px 侧栏 + 主列 + 360px rail；rail sticky。
- 768–1023：侧栏收为 64px 图标栏或顶部菜单；rail 落到主列下方。
- <768：顶部导航 + 单列；表格用卡片行（字段名 + 值），操作收进 overflow 菜单。
- 工具栏在表格上方；搜索、筛选、计数不换行到两行。

Portal：

- 标题使用 `--text-hero`；<480 时 CTA 全宽。
- 3D 场景：≥1024 全效果；768–1023 降低 DPR、关闭 Bloom；<768 默认静态 poster 或低粒子版本。
- `prefers-reduced-motion` 与低端设备使用静态图，不阻塞内容。
- 使用 `100dvh` 和 `env(safe-area-inset-*)`；hover 只在 `@media (hover: hover)` 下启用。

Vote / Join / Login：

- 投票页 ≥1024 两列（候选 + 状态/CTA），<1024 单列。
- 报名表 ≥1024 两列字段，文件槽整行；<1024 单列。
- 登录保持居中卡片，不使用 Portal 展示字号。

## 9. 迁移顺序

1. **Tokens**：重写 `tokens.css`，引入 `@layer tokens, base, components, utilities`；加入 8/8/5 刻度、三套主题、语义别名；删除 `--ink`/`--bone`/`--gold`/`--ember`/`--cool` 的组件级引用。
2. **Base**：reset、排版、焦点环、reduced motion、字体加载。
3. **Primitive**：建立 `components/ui/`；先用 Ops 活动列表作为唯一试点页面，验证 Button/Input/Table/Badge/Toolbar。
4. **Console 页面**：Ops → Studio → Live → Judge → Workspace；每页迁移后删除旧 class 与别名。
5. **Portal 页面**：Results → Vote → Login → Join；保留 Afterglow；展示字体只在 Portal 路由加载。
6. **移动端**：390 / 768 两档逐页验收；表格卡片化、侧栏折叠、3D 降级。
7. **清理**：删除未定义 class、未使用 token、旧的 `button-primary` 别名和 fallback hex。

每一步单独提交、单独验证；不把“token 文件写好了”当作页面完成。

## 10. Test architecture

### Contracts and capabilities

本阶段只改 Web 表现层，不新增或修改 capability descriptor、command、事件或共享 contract。触及的读取表面是 activity、registration/operations analytics、studio、competition/live、publishing 的现有 DTO；它们继续由各自 runtime service 提供事实。token 与 primitive 不解释业务规则。

### Consumers, read models, routes, events and topics

所有 Web 路由都是消费者；本阶段不新增 API route、read model、event 或 realtime topic。`graph:check` 必须保持零 unresolved edge。新增的 primitive 不是 consumer；token sheet 是开发期页面，不进入生产导航。

### Lifecycle, terminal guards and mode isolation

本阶段不发出生命周期命令，因此不增加 lifecycle edge 或 terminal guard。`test`、`rehearsal`、`formal` 的区分仍由既有 DTO 承担；样式迁移不得合并或隐藏 mode。主题切换只影响表现，不影响任何 authority。

### Adapters and integration seam

不新增 contract adapter。组件测试在 `apiFetch` 边界注入 DTO；浏览器 journey 继续使用真实 API 与 `artflow_e2e` schema。token 与 primitive 不进入 `tools/contracts` 的 harness。

### Fault injection and recovery assertions

至少覆盖：

1. 字体加载失败或超时：回退到系统中文栈，首屏内容仍可读，恢复后不重排关键布局。
2. WebGL 不可用：Portal 显示静态 poster，Console 不受影响；WebGL 恢复后不需要刷新页面。
3. `prefers-reduced-motion`：所有动画降为瞬时，内容与状态不丢失。
4. 主题切换：三套主题切换后布局不位移；无效主题名回退到默认主题。
5. 缺失 token：引用未定义 `var()` 时契约测试失败，而不是静默回退。
6. 小屏 + 长内容：表格卡片化后字段不丢失，操作仍可触发。
7. 焦点与键盘：Dialog/Drawer 焦点陷阱、ESC 关闭、焦点返回触发元素。

每个故障断言故障期间可见状态与恢复后的最终状态；使用可控的加载/时钟 seam，不使用任意 sleep。

### Why existing tests are insufficient

现有测试按 surface 断言若干 class 是否存在，没有验证“字号/间距/圆角是否来自同一刻度”，也没有全局类名覆盖、主题对比度和三档视觉回归。单个页面的快照全绿，仍可能让 36 个字号继续增长。移动端目前只有零散的小屏断言，没有表格卡片化、侧栏折叠和 3D 降级的统一验收。

### Anti-bloat decision

- 只建两层 token，不建 component token。
- 只建一套 primitive，不按页面复制组件。
- 只建一个 token sheet 与一个 token 契约测试；不为每个页面新增 style-contract 测试。
- 视觉回归复用现有 Playwright 配置与 `artflow_e2e` schema，不新增第二套浏览器栈。
- 不引入 Storybook、Tailwind 或大型 UI 框架；token 与 primitive 由仓库自持。

### Focused gates and proof

实现阶段至少运行：

```text
pnpm -C plus --filter @artflow-plus/web test
pnpm -C plus --filter @artflow-plus/web run check
pnpm -C plus --filter @artflow-plus/web build
pnpm -C plus run graph:check
pnpm -C plus run test
pwsh -NoProfile -File scripts/check_docs.ps1
```

并新增：

- `token-contract.test.ts`：扫描 CSS/TSX，拒绝裸 hex、刻度外字号/间距/圆角、未定义 `var()`、未定义 className。
- `theme-contrast.test.ts`：三套主题的正文与大字号对比度。
- Playwright 视觉回归：1440×900、1024×768、390×844 三档；覆盖 token sheet、Ops 列表、Ops 详情、Studio、Live、Vote、Results。
- 移动端布局断言：无横向滚动、无重叠、可点击目标尺寸、表格卡片化字段完整。

完成证据是可执行测试输出与截图差异，不是“页面能看见”。

## 11. 完成定义

1. 生产 TSX 中裸 hex 为 0。
2. 刻度外 `font-size`、`gap`、`padding`、`border-radius` 为 0。
3. 未定义 className 为 0；裸 `<button>`/`<input>`/`<select>`/`<textarea>` 为 0。
4. 三套主题对比度通过，切换不位移。
5. 1440 / 1024 / 390 三档视觉回归通过；移动端无横向滚动。
6. Console 默认 `paper`，可切 `graphite`；Portal 保持 `afterglow`。
7. 展示字族只在 Portal 加载；首屏字体预算 ≤300KB。
8. 无新增 API route、DB 迁移、event 或 topic。
9. token sheet 能展示全部 token 与 primitive 的三套主题、全部状态。

## 12. 风险与待决

- **Noto Sans SC 体积**：全量包约 4.9MB；依靠 `unicode-range` 按需下载，但构建产物会包含全部分片。需要在实现阶段测量首屏实际传输量；若超出预算，改为静态文案子集 + 系统中文兜底。
- **Console 默认主题**：本设计选择 `paper` 浅色；如果现场投影或弱光环境更依赖深色，需要把默认值调整为 `graphite`，但仍保留切换。
- **移动端 3D**：Portal 的全效果仅在桌面；移动端具体降到“静态 poster”还是“低粒子版本”需要在实现时用真机测量，不在本规格中预判。
- **视觉回归稳定性**：字体、GPU 与 Bloom 会让截图有差异；测试需要固定字体、关闭页面动画，并只比较布局关键区域。
- **密度变化**：36 个字号收敛到 8 个会改变现有页面观感；必须逐页对比，不允许一次性替换后只看整体。
- **新增 token 的纪律**：刻度默认闭合；任何新值必须在 spec 中写出理由，否则契约测试拒绝。
