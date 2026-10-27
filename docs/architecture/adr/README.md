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
| [0011](0011-execution-runtime.md) | durable command、outbox 投影/重放、SSE + HTTP 恢复（SSE 传输由 ADR-0029 取代） | accepted |
| [0012](0012-actor-and-audit.md) | ActorContext 与审计是 command 的标准副产物 | accepted |
| [0013](0013-plus-capability-ownership.md) | Competition 拥有 Evaluation；Voting 对 Ticketing 条件依赖 | accepted |
| [0014](0014-publishing-ownership.md) | Publishing 拥有结果确认与发布 | accepted |
| [0015](0015-archive-package-and-storage.md) | 归档包白名单、本地卷存储、仅正式发布可归档 | accepted |
| [0016](0016-web-shell-and-public-portal.md) | Web 壳、代理与公开结果页 | accepted |
| [0017](0017-cookie-session-and-registration-loop.md) | Cookie 会话、CSRF 与报名闭环 | accepted |
| [0018](0018-studio-guided-expert-and-authority.md) | Studio guided/expert 编辑与变更权限 | accepted |
| [0019](0019-live-console-and-judge-entry.md) | Live 控制台读取模型与 capability 评委入口 | accepted |
| [0020](0020-mode-hardening.md) | 执行模式隔离：分数/选票/排名按 mode 归集 | accepted |
| [0021](0021-legacy-bundle-import.md) | v1 两段式 bundle 导入与对账 | accepted |
| [0022](0022-event-feed-authorization.md) | 运营事件流需要运营权限 | accepted |
| [0023](0023-cutover-topology-and-rollback.md) | 主域名整体替换与首次写入前的回滚边界 | accepted |
| [0024](0024-pack-definitions-and-shapes.md) | Pack 默认 definition 与三类活动验证 | accepted |
| [0025](0025-grouping-capability.md) | 分组是独立 capability；四态生命周期与 append-only 成员 | accepted |
| [0026](0026-vote-result-publishing.md) | 投票结果是 publishing 的一种来源；解耦 competition | accepted |
| [0027](0027-realtime-core.md) | 受保护的单一实时核心（协议/服务端/客户端） | accepted |
| [0028](0028-participant-vote-page.md) | 参与者投票页与公开读；只公开 formal 场次 | accepted |
| [0029](0029-live-realtime-invalidation.md) | Live 失效提示迁移到实时核心，SSE 退役 | accepted |
| [0030](0030-authority-closure.md) | 命令 scope 冻结、结果来源身份与消费失效、读面契约、浏览器不返回 bearer token | accepted |
| [0031](0031-operational-adoption.md) | 历史导入与运营接管分离、按来源消费、公开 selector fail-closed、runtime contract v2 | accepted |
| [0032](0032-semantic-adoption-closure.md) | Adoption Definition 由 bundle 生成、canonical round id、registration lifecycle、媒体桥、语义 readiness | accepted |
| [0033](0033-participant-material-cutover.md) | MaterialCheck 进 bundle、补交 capability、原子材料上传、生产媒体卷、Unicode 路径、128 MiB 传输上限 | accepted |
| [0034](0034-portal-console-shell-split.md) | 公开 Portal 与运营 Console 双壳；品牌 token 共享，页面骨架与动效分离 | proposed |

新增 ADR 的规则：

1. 一个 ADR 只记录一个决策；不要写成方案综述。
2. 必须写清替代方案和“不选它的原因”。
3. 被替代时保留原文，追加 `Superseded by ADR-xxxx`，不删除历史。
4. 技术 Baseline 已封板：换框架/ORM/测试运行器属于新 ADR，不再重开基础方向。
