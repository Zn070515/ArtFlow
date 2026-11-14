# ArtFlow-Plus：Live 失效提示迁移到实时核心

状态：已确认（2026-10-27）
范围：新增 `activity:<activityId>` 失效主题、Live 页面改用实时模块、删除 SSE 与
`useLiveEvents`、事件游标鉴权测试改写。
非目标：把 Live 完整状态推过 socket、Redis 多实例广播、评委页面传输迁移。

## 背景

M11 引入了 `@artflow-plus/realtime` 与投票卡片，但 Live 控制台仍用 SSE
（`GET /api/activities/:id/stream` + `useLiveEvents`）做失效提示并回退 5s 轮询。
同一仓库里存在两套实时传输，与「单一传输、核心不漂移」的决策冲突。SSE 只被 Live
页面使用；`GET /api/activities/:id/events` 是恢复权威，与传输无关。

## 决策

- **失效主题（已定）**：新增 `activity:<activityId>`；快照是
  `{ lastSequence: number }`，取该活动 outbox 的最大 id，没有事件时为 0。
  `seq = lastSequence`（outbox id 是全局 bigserial，单调）。
- **不推完整 Live 状态（已定）**：Live 状态由 session、rounds、panel、ranking、
  roster 多个聚合拼成，没有天然单调版本号。socket 只做失效提示，收到更新后
  Live 页面回 HTTP 重取；权威仍在 REST。
- **鉴权（已定）**：与 SSE 的 `requireOperationsReader` 一致——
  `studio.manage` / `competition.manage` / `judge.manage`，或 `admin` 角色。
- **删除 SSE（已定）**：删除 `/api/activities/:id/stream` 路由与
  `apps/web/src/hooks/useLiveEvents.ts`；保留 `/api/activities/:id/events`
  与 `requireOperationsReader`。
- **轮询节奏（已定）**：复用 realtime hub 的 1s 轮询；Live 页面在 WS 失效时继续
  5s REST 轮询。SSE 的即时性换取单一传输与核心统一，1s 对 Live 控制台足够。

## 主题契约

```text
topic:       activity:<activityId>
namespace:   activity
parse:       { activityId: rest, aggregateId: rest }
authorize:   permissions has * / studio.manage / competition.manage / judge.manage
             or roles includes admin
snapshot:    { seq: max(outbox.id where activity_id), data: { lastSequence } }
schema:      ActivityEventsSnapshotSchema = { lastSequence: integer >= 0 }
```

- outbox 已有 `outbox_activity_id_idx on outbox(activity_id, id)`，不需要迁移。
- 无订阅时不轮询；有订阅时每秒一次 `max(id)`，索引覆盖。
- 事件内容不进 socket；只剩一个整数。

## 服务端

- 新增 db 读取 `getActivityEventHead(db, activityId): Promise<number>`：
  `select max(id) as head`，空结果返回 0。outbox 的 `id` 是 bigserial，Kysely 返回
  string，必须 `Number(...)` 后再返回。
- `apps/api/src/realtime-topics.ts` 增加 `createActivityRealtimeTopic(db)`；
  `buildApp` 注册 `[createVotingRealtimeTopic(db), createActivityRealtimeTopic(db)]`。
- 删除 SSE 路由；清理它专用的导入与游标辅助函数（`/events` 仍使用
  `readEventsSince` 的部分保留）。

## Web

- `apps/web/src/routes/liveActivity.tsx`：
  - 删除 `useLiveEvents` 导入；
  - `const { fallback } = useRealtimeTopic<{ lastSequence: number }>(`activity:${activityId}`, () => invalidateLiveState())`；
  - 保留 `refetchInterval: fallback ? 5000 : false`。
- 删除 `apps/web/src/hooks/useLiveEvents.ts`。
- Ops 投票卡片与 Live 页面共用同一个 realtime 客户端单例与 socket；
  订阅按主题独立，互不影响。

## 测试

- 主题测试（`apps/api/test/realtime-activity.test.ts` 或并入现有 realtime 测试）：
  - 无事件时 seq 0；
  - 写入事件后 seq 前进；
  - 无权限 actor 被拒绝；operations 权限通过；
  - 快照 schema 通过。
- 事件接口：`apps/api/test/sse.test.ts` 重命名为 `events.test.ts`，保留
  `/events` 游标读取与匿名 401；删除 SSE 流测试与 `/stream` 断言。
- Web：Live E2E（`live-judge.spec.ts`）在迁移后仍通过；必要时把等待超时从默认
  5s 调整到 10s（1s 轮询 + REST 重取）。
- 门禁：`pnpm -C plus run check/test`、`pytest tests/gates`、`check_docs` 全绿。

## 文档

- ADR-0029：Live 失效提示迁移到实时核心，SSE 退役。
- 更新 ADR-0027 的后果段落（Live 不再保留 SSE）。
- roadmap M13；`docs/invariants/realtime.md` 不改（RT-01…08 已覆盖）。

## 出口

1. 仓库内不存在 `useLiveEvents` / `EventSource` / `/stream` 引用
   （用 `grep` 在 `apps/`、`packages/` 确认，排除 node_modules/dist）。
2. Live E2E 通过；`/events` 的鉴权与游标测试保留。
3. 全量门禁与结构门禁全绿。

## 风险

- Live 更新从「即时」变为最多 1s 延迟；对现场控制台可接受，若未来大屏需要更低延迟，
  再单独讨论推送式主题。
- 同一客户端多主题订阅共享一个 socket；某个主题被拒绝不影响其他订阅（核心已按
  主题回 error）。
- 删除 SSE 属于 API 表面收缩；仓库内只有 Live 页面使用，外部消费者未登记。
