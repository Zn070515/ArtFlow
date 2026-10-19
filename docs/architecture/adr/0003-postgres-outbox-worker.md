# ADR-0003: PostgreSQL 是事实源；事务 outbox + pg-boss

状态：accepted（2026-10-19）

## 背景

v2 需要异步任务（投影、导出、归档、通知、清理），同时不能出现“数据库写成功、
任务丢失”或“任务执行了、数据库没提交”的双写问题。现场部署不应强制依赖 Redis
才能保证正确性。

## 决策

- **PostgreSQL 是唯一事实源**；所有命令在单事务内写业务表与 outbox 事件。
- 异步 worker 使用 **pg-boss**（Postgres-backed job queue）消费 outbox/任务；
  Redis 仅用于实时广播等可降级能力。pg-boss 要求 Node 22.12+/PostgreSQL 13+；
  baseline（Node 24 LTS + PostgreSQL）完全覆盖。
- DB access 统一走 Kysely（ADR-0002），outbox 与业务事实在同一事务内写入。
- 投影（read model）由 outbox 事件驱动，允许最终一致；权威读走写模型/快照。
- 任务幂等：每个命令/任务有稳定 id；重复投递返回同一结果。
- 失败重试有上限与死信；死信可审计、可重放。

## 后果

- 部署只需要一个数据库；Redis 故障不阻塞评分、发布、归档。
- outbox 表需要清理策略；worker 需要可见的积压指标。
- 长事务必须避免；命令边界要小。

## 替代方案

- **Redis 队列（BullMQ）**：正确性依赖 Redis 持久化配置，现场故障时风险高，
  否决为必需依赖。
- **应用内同步执行**：导出/归档会拖住请求，且重试不可靠，否决。
- **外部队列服务**：部署复杂度和网络依赖不适合校内单机，否决。
