# ArtFlow-Plus：实时核心模块与投票 UI

状态：已确认（2026-10-27）
范围：新增可复用的 WebSocket 实时模块（协议/服务端/客户端）、核心边界与门禁、
投票场次聚合读、Ops 投票卡片（实时票数 + 会话编排 + 投票结果发布）。
非目标：迁移 Live 控制台的 SSE、投票者端页面、票据 UI、现场大屏、导出。

## 背景

v2 的实时通道只有 SSE（`GET /api/activities/:id/stream` + `useLiveEvents`），
Live 控制台用它做失效提示并回退 5s 轮询。投票功能没有 UI；投票 live 投影
（`live_state`，`aggregate_type = 'vote_session'`）已经由 outbox relay 维护，
包含每个 option 的实时票数，但没有任何前端消费它。

投票卡片需要“实时显示票数 + 断线兜底”。与其为一张卡片临时接 socket，先把
WebSocket 做成公共模块，后续任何实时界面都复用同一套协议与客户端；核心传输
实现不允许业务代码改写或绕过。

## 决策

- **模块形态（已定）**：单一 workspace 包 `plus/packages/realtime`，三个入口
  `./protocol`、`./server`、`./client`。服务端与浏览器共享同一份信封与 topic 语法。
- **数据源（已定）**：核心按固定间隔调用 feature 提供的 `snapshot()`（本轮读取
  `live_state` 投影），`seq` 变化才推送。跨进程、无新基础设施；未来换
  LISTEN/NOTIFY 只替换 snapshot 提供者，协议与客户端不动。
- **SSE 去留（已定）**：本轮只新增 WebSocket；Live 控制台的 SSE 保持不动，
  后续单独迁移。
- **通知-only（已定）**：socket 不承载任何业务写。客户端只能 `subscribe` /
  `unsubscribe` / `ping`；所有状态变更仍走 HTTP 命令并回读权威状态。
- **完整快照（已定）**：每次推送都是完整快照，不是 delta；`seq` 单调，客户端丢弃
  `seq <= lastSeq`。因此背压时可以直接丢更新，下一次快照覆盖。
- **核心保护（已定）**：核心连接/重连/心跳/背压/信封校验只有一份实现，位于
  `packages/realtime/src/protocol`、`src/server` 与 `src/client`；业务只注册 topic
  定义。结构门禁禁止包外 import `ws` / `@fastify/websocket` 或 `new WebSocket`。
- **投票卡片范围（已定）**：执行会话编排（voting/publishing）、场次列表与实时票数、
  开启/关闭场次、结果预览、确认、发布。不做投票者页面与票据 UI。
- **发布阶段（已定）**：`getPublishingState` 增加 release 声明的 `stages`，卡片用
  下拉选择，默认 `vote_result`，没有则选第一个。
- **权限（已定）**：场次与投票操作需要 `voting.manage`；结果预览/确认/发布需要
  `result.manage`；执行会话启停需要 `studio.manage` 或 `competition.manage`。
  权限不足的区块直接隐藏。

## 核心不变量（不可篡改）

只有 ADR + `packages/realtime/test` 的契约测试可以修改以下行为：

1. **通知-only**：服务端拒绝任何非 `subscribe`/`unsubscribe`/`ping` 的消息类型。
2. **握手鉴权 + 每主题授权**：连接时解析会话，未认证 close 4401；每次订阅由
   feature 的 `authorize` 判定；不信任客户端提交的 activity/权限字段。
3. **快照先行**：订阅成功立即下发当前快照；之后只在 `seq` 增长时推完整快照。
4. **有界资源**：每连接最多 32 个订阅、单条消息 4 KiB、发送缓冲 1 MiB、订阅速率
   10 次/秒；超限按协议关闭。
5. **心跳**：服务端 ws ping/pong 清理死连接；客户端应用层 ping/pong 检测半开并重连。
6. **版本封闭**：信封带 `v = 1`；未知版本/类型拒绝；协议变更必须升版并同时更新两端。
7. **核心独占传输**：只有 `packages/realtime` 能 import `ws` / `@fastify/websocket`；
   只有 `/client` 能构造 `WebSocket`。
8. **核心对业务无知**：`packages/realtime` 不 import `@artflow-plus/domain|db|runtime`；
   feature 通过注册 `RealtimeTopic` 接入。

## 包结构

```text
plus/packages/realtime/
  package.json            # exports: ./protocol, ./server, ./client
  src/protocol/
    version.ts            # PROTOCOL_VERSION, limits, close codes
    envelope.ts           # TypeBox client/server message schemas
    topic.ts              # topic grammar + RealtimeTarget
  src/server/
    plugin.ts             # createRealtimeServer(fastify, options)
    hub.ts                # subscriptions, poll loop, fan-out, backpressure gate
    connection.ts         # handshake, frame handling, heartbeat, close
  src/client/
    client.ts             # createRealtimeClient (reconnect, resubscribe, fallback)
    backoff.ts            # exponential backoff with jitter (pure)
  test/
    protocol.test.ts
    server.test.ts
    client.test.ts
  CORE.md                 # 核心清单与变更流程
```

- 依赖：`@fastify/websocket@11.3.4`、`ws@8.22.0`、`@sinclair/typebox`。
- 客户端入口不 import 任何 Node 内置；测试使用 Node 24 全局 `WebSocket`。
- React 适配器放在 `apps/web/src/realtime/useRealtimeTopic.ts`（薄层）。

## 协议

**端点**：`GET /api/realtime`（单一 WebSocket 端点，所有功能共用）。

```ts
// client → server
{ v:1, type:"subscribe",   id:"req-1", topic:"voting:act_123" }
{ v:1, type:"unsubscribe", id:"req-2", topic:"voting:act_123" }
{ v:1, type:"ping",        at:1712345678 }

// server → client
{ v:1, type:"hello",        clientPingIntervalMs:25000, pongTimeoutMs:10000, maxSubscriptions:32 }
{ v:1, type:"subscribed",   id:"req-1", topic:"voting:act_123", seq:12, data:{...} }
{ v:1, type:"update",       topic:"voting:act_123", seq:13, data:{...} }
{ v:1, type:"unsubscribed", id:"req-2", topic:"voting:act_123" }
{ v:1, type:"error",        id?: "req-1", code:"FORBIDDEN", message:"..." }
{ v:1, type:"pong",         at:1712345678 }
```

- 两端 TypeBox 校验；未知 `type` 客户端忽略、服务端回 `PROTOCOL_INVALID`；
  畸形帧累计 3 次 close 4400。
- `id`：`[A-Za-z0-9_-]{1,64}`，仅用于关联请求与响应。

**主题**：`<namespace>:<rest>`；namespace `^[a-z][a-z0-9_]{1,31}$`，rest
`^[A-Za-z0-9_.:-]{1,128}$`，总长 ≤ 160。namespace 必须已注册；feature 的
`parse(topic)` 解析出 `{ activityId, aggregateId }`。

**关闭码**：`1000` 正常、`4400` 协议错误、`4401` 未认证、`4403` 禁止/滥用、
`4404` 目标不存在、`4408` 心跳超时、`4429` 超限。

## 服务端

```ts
createRealtimeServer({
  fastify,
  path = "/api/realtime",
  authenticate(request): Promise<ActorContext | null>,
  topics: readonly RealtimeTopic[],
  pollIntervalMs = 1000,
  heartbeatIntervalMs = 30000,
  heartbeatTimeoutMs = 10000,
}): Promise<{ close(): Promise<void> }>
```

- 注册 `@fastify/websocket`（`maxPayload` 4 KiB），只允许一次注册；重复注册抛错。
- 握手：`authenticate` 返回 `null` → close 4401。
- 连接：accept 后发 `hello`；处理 subscribe/unsubscribe/ping；订阅流程
  语法 → 注册表 → `parse` → `authorize` → `snapshot` → 发 `subscribed`。
  订阅失败只回 `error`，不关闭连接。
- Hub：`topic → Set<Connection>`；单一轮询循环，上一轮未完成则跳过；每主题
  snapshot 独立超时 2s、独立 try/catch；`seq > lastSentSeq` 才发 `update`。
- 快照若声明 `schema`，发送前校验；非法数据不发送并记录日志（fail closed）。
- 背压：`socket.bufferedAmount > 1 MiB` 跳过发送（纯函数 `shouldSend` 单测）。
- 心跳：每 30s ws ping；下一次 tick 仍未 pong 则 terminate + close 4408。
- 订阅速率：每连接 10 次/秒；持续超限 close 4429。
- `close()`：停循环、停心跳、所有连接 close 1001。
- 日志只记录 connection id、actorId、topic、错误码，不记录 `data`。

```ts
interface RealtimeTarget {
  readonly topic: string;
  readonly activityId: string;
  readonly aggregateId: string;
}

interface RealtimeTopic {
  readonly namespace: string;
  parse(topic: string): { activityId: string; aggregateId: string } | null;
  authorize(actor: ActorContext, target: RealtimeTarget): Promise<boolean>;
  snapshot(target: RealtimeTarget): Promise<{ seq: number; data: unknown } | null>;
  readonly schema?: TSchema;
}
```

客户端必须等 `hello` 之后再发 `subscribe`；服务端对早到的订阅同样按正常流程处理。

## 客户端

```ts
createRealtimeClient({ url, pingIntervalMs, pongTimeoutMs, maxBackoffMs, onFallbackChange })
client.subscribe<T>(topic, { onSnapshot, onUpdate, onError }): unsubscribe
```

- 惰性建连，一个客户端一个 socket。
- 退避：500ms → 1s → 2s → 4s → 8s → 上限 15s，±20% 抖动。
- 连接打开并收到 `hello` 后重订阅所有活跃主题；`subscribed` 按 id 关联，
  `update` 按 topic 路由；按主题丢旧 `seq`。
- 失败即 `onFallbackChange(true)`；恢复后 `false`。调用方在 fallback 时用 REST
  轮询（5s），REST 仍是恢复权威。
- 心跳：按 `hello.clientPingIntervalMs`（默认 25s）发应用 ping；`pongTimeoutMs`
  （默认 10s）内无 pong 主动关闭并重连。
- 协议版本不符：关闭并停止重连（进入 fallback），避免热循环。
- 回调异常被捕获，不影响连接。

**React 适配**：`useRealtimeTopic<T>(topic, onData)` 返回 `{ fallback }`；
模块级单例客户端 + 引用计数；StrictMode 双挂载安全；回调放 ref。

## 投票集成

**聚合读** `GET /api/activities/:id/voting/sessions`（`voting.manage`）：

```ts
{
  activityId,
  sessions: [{
    id, status: "open" | "closed", mode, revision, candidateCount,
    candidates: [{ optionId, candidateId, ordinal }],
    live: { seq, counts: Record<optionId, number>, lastEventType } | null
  }]
}
```

- 运行时 `readVotingSessionsState(db, activityId)` 不做权限判断；REST 与 topic 各自授权。
- `live` 是非权威实时票数；关闭后仍以 M10 tally 为准。

**实时 topic**：`voting:<activityId>`；`parse` 返回
`{ activityId, aggregateId: activityId }`；`authorize` 要求 `voting.manage`；
`snapshot` 返回上述聚合读，`seq = 该活动所有 vote_session live 投影的最大
lastSequence`，没有任何投影时为 `0`。payload schema
`VotingSessionsSnapshotSchema` 放入 `packages/contracts`，服务端与 Web 客户端共用。

**publishing stages**：`getPublishingState` 增加 `stages`（active release 的
publishing artifact）；没有 active release 时为空数组，旧字段不变。

**卡片**：

```text
投票与发布
├─ 执行会话：voting / publishing  [启动] [关闭]
├─ 投票场次：id、状态、候选数、实时票数（open 时）  [关闭场次]
├─ 开启投票：候选 id 文本域（每行一个）             [开启]
└─ 已关闭场次： [预览结果]
     排名表（名次 / 候选 / 票数 / 百分比）
     阶段下拉（release 声明的 stages）  [确认赛果] [发布结果 + 备注]
```

- 权限不足的区块隐藏。
- 错误码映射成人话：`VOTE_SESSION_NOT_OPEN`、`STALE_RESOLUTION_INPUT`、
  `NO_VALID_BALLOTS`、`RESULT_NOT_CONFIRMED`。
- 不限制同一活动只能有一个开放场次；卡片全部列出，运营自行选择。
- 没有投票者页面与票据 UI；投票仍由现有公开 ballot 接口完成。

## 门禁

`GATE-REALTIME-CORE-01`（新增结构门禁）：

- `packages/realtime` 之外禁止 import `ws` / `@fastify/websocket`。
- 除 `packages/realtime/src/client` 外禁止出现 `new WebSocket`。
- `packages/realtime` 禁止 import `@artflow-plus/domain|db|runtime`。
- 带 synthetic 反例测试，证明门禁会对违规文件失败。

## 测试

- Protocol：信封接受/拒绝、版本不匹配、topic 语法。
- Server（真实 Fastify + ws）：4401、未知 namespace、FORBIDDEN、订阅快照、
  seq 增长推送、旧 seq 不推、退订、畸形帧 4400、订阅超限 4429、心跳超时 4408、
  非法快照不发送、多客户端扇出、`shouldSend` 背压闸门。
- Client（真实本地服务端 + Node 24 WebSocket）：快照/更新、服务端断开后重连并
  重订阅、fallback 切换、ping 超时重连。
- Runtime：聚合读权限与形状、live counts、seq。
- Topic：授权拒绝、snapshot 形状/seq、schema 拦截。
- API：列表路由权限；publishing state 的 `stages` 不破坏旧断言。
- Web 单测：hook fallback 切轮询、topic 变化退旧订新（fake client）。
- Playwright E2E：Ops 启动会话 → 开启投票 → 公开接口投票 → 卡片不刷新显示票数变化
  → 关闭 → 预览 → 确认 → 发布 → 公开结果可见。

## 构建与部署

- 固定 `@fastify/websocket@11.3.4`、`ws@8.22.0`；提交 lockfile。
- API 生产 esbuild bundle 需包含 ws；若出现可选原生依赖告警，显式
  `--external:bufferutil --external:utf-8-validate`。镜像无额外系统包。
- Web 构建不含 Node 依赖。
- **nginx 反向代理必须支持升级**：`plus/apps/web` 的 nginx 配置对 `/api/` 增加
  `proxy_http_version 1.1`、`proxy_set_header Upgrade $http_upgrade`、
  `proxy_set_header Connection "upgrade"`；Caddy 默认支持 WebSocket。
  否则浏览器握手会 400/502，卡片只会一直走 fallback。

## 出口

1. `pnpm -C plus run check` / `run test` 全绿。
2. `uv run pytest tests/gates -q`（含新门禁）、`scripts/check_docs.ps1` 通过。
3. 投票 E2E 通过，且 Live SSE 测试零改动。
4. API bundle 启动并能完成一次 WebSocket 握手。

## 非目标

- 不迁移 Live 控制台到 WebSocket，不删除 SSE。
- 不做投票者页面、票据 UI、现场大屏、导出。
- 不做跨实例广播（Redis）；本轮假设 API 单实例或每实例独立轮询投影。
- 不做权限实时撤销；已建立订阅在重连前继续有效（写入 CORE.md）。

## 风险

- 轮询 `live_state` 带来约 1s 延迟；对现场大屏可后续接 LISTEN/NOTIFY。
- `ws` 进入生产 bundle 需要验证 esbuild 的可选原生依赖处理。
- 多实例部署时每个实例独立轮询，数据一致但负载随实例线性增长。
- WebSocket 经企业代理/微信内置浏览器可能被劫持或断开；客户端必须保持 fallback
  轮询，不能把 socket 当作权威。
