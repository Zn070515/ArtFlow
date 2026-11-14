# ArtFlow-Plus M8a：Web Shell + Portal 公开结果页

状态：视觉方向已确认（2026-10-26，Afterglow）
范围：`apps/web` 前端壳、公开结果页、shader hero、加载/404/空态、响应式与
reduced-motion、组件测试、Playwright E2E。
非目标：登录/Studio/Ops/Live、归档下载、SSR、数据导入、部署拆分（M8e）。

## 视觉方向：Afterglow 余晖

- 深墨底 `#07070A`，香槟金 `#E8B45A`，余烬红 `#C2410C`，骨白 `#F5EFE6`，
  冷色边缘用青/紫做轻微色散。
- 全屏 WebGL 背景：domain-warped FBM 极光 + 指针追光 + film grain + vignette；
  中央偏右一枚缓慢旋转的程序化金属圆环（Fresnel + 金色/余烬渐变）。
- 标题：中文宋体 + 拉丁 display serif（Fraunces）；数据用 Space Grotesk /
  Noto Sans SC。
- 结果：超大 rank 数字、冠军行金属扫光、奖项玻璃 chip；滚动/首屏错峰 reveal。
- 动效克制：只保留首屏、结果浮现、冠军光爆；`prefers-reduced-motion` 时
  不挂载 Canvas，使用静态 CSS 渐变。

## 页面与路由

- `/`：品牌 + 公开码输入（trim，不强制大小写），提交后跳到结果页。
- `/results/$publicCode`：
  - 成功：activityTitle、每个 stage 的 publicTitle/releasedAt、decisions 表、
    awards chips；
  - 404：没有找到该活动的结果；
  - 200 空 results：结果尚未发布；
  - 网络/5xx：可重试错误态。
- 数据源唯一：`GET /api/public/results/:publicCode`；不读编辑字段、不显示
  fingerprint/hash/token。

## 技术结构

```text
plus/apps/web/
├── src/
│   ├── api/public-results.ts
│   ├── components/hero/{AuroraScene,ShaderPlane,ChromeRing}.tsx
│   ├── components/results/{ResultsView,RankRow,AwardChips,states}.tsx
│   ├── components/CodeEntry.tsx
│   ├── routes/{__root,index,results}.tsx
│   ├── styles/{tokens,global}.css
│   ├── router.tsx
│   └── main.tsx
├── test/
├── e2e/
├── vite.config.ts
├── vitest.config.ts
└── playwright.config.ts
```

- React 19.3 + Vite 8.3 + TanStack Router/Query；`@react-three/fiber@9` +
  `three@0.186`；Vitest + RTL + jsdom；Playwright。
- Dev/proxy：Vite `server.proxy` 与 `preview.proxy` 把 `/api` 转到
  `VITE_API_TARGET`（默认 `http://127.0.0.1:3000`），浏览器同源。
- 字体：`@fontsource-variable/fraunces` + `@fontsource-variable/space-grotesk`
  自托管；中文走系统 serif/sans 回退。
- 查询：TanStack Query，404 不重试；`staleTime` 60s。
- SEO：路由挂载后设置 `document.title` 与 meta description；SSR 留给后续。

## 性能与可访问性

- DPR `[1, 2]`；`prefers-reduced-motion` 不创建 WebGL context；Canvas
  `aria-hidden`，所有事实在 DOM 文本/表格中。
- 首屏内容不依赖 shader；shader 加载失败时保留 CSS 渐变。
- 语义标题、表格 caption、focus-visible、错误 `role="alert"`。
- 目标 LCP < 2.5s（本地/CI 不阻塞 E2E）。

## 测试

- Vitest：ResultsView（名次/奖项/空态）、CodeEntry（trim/跳转）、API client
  （404/500）。
- Playwright：种子数据 `E2E-DEMO`；landing → 结果页；未知码 404；
  `emulateMedia({ reducedMotion: "reduce" })` 时无 canvas、静态背景可见；
  页面文本不含 fingerprint。
- E2E 用独立 schema `artflow_e2e`：seed 脚本 `CREATE SCHEMA IF NOT EXISTS` +
  migrate + 固定活动/release；API 3100，Vite 4173，Playwright webServer 启动。
- CI Gates 增加 `web-e2e` job（Chromium + Postgres service）。

## 部署

M8a 只产出 `vite build` 静态产物与 dev/preview 代理；M8e 再接 web 进程角色
与入口切换。`dist/` 不提交。
