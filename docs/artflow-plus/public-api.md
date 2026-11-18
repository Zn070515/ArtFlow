# 公开读 API 与嵌入

状态：2026-11-18
适用：ArtFlow-Plus 的 Portal 公开面
相关：[GOAL.md](../../GOAL.md)、[development-baseline.md](../development-baseline.md)

公开面只读、匿名、按公开码访问。**公开码是定位符，不是授权凭证**；它不能
解锁报名、材料、评委或运营数据。所有响应 `cache-control: no-store`，客户端应按
下面的节奏轮询；需要实时性时优先用嵌入页而不是高频抓取 JSON。

## 端点

| 方法 | 路径 | 用途 | 限流（每浏览器访客） |
| --- | --- | --- | --- |
| GET | `/api/public/events` | 公开活动目录（仅主办方列入的活动） | 60/分钟 |
| GET | `/api/public/events/:publicCode` | 活动站聚合：介绍、内容块、节目单、赛果、参与者（可选） | 120/分钟 |
| GET | `/api/public/activities/:publicCode/current` | 当前/下一个节目（仅 formal） | 120/分钟 |
| GET | `/api/public/activities/:publicCode/voting` | 当前公开投票入口（仅 formal + open） | 120/分钟 |
| GET | `/api/public/vote/:sessionId` | 公开投票会话（仅 formal；不返回计数） | 120/分钟 |
| GET | `/api/public/results/:publicCode` | 正式赛果（active + confirmed + 非 stale） | 120/分钟 |
| GET | `/api/public/schedule/:publicCode` | 公开日程快照 | 120/分钟 |
| GET | `/api/public/programs/:publicCode` | 公开节目单快照 | 120/分钟 |
| POST | `/api/public/activities/:publicCode/feedback` | 闭幕后反馈（`rating` 1–5、`comment` ≤1000） | 10/分钟 |
| POST | `/api/public/tickets/lookup` | 凭入场凭证查电子票 | 30/分钟 |

- 浏览器请求携带稳定、匿名的 `x-artflow-visitor` 头；限流按该值计数，因此场馆
  NAT 下的数百名观众不会共享一个桶。写请求另有每 IP 上限
  （`ARTFLOW_PLUS_PUBLIC_IP_CEILING_MULTIPLIER`，默认 200 倍）。服务端集成
  不发送该头时退回按 IP 计数，应自行控制频率。
- 目录与详情只返回 `active`/`closed`；`draft`/`archived` 一律 404。
- 公开读不返回内部 id、联系方式、报名答案或材料字节；参与者目录需主办方显式开启。
- 赛果只来自正式 release 快照；撤销、superseded 或 stale 的 release 不公开。
- 反馈只接受 `closed` 活动；含隐藏蜜罐字段 `website`，非空时返回成功但不写库。

## 嵌入 widget

```
/embed/<publicCode>
```

一个只读、无站点导航的紧凑卡片：标题/状态、当前与下一个节目、最新赛果前三，
以及跳出到完整活动页的链接。建议：

```html
<iframe
  src="https://artflow.example/embed/SPRING-1"
  title="活动"
  width="360"
  height="480"
  loading="lazy"
  style="border:0;border-radius:12px"
></iframe>
```

生产 Caddy 仅对 `/embed/*` 删除 `X-Frame-Options` 并把 CSP 改为
`frame-ancestors *`；其余路由保持 `DENY` / `'none'`。嵌入页不携带凭据、没有写入口，
只读取与匿名访客相同的数据。Studio 的「公开主页」页可直接复制该 iframe 代码。

## 跨域

公开 JSON 端点没有配置 CORS 通配；浏览器跨域直接 `fetch` 会被同源策略拦截。
展示请用 iframe；服务端集成（无浏览器同源限制）可以直接请求上述端点。若未来需要
浏览器内 JSON 调用，应增加显式的来源白名单，而不是放开 `*`。

## 轮询建议

- 活动目录/详情：60 秒。
- 当前节目与投票入口：15 秒；页面隐藏时暂停。
- 赛果：60 秒或回到前台时刷新；撤销的可见延迟上限约 60 秒。
- 不要用低于 10 秒的间隔抓取；浏览器请求按 visitor 计数，无 visitor 的服务端
  请求按 IP 计数。

## `.ics`

公开活动站提供「加入日历」按钮，浏览器本地生成 RFC 5545 文件；不经过服务端，
也不会把票据或评委凭证带进日历。时间缺失时不显示入口。
