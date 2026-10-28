# ArtFlow-Plus 视觉主题家族与 Console 壳设计

状态：**Phase 3 implemented**（2026-10-28；Portal 收敛与主题扩展仍按路线推进）
范围：`plus/apps/web` 的主题 token、Portal / Console 壳、后续页面迁移和验收方式。

相关文档：

- [前端视觉方向](../frontend-design-direction.md)
- [ADR-0034：Portal / Console 壳拆分](../../architecture/adr/0034-portal-console-shell-split.md)

## 1. 决策摘要

ArtFlow-Plus 建立一个名为 **Atmospheres** 的视觉主题家族。主题是语义 token 的 preset，
不是页面各自维护的一组十六进制颜色。

| 产品表面 | 主题 ID | 定位 | 本阶段 |
| --- | --- | --- | --- |
| Portal（首页、公开赛果、投票） | `afterglow` | 深墨、香槟金、极光和结果仪式感 | 保留并收敛现状 |
| Console（Ops、Studio、Live、Judge） | `signal` | 深中性表面、清晰层级、低装饰、操作状态优先 | 首先实现 |
| 后续可选 | `daybreak` | 高亮度、纸张感、长时间后台工作 | 仅记录方向 |
| 后续可选 | `ember` | 活动现场的高强调色版本 | 仅记录方向 |
| 后续可选 | `quiet` | 降低色彩和动效，面向低刺激与无障碍场景 | 仅记录方向 |

`Galaxy` 不作为产品约束。它可以成为未来某一套活动专题皮肤的名字，但不应该成为
基础 Console 的信息架构或 token 命名。

第一阶段只固定路由与壳层的主题绑定，不提供全局主题切换器：

- Portal 固定使用 `afterglow`，避免公开结果页在分享或投票过程中改变品牌语义。
- Console 固定使用 `signal`，避免运营人员在执行活动时误切换影响状态识别的颜色。
- 未来若要开放主题选择，选择对象应是用户偏好或活动专题，不得覆盖状态色和无障碍对比度约束。

## 2. 调研结论

本方案只借鉴公开设计系统的结构性做法，不复制其视觉样式：

1. [Carbon 的主题概览](https://www.carbondesignsystem.com/building-blocks/foundations/themes/overview)
   将主题视为一组可整体替换的 token；角色名称保持稳定，值随主题变化。
2. [Carbon 的颜色指南](https://www.carbondesignsystem.com/building-blocks/foundations/color/guidelines)
   用多级 layer token 表达表面层级，并明确指出硬编码颜色无法可靠支持主题切换。
3. [Material 3 的 color roles](https://m3.material.io/styles/color/the-color-system)
   将 surface、on-surface、primary、secondary 等角色作为组件使用的稳定接口，暗色模式
   也通过角色关系而不是组件自定义颜色实现。
4. [Fluent 2 的 color tokens](https://fluent2.microsoft.design/color-tokens)
   把中性、品牌、状态和通用色拆成 alias token，便于跨组件保持一致的语义。
5. [WCAG 2.2 对比度要求](https://www.w3.org/WAI/WCAG22/Understanding/contrast-minimum)
   正常正文目标为至少 4.5:1，大号文字至少 3:1；状态不能只靠色相传达。

对 ArtFlow 的直接结论：组件只能消费语义 token；表面至少需要 page、surface、surface-raised
三层；状态色要有文字/图标/边框等非颜色提示；Portal 的装饰性资产不能渗入 Console 的
数据工作区。

## 3. 目标与非目标

### 目标

- Portal 与 Console 使用同一品牌标识，但拥有不同的页面骨架、密度和动效策略。
- 主题 preset 可替换而不修改业务组件。
- Ops 先形成真实可用的 Console 壳，随后 Studio / Live / Judge 只迁移布局和 primitive。
- 在 1440×900、1024×768、390×844 三种视口下保持可操作、可读和可回归验证。
- 主题变更不会改变 `success`、`warning`、`danger` 等状态的语义。

### 非目标

- 不重做 Afterglow 的品牌资产和公开结果页信息架构。
- 不引入大型 UI 框架或第二套组件库。
- 本阶段不实现任意颜色的主题编辑器、活动自定义 CSS 或用户级主题商城。
- 不为了主题系统一次性重写所有业务组件；页面迁移按路线逐段完成。

## 4. 主题架构

### 4.1 三层 token

主题 token 分三层，业务组件只允许使用第三层：

```text
primitive  ->  theme  ->  component/semantic

--palette-ink-950       --color-page          --button-primary-bg
--palette-gold-500      --color-surface       --button-primary-fg
--palette-red-500       --color-danger       --badge-danger-bg
```

- **Primitive**：主题内部的色板、字体和基础阴影，不出现在业务 TSX。
- **Theme**：`page`、`surface`、`surface-raised`、`text`、`text-muted`、`line`、
  `accent`、`focus` 和状态角色。
- **Component / semantic**：Button、Input、Card、Table、Badge 等组件的接口。

新增页面不允许写 `#xxxxxx` 或 `rgba(...)` 作为业务样式；特殊品牌图形必须封装在
Portal 组件或主题文件中，并说明使用理由。

### 4.2 核心角色

```text
--color-page
--color-surface
--color-surface-raised
--color-surface-hover
--color-text
--color-text-muted
--color-text-subtle
--color-line
--color-line-strong
--color-accent
--color-accent-strong
--color-focus
--color-success / --color-warning / --color-danger / --color-info / --color-neutral
```

每个状态至少配套：背景、前景、边框和 icon/label 文案。状态显示同时包含文字或图标，
不把红绿差异作为唯一识别方式。

### 4.3 `afterglow` 与 `signal`

`afterglow` 继续映射当前 `--ink`、`--bone`、`--gold`、`--ember` 和 `--cool`，但逐步
由语义角色消费。它保留 Aurora、Fraunces 展示字体和结果页的少量玻璃效果。

`signal` 使用更接近黑灰的 page/surface 层级，暖色 accent 只用于主要操作、当前导航、
关键数字和 focus；默认卡片无大阴影、无 backdrop blur。它使用系统 UI 无衬线和等宽数字，
保证长 ID、状态和表格阅读优先。

示意 token（最终值由实现阶段用对比度检查确定）：

```css
[data-theme="afterglow"] {
  --color-page: var(--ink);
  --color-surface: var(--glass-strong);
  --color-surface-raised: rgba(24, 24, 32, 0.9);
  --color-text: var(--bone);
  --color-text-muted: var(--bone-dim);
  --color-accent: var(--gold);
}

[data-theme="signal"] {
  --color-page: #090b0f;
  --color-surface: #10141a;
  --color-surface-raised: #171c24;
  --color-text: #f3f5f7;
  --color-text-muted: #aab3bf;
  --color-accent: #e8b45a;
}
```

上面的 `signal` 值是方向示意，不是最终验收值；实现时要用实际文字/背景组合测量，并把
结果写入测试或验收记录。

## 5. 壳层与路由绑定

### Portal Shell

覆盖 `/`、`/results/*`、`/vote/*`：

- 继续使用 Afterglow 的品牌 header、公开导航和 footer。
- Aurora 只在首页和结果页挂载；投票页使用静态背景。
- 保留大标题和结果卡片的仪式感，但不把 `results-title` 带到内部页面。

### Console Shell

覆盖 `/ops/*`、`/studio/*`、`/live/*`、`/judge/*`，以及需要工作人员操作的登录/报名工作区：

- Topbar：品牌、当前活动、当前 section、账户操作，目标高度 56px。
- Sidebar：桌面 240px，收窄视口折叠为 64px 或顶部菜单。
- Main：最大宽度 1440px，默认 24px gutter。
- Page header：H1 24–28px，标题旁放页面动作。
- Detail：主列 + 约 360px rail；rail 在窄屏移到主列下方。
- Mobile：顶部导航、单列、可横向滚动的表格容器；不依赖 hover 才能完成操作。

Console 不挂 Aurora，不使用全屏 backdrop blur 或 30/90 级别的装饰性阴影。动效只用于
120–180ms 的状态过渡，不能传达唯一的业务状态。

## 6. 完整路线图

### Phase 1：主题基础与 Ops 壳（本次落地）

1. 将当前 tokens 拆为 primitive 与语义角色，并加入 `afterglow` / `signal` preset。
2. 把 `RootLayout` 拆为路由感知的 PortalShell 与 ConsoleShell。
3. 实现 Console Topbar、Sidebar、页面容器和响应式断点。
4. 先迁移 Ops 列表、Ops 活动详情、Ops 报名详情。
5. 提供最小 primitive：Button、Card、Badge、Input、Table 容器。
6. 加入壳层、主题、布局和无障碍的 web 测试；不改变 API、权限和业务命令。

### Phase 2：Studio

- 编辑区 / release 区 / session 区形成主列 + rail。
- definition editor 的错误、保存、发布状态统一使用 Badge 和 ErrorState。
- 长表单与 JSON/DSL 编辑器不再依赖 Portal 卡片样式。

### Phase 3：Live / Judge

- Live 把回合控制、名单、锁定和发布动作放进固定控制栏。
- Judge 使用最大 720px 的单列评分工作区，评分表与提交动作保持同屏。
- realtime 断开时保留 HTTP 完成路径，连接状态只作为辅助提示。

### Phase 4：Join / Registration / Vote

- Join / Registration 在大屏采用两列表单，文件槽整行。
- Vote 保留公开 Portal 语义，但使用更克制的静态背景和稳定的提交状态。
- 统一表单字段、错误文案、文件状态和移动端键盘可用性。

### Phase 5：Portal 收敛与主题扩展

- 清理 Portal 的硬编码颜色和未定义 class，保留 Afterglow 的品牌资产。
- 基于实际场景决定是否加入 `daybreak`、`ember`、`quiet`。
- 若确实存在用户需求，再增加设置层的 theme preference；不把主题选择暴露在执行关键动作的页面。

## 7. 本次实现的验收标准

- `/`、`/results/*` 仍使用 Portal Shell；`/ops/*` 不再加载 AuroraScene。
- Ops 页面不再使用 `display results-title`；Console H1 不超过 32px。
- 主题值通过 `data-theme` 或等价的壳级绑定提供，Ops 业务组件不新增裸十六进制颜色。
- Console 在 1440px 有 sidebar + topbar + main；在 390px 不出现水平页面溢出。
- Ops 表格存在滚动容器、搜索/筛选位置和稳定的操作区；详情页不出现投票卡重叠。
- 交互目标最小 40px，焦点可见；正常正文和背景组合达到 4.5:1。
- `pnpm -C plus run check`、`pnpm -C plus run test`、相关 Playwright smoke 通过；不跑 v1 全量测试。

## 8. 已确认项与后续边界

已确认本规格中的命名和边界：`Atmospheres` 为主题家族，Portal 为 `Afterglow`，Console
为 `Signal`，本阶段不提供运行时主题切换器。Phase 1 已完成主题 token、双壳、Ops 页面；
Phase 2 已完成 Studio 列表、新建页和活动工作区的主列 + sticky rail 迁移；Phase 3 已完成
Live 主列 + sticky 操作栏与 Judge 720px 单列评分工作区迁移。以上页面迁移只改变布局、语义
class 和 Signal 样式，未改变 authority、realtime 或 HTTP 完成路径。Portal 收敛仍按第 6 节继续推进。
