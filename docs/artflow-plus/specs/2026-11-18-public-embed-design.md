# 公开活动嵌入 widget 设计（Phase 5）

状态：实施中（2026-11-18）
范围：`/embed/$publicCode` 只读 widget、Studio 嵌入代码、公开读 API 文档
前序：`docs/artflow-plus/specs/2026-11-18-public-feedback-design.md`

## 1. 目标

主办方可以把活动嵌入自己的官网/公众号文章/大屏：一个紧凑、只读的活动卡片，
显示标题、状态、当前/下一个节目与最新赛果，并可跳出到完整活动页。公开读 API
与 `.ics` 已在前面阶段就绪，本轮补上文档与嵌入入口。

## 2. 非目标

- 不做跨域 JSON API 的 CORS 白名单；iframe 同源加载页面，第三方服务端仍可直连
  `/api/public/*`（无 CORS 限制）。
- 不做可配置主题、尺寸、字段裁剪或 JS SDK。
- 不做写操作、登录、票务或投票嵌入；widget 只读。
- 不做爬虫级 OG/SSR。

## 3. 决策

### 3.1 独立嵌入路由

新增 `/embed/$publicCode`，不经过 PortalShell（无站点导航/页脚/Aurora），只渲染
紧凑卡片。数据复用 `fetchPublicEvent` 与 `fetchPublicCurrent`（15s 轮询）；
`active` 显示现在/下一个，`closed` 显示最新赛果前三。所有链接 `target="_top"`，
点击跳出 iframe 进入完整活动页。

### 3.2 嵌入头

生产 Caddy 对全站设置 `X-Frame-Options DENY` 与 `frame-ancestors 'none'`。为
`/embed/*` 增加 matcher：删除 `X-Frame-Options`，CSP 改为 `frame-ancestors *`。
嵌入页只读公开数据、无凭据、无写入口，允许任意站点嵌入是有意为之；其余路由保持
禁止嵌入。

### 3.3 Studio 嵌入代码

公开资料编辑页增加「嵌入代码」卡：根据当前 origin 与公开码生成
`<iframe src="…/embed/CODE" …>`，提供复制按钮。代码是静态文本，不执行、不注入。

### 3.4 公开读 API 文档

新增 `docs/artflow-plus/public-api.md`，列出 `/api/public/*` 的只读端点、限流、
缓存语义与嵌入方式；明确公开码是定位符不是授权凭证。

## 4. 生命周期与可见性

- `draft`/`archived` 的嵌入页与详情一致：404 占位，不显示活动数据。
- `active` 显示现在/下一个；`closed` 显示赛果；两者都不显示投票入口。
- 嵌入页轮询 `current` 15s，页面隐藏时暂停；失败保留上次数据并显示细提示。
- 嵌入代码在归档活动上仍可复制，但链接会 404；Studio 预览保持只读。

## Test architecture

契约：复用 `PublicEventSite`/`PublicCurrentProgram` 读模型，不新增 API 契约或表。
消费者：`/embed/$publicCode`、Studio 嵌入代码卡、公开 API 文档；新增一个 web 路由，
不新增 API route/event/topic。生命周期：draft/archived 404；active 现在/下一个；
closed 赛果；轮询失败保留旧数据；嵌入页无 PortalShell。适配器：无新增；页面用可控
fetch 组件测试，真实数据由现有公开读测试覆盖。故障：无数据/404 显示占位；current
失败保留旧卡；复制失败提示；iframe 链接使用规范 URL。现有测试不够：没有嵌入页、
嵌入代码与 Caddy 嵌入头的覆盖。防臃肿：复用现有公开读与组件模式，不新增后端；嵌入页
与代码卡各一个文件。门禁：`check`、web 测试、`graph:check`、`audit:check`、
`build:prod`、结构门禁、`check_docs`、Playwright 的 embed/mobile/a11y。

## 5. 实施顺序

1. `/embed/$publicCode` 页面与根布局旁路。
2. 嵌入卡片样式与数据轮询。
3. Studio 嵌入代码卡。
4. Caddy `/embed/*` 头例外。
5. 公开 API 文档与测试/门禁。
