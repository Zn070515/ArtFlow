# ADR-0011: 执行运行时 —— durable command、outbox 投影、SSE 与 HTTP 恢复

状态：accepted（2026-10-19）

## 背景

M1/M2 交付了纯领域内核、Capability Registry、Activity Pack 和 HTTP/DB 骨架，但运行时仍然
是“原型壳”：API 状态存在进程内 Map；Execution Session 从未持久化；outbox 没有消费者；
没有投影、重放或断线恢复；scope 冲突只在纯函数测试里成立。M3 必须把新架构的运行时骨架
一次立住，并证明它能承载 v1 的骨架功能，而不是只能跑 competition 特例。

## 决策

### 1. 单一 durable command 写路径

- 所有写命令经 `executeCommand`：同一事务内完成 **receipt claim → 聚合锁 → 领域命令 →
  事实 + outbox → receipt 完成**。
- `command_id` 来自 `Idempotency-Key`；payload hash 覆盖 commandType/activity/capability/
  scope/完整输入。同 id 同 payload 返回原结果；同 id 不同 payload 返回
  `COMMAND_ID_CONFLICT`（CONC-04）。
- Activity/Session id 由 `command_id` 确定性派生，保证并发重试得到同一个 id。
- 锁序固定为 Activity → Session（CONC-02）；锁后重新读取，不用锁前快照。
- `command_receipt.result` 在 claim 时为空，完成后写入原响应；重复请求阻塞在唯一索引上，
  随后重放已提交结果。

### 2. Definition / Session 持久化

- `definition_draft`：唯一可编辑配置面，revision CAS。
- `definition_compiled`：按 draft revision 保存编译结果（opaque capability plans）。compile
  只保存 draft + compiled；release 使用同一 revision 的编译结果，不信任客户端。
- `definition_release`：不可变 release，带 source draft revision；session 以
  `(activity_id, definition_version)` 外键绑定 release。
- `execution_session`：id、activity、release、scope、mode、status、revision、时间戳；
  `UNIQUE (activity_id, scope) WHERE status='running'` 是并发最后一道防线。

### 3. Outbox 是事件日志，不只是投递表

- outbox 补齐 DomainEventEnvelope 字段（event_id、activity_id、aggregate、capability、
  revision、mode、scope、occurred_at）以及 attempts/last_error/dead_lettered_at。
- `id` 同时是事件游标；SSE 与 `GET /events?after=` 共用。
- 事件在业务事务内写入；事件不可变，修正产生新事件。
- 旧 outbox 行在迁移中回填；无法回填的行由 relay 记录错误，不静默丢弃。

### 4. 投影与重放

- `execution_projection` 以 `(activity_id, mode)` 为键，保存 state + last_sequence。
- relay 使用 `FOR UPDATE SKIP LOCKED` 领取事件，按 id 顺序应用；投影更新与
  `published_at` 在同一事务。失败事件增加 attempts/last_error，超过上限进入死信，
  后续事件不得越过失败事件。
- `rebuildExecutionProjection` 从事件日志重放；capability fact 与 engine 事件共享日志，
  但只有 execution session 事件推进该投影的 watermark。
- 权威读（session 列表）读写模型；投影读是最终一致，返回 `lastSequence/headSequence/
  stale`，客户端可用事件游标补齐。

### 5. pg-boss 是调度兜底，不是事实源

- `apps/worker` 用 pg-boss 12 调度 `outbox-relay`（cron 每分钟），并用 250ms 进程内循环
  提供低延迟。
- 两条路径调用同一个幂等 relay；重复唤醒安全。outbox 才是事实源，pg-boss 故障不丢事件。
- pg-boss 使用独立 schema，不进入 Kysely Database 类型。

### 6. SSE 是增强，HTTP 游标是权威恢复路径

- `GET /api/activities/:id/events?after=&mode=` 是断线恢复的权威路径。
- `GET /api/activities/:id/stream` 用 SSE 尾随事件日志（500ms 轮询、15s heartbeat、
  `Last-Event-ID` 支持）。
- SSE 只推送事实事件，不推送“已计算业务状态”；连接失败时客户端回到 HTTP 轮询，写命令
  完全不受影响。
- M3 不引入 Redis/WebSocket 进程；需要双向 presence 时再按 ADR-0008 增加 realtime 角色。

### 7. 测试/彩排/正式是事件与投影的分区

- mode 始终来自服务端 session，客户端不能覆盖。
- 事件与投影按 mode 分区；formal 投影永远不会看到 test/rehearsal 事件。
- `REQUIRE_DB=1` 时数据库测试缺失连接串会让 CI 失败，而不是静默跳过。

### 8. Capability runtime seam

- 每个 capability 通过 registry 注入 compiler；application/worker 不得 import 具体
  capability 文件（结构门禁 GATE-PLUS-BOUNDARY-01）。
- M3 提供 `POST /api/activities/:id/runtime-facts`（仅在 skeleton proof 中启用）作为
  “已注册 capability 在运行 session 上追加事实”的最小 seam；真实命令在 M4-M7 实现。
- 没有为未实现 capability 注册占位实现；缺 capability 继续返回可诊断的拒绝。

## 后果

- API 需要 PostgreSQL；测试通过 schema 隔离并行运行。
- 投影允许最终一致；live 读路径使用权威 session 表，事件游标弥补投影延迟。
- outbox 需要保留/清理策略（M8 前补）；死信需要可见的运维入口。
- 事件日志目前不做不可变触发器；写入路径由 command service 独占，后续可加 DB 约束。
- actor/授权尚未进入事件；M8 认证切片统一加入，避免伪造身份。

## 替代方案

- **进程内状态 + 同步投影**：重启即丢失，无法证明恢复，否决。
- **Redis/BullMQ 作为必需队列**：现场故障会阻塞正确性，违背 ADR-0003，否决。
- **每个请求同步写投影**：把读模型耦合进命令事务，破坏 CQRS 边界，否决。
- **WebSocket 先行**：M3 的恢复语义只需要单向事实流，SSE 更小且天然降级到 HTTP，推迟
  WebSocket 到有 presence 需求时。
