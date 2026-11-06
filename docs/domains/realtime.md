# Realtime

## 目的

给产品面一个**通知-only**的实时通道：告诉客户端“有事变了”，让客户端回 HTTP 取
权威状态。它不是第二套数据源，也不是命令通道；socket 断开时所有流程仍能靠 HTTP
完成。

## 核心

`plus/packages/realtime` 是仓库里唯一的 WebSocket 实现：

- `/protocol`：版本化信封、topic 语法、关闭码、限制；服务端与浏览器共享。
- `/server`：Fastify 插件、连接/订阅生命周期、心跳、背压、轮询快照 fan-out。
- `/client`：重连、重订阅、应用层心跳、fallback 标志。

feature 只注册 `RealtimeTopic`（`parse` / `authorize` / `snapshot` / 可选 schema），
不得自己建连接。契约与变更流程见 [`CORE.md`](../../plus/packages/realtime/CORE.md)。

## 主题

| 主题 | 载荷 | seq |
| --- | --- | --- |
| `voting:<activityId>` | 投票场次聚合读（候选、状态、live 计数） | 该活动 vote_session live 投影的最大 outbox 序号 |
| `activity:<activityId>` | `{ lastSequence }` 仅失效游标 | 该活动 outbox 最大 id |

- 订阅时先发完整快照；之后只在 `seq` 增长时推完整快照。
- 票数展示以 live 投影为实时近似；关闭场次后以 M10 tally 为权威。
- Live 控制台收到 `activity:<id>` 更新后重取 REST；socket 不携带 Live 状态。

## 不变量

见 [`docs/invariants/realtime.md`](../invariants/realtime.md) 的 **RT-01…08**：
通知-only、握手鉴权 + 每主题授权、快照先行与单调 seq、有界资源与背压丢弃、
双端心跳、版本封闭、核心独占传输、核心不 import 业务包。

## 领域事件

实时通道不产生领域事件；它只把已有 outbox 事件投影成失效游标。

## v1 证据

v1 的 Django Channels consumers（`realtime/consumers.py`）确立了两条语义：WebSocket
只做通知/在场，不承载业务写；连接时按会话鉴权、按活动/资源授权。v2 保留语义，
把传输、重连与心跳收进单一受保护核心。

## Plus 要求

- 只有 `packages/realtime` 可 import `ws` / `@fastify/websocket`；只有 `src/client`
  与该包测试可 `new WebSocket`（`GATE-REALTIME-CORE-01`）。
- 服务端按订阅主题轮询 `snapshot()`；未来换 LISTEN/NOTIFY 只替换提供者。
- 权限撤销在重连后生效；不中断已建立订阅（明确边界）。
- 单实例轮询投影；多实例广播（Redis）尚未实现。

## 待决问题

- 多实例部署时的共享广播（Redis / PG NOTIFY）。
- 大屏等低延迟场景是否需要一个推送式主题（当前 1s 轮询）。
