# ArtFlow-Plus 目标架构

状态：规划基线（2026-10-19）。决策依据见 `docs/architecture/adr/`。

## 形态

一个模块化单体（ADR-0001），一个 PostgreSQL 事实源，一个公开来源，三个进程
角色（web/media/realtime），按 vertical slice 从 v1 迁移（ADR-0006）。

```text
Browser ──HTTPS──▶ Caddy ──/──▶ web (Fastify + domain)
                         ├─/media/*──▶ media worker
                         └─/ws/*─────▶ realtime worker
                                        │
                              PostgreSQL ◀── outbox ──▶ pg-boss worker
                                        │
                                     Redis (optional pub/sub)
```

## 模块

| 模块 | 负责 | 不负责 |
| --- | --- | --- |
| `platform` | 身份、会话、capability、审计、时钟、ID | 业务规则 |
| `activity` | 活动、阶段、公开入口 | 报名/评分/结果细节 |
| `definition` | 赛制 DSL、编译、冻结、发布版本 | 执行/评分 |
| `registration` | 报名、问卷、材料、审核、名单 | 评分、结果 |
| `evaluation` | 轮次、评委组、表演、分数事实、排名 | 公示、归档 |
| `voting` | 投票场次、选票、成绩组成 | 评分事实 |
| `ticketing` | 票据、凭证、领取、访问会话 | 选手报名 |
| `results` | 候选、核定、release snapshot、撤销/纠错 | 内部录分 |
| `archive` | 归档包、保留、导出、恢复清单 | 在线结果选择 |
| `media` | 受控文件访问、存储适配器 | 业务可见性 |
| `realtime` | 广播、在线状态 | 事实写入 |

## 依赖规则

1. 模块之间只能通过公开 contract（命令/查询/事件）调用；**禁止跨模块查表**。
2. `platform` 不依赖业务模块；业务模块可以依赖 `platform`。
3. 事件是过去式、不可变；消费者不能反向同步调用生产者的写模型。
4. 每个模块有自己的 schema（Postgres schema 或表前缀）与迁移目录。
5. 结构门禁会检查：include 清单、受 guard 的 manager、清单漂移；后续增加
   “模块不得导入其他模块的 persistence”。

## 请求流程（写）

```text
HTTP → 认证/限流 → 解析命令 → 授权 → 打开事务
  → 锁聚合 → 重新读取 + 校验状态/OCC
  → 写业务表 + outbox 事件 + 审计
  → 提交
  → 返回 201/200 + 结果（或 4xx + 领域错误码）
```

- 输入校验在边界（Zod/TypeBox），领域命令再做业务校验。
- 错误码由领域层决定，HTTP 只映射（404/403/409/422），不拼接异常文本。
- 所有敏感命令带 `Idempotency-Key`（command_id）。

## 请求流程（读）

- 公开/列表/导出消费 **read model**（由 outbox 投影）。
- 权威转换的历史读只读 snapshot（release/archive）。
- 同一个事实只能有一个 selector；selector 是模块公开的查询，不在页面里拼条件。
- 读模型允许最终一致；发布/撤销后的“立即读到自己”通过版本号或直接读 snapshot
  解决。

## 数据所有权

| 数据 | 所有者 | 其他模块 |
| --- | --- | --- |
| Activity / Phase | activity | 只读 contract |
| Definition / Release | definition | 通过 released version 引用 |
| Registration / Questionnaire / Files | registration | 通过 roster/material contract |
| Score facts / Panels / Rankings | evaluation | 通过 result candidate contract |
| Ballots / Vote sessions | voting | 通过 vote result contract |
| Tickets / Capabilities | ticketing | 通过 access contract |
| StageResult / ResultRelease | results | 公开 read model |
| ArchivePackage | archive | 只读 snapshot |

## 安全边界

- 公开码只定位；写权限必须 capability 或登录身份（ADR-0007）。
- 私有媒体只经 media 模块；对象存储适配器保持私有，签名 URL 短时有效。
- 审计是命令的一部分；日志脱敏 token/联系方式。
- 测试数据与正式数据分离；正式结果/归档拒绝 TEST 活动。

## 部署与可运维性

- 镜像不可变；tag/digest 部署；启动校验 baked SHA。
- 静态产物版本化并替换；所有渲染进程共享 manifest。
- 单来源代理；web/media/realtime 不各自发布端口。
- liveness/readiness 分离；Redis 故障只降级实时能力。
- 备份/恢复按数据库引用的文件清单验证。

## 可观测性

- 每个命令记录：command id、activity、actor、结果码、耗时。
- outbox 积压、投影延迟、死信数量是核心指标。
- 现场模式：健康页与“当前表演/评分门/评委组”状态可一眼看到。
- 审计日志是业务事实，不是调试日志；不写 token、密码、完整联系方式。

## 测试与门禁

- 领域单元 + 属性测试（fast-check）。
- Golden fixtures：v1 与 v2 共用。
- Contract tests：模块 contract、OpenAPI 错误码。
- 真实 PostgreSQL 双线程并发测试。
- 关键 E2E：扫码、录分、发布、纠错、归档。
- 结构门禁：`tests/gates/`；架构门禁在 v2 代码落地后补“模块导入/表访问”检查。

## 迁移策略

- v1 保持可部署；v2 按 slice 切换入口（ADR-0006）。
- 历史数据通过可重放导入命令进入 v2；导入前后用 golden 校验。
- 每次 cutover 有回滚开关与验证报告；删除 v1 代码前先证明没有入口指向它。
