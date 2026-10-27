# Realtime invariants

## RT-01 通知-only

Socket 只承载订阅、退订、心跳；状态变更仍走 HTTP 命令并回读权威。

## RT-02 握手鉴权 + 每主题授权

连接建立时解析会话；每次订阅由 topic 的 `authorize` 判定；不信任客户端提交的
activity/权限字段。

## RT-03 快照先行、完整快照、单调 seq

订阅立即下发快照；更新必须是完整快照；客户端丢弃 `seq <= last`。禁止 delta。

## RT-04 有界资源

32 订阅 / 4 KiB 帧 / 1 MiB 发送缓冲 / 10 次订阅请求每秒；背压丢弃更新，不排队。

## RT-05 心跳

服务端 ws ping/pong；客户端应用层 ping/pong；超时关闭并重连。

## RT-06 版本封闭

信封带 `v`；协议变更升版并同时更新两端。

## RT-07 核心独占传输

只有 `packages/realtime` 可 import `ws` / `@fastify/websocket`；只有 `src/client`
与该包测试可构造 `WebSocket`。

## RT-08 核心对业务无知

`packages/realtime` 不 import domain/db/runtime；业务通过 `RealtimeTopic` 接入。

## 变更流程

修改以上任一条，必须先写 ADR 并更新核心契约测试。业务 PR 不得修改
`packages/realtime` 的连接、重连、心跳、信封实现。
