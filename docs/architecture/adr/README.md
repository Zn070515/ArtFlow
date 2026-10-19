# Architecture Decision Records

ArtFlow-Plus 的架构决策。状态：`proposed`（规划中）、`accepted`（已采用）、
`superseded`（被替代）。

| ADR | 决策 | 状态 |
| --- | --- | --- |
| [0001](0001-modular-monolith.md) | v2 是模块化单体，Capability 是模块边界 | accepted |
| [0002](0002-typescript-stack.md) | TypeScript Baseline：Node 24 / Fastify 5 / TypeBox / Kysely / pg-boss / React 19 | accepted |
| [0003](0003-postgres-outbox-worker.md) | PostgreSQL 事实源；事务 outbox + pg-boss | accepted |
| [0004](0004-command-event-readmodel.md) | Command / event / Fact·Decision·Snapshot·Projection | accepted |
| [0005](0005-testing-and-golden.md) | 测试金字塔 + golden fixtures + property tests | accepted |
| [0006](0006-legacy-coexistence.md) | Strangler 共存与按切片 cutover | accepted |
| [0007](0007-auth-and-capabilities.md) | 本地会话 + capability token；公开码不是凭证 | accepted |
| [0008](0008-deployment-topology.md) | 单来源、不可变镜像、web/media/realtime 分层 | accepted |
| [0009](0009-capability-model.md) | Capability 是模块边界，Activity 是薄容器 | accepted |
| [0010](0010-opaque-capability-definitions.md) | Capability 定义对 Activity 编译器不透明 | accepted |
| [0011](0011-execution-runtime.md) | durable command、outbox 投影/重放、SSE + HTTP 恢复 | accepted |
| [0012](0012-actor-and-audit.md) | ActorContext 与审计是 command 的标准副产物 | accepted |

新增 ADR 的规则：

1. 一个 ADR 只记录一个决策；不要写成方案综述。
2. 必须写清替代方案和“不选它的原因”。
3. 被替代时保留原文，追加 `Superseded by ADR-xxxx`，不删除历史。
4. 技术 Baseline 已封板：换框架/ORM/测试运行器属于新 ADR，不再重开基础方向。
