# 契约测试与消费者故障注入：P0 现状审核

日期：2026-11-11。
范围：`main` / `plus/`（ArtFlow-Plus v2）。
对应任务书：[2026-11-11-contract-testing-program-design.md](../specs/2026-11-11-contract-testing-program-design.md)。
对应计划：[2026-11-11-contract-testing-plan.md](../plans/2026-11-11-contract-testing-plan.md)。

## 1. 结论摘要

1. 现有测试体系基础良好：领域纯函数测试、真实 PostgreSQL 集成测试、API 注入测试、
   Playwright 关键旅程、结构门禁、Golden Fixture 和属性测试都已存在，且
   `REQUIRE_DB=1` 能阻止数据库测试静默跳过。
2. 缺少三样东西：**可查询的 Consumer Graph**、**机器可读的小型 Contract 清单**、
   **可复用的故障注入 seam**。现有规则主要散落在 `docs/invariants/`、各 Capability
   的测试和实现代码里。
3. 任务书列出的六个已知问题在最新代码中**全部仍然存在**，且现有测试均未覆盖其
   缺陷形成机制。逐项证据见 §5。
4. 其中 Capability Manifest 与共享 Schema 的漂移已经可以直接用现有 TypeBox 测试
   复现；Outbox / Live Projection 的一致性问题最隐蔽，影响也最大。
5. 不建议引入 Pact Broker 或新的测试服务。优先复用 Vitest、fast-check、真实
   PostgreSQL、TypeBox、Node 24 与现有门禁目录。注意：`typescript@7.0.2` 是原生
   编译器，不暴露 `createSourceFile` / `createProgram`，Consumer Graph 不能依赖
   TypeScript Compiler API；应使用有界词法扫描 + 显式动态依赖声明，或单独论证
   后再引入解析器依赖。

## 2. 盘点口径

- 统计 `plus/` 下 `apps/` 与 `packages/` 的测试文件，排除 `node_modules` 与构建产物。
- “契约资产”包括领域不变量文档、Golden Fixture、结构门禁、数据库 schema 漂移检查、
  命令回执与 Capability Manifest。
- “消费者”按任务书定义，指代码依赖方，不指业务用户。
- 本轮只做静态审阅与代码路径核对，未运行全量测试；运行时间基线列为 P0 后续动作。

## 3. 现有测试架构

### 3.1 文件与分层

共 **137** 个测试文件：101 个 `.test.ts`、26 个 `.test.tsx`、10 个 Playwright `.spec.ts`。

| 层 | 位置 | 文件数 | 运行方式 | 主要验证对象 |
| --- | --- | ---: | --- | --- |
| 领域单元与属性 | `plus/packages/domain/test/` | 13 | Vitest，无数据库 | 状态机、编译器、Registry、纯命令 |
| 数据库 | `plus/packages/db/test/` | 13 | Vitest + 真实 PostgreSQL，临时 schema | Repository、迁移、schema drift |
| 运行时 | `plus/packages/runtime/test/` | 31 | Vitest + 真实 PostgreSQL | 命令事务、重放、并发、Outbox、投影、Golden |
| API | `plus/apps/api/test/` | 23 | Fastify `inject` + 真实 PostgreSQL | 路由、权限、错误码、CSRF、实时失效 |
| Web 单元 | `plus/apps/web/src/**/*.test.ts(x)` | 41 | Vitest + jsdom | API client、路由面、样式契约 |
| Web E2E | `plus/apps/web/e2e/` | 10 | Playwright，`workers: 1` | 控制台、投票、报名、公开结果 |
| Worker | `plus/apps/worker/test/` | 2 | Vitest | Relay loop 与 Worker 生命周期 |
| Realtime | `plus/packages/realtime/test/` | 3 | Vitest + ws | 协议、Hub、连接、心跳、限流 |
| Contracts | `plus/packages/contracts/test/` | 1 | Vitest + TypeBox | 共享 Schema |

补充事实：

- `fast-check` 已是根 `devDependencies`，领域包有 6 处 `fc.assert` 属性测试。
- `packages/runtime` 与 `apps/api` 的 Vitest 配置均为 `fileParallelism: false`，
  原因是数据库测试各自创建/删除 schema，Kysely migrator 并发内省会互相干扰。
- 数据库测试统一使用 `describe.skipIf(!connectionString)`，并在 `REQUIRE_DB=1`
  且缺少连接串时直接抛错，避免“跳过即绿色”。
- CI 的 `gates.yml` 已运行 `pnpm -C plus run test`、`schema:check`、`build:prod`、
  `tests/gates` 与 Golden；Web E2E 另有独立 job。

### 3.2 已有契约与门禁资产

| 资产 | 位置 | 作用 | 局限 |
| --- | --- | --- | --- |
| 领域不变量 | `docs/invariants/`（AUTH/LIFE/GRP/CONC/SCOR/RES/TICK/ATT/DEPL/RT） | 业务规则与反例形状 | 文档与测试之间没有机器可读映射 |
| Golden Fixture | `tests/golden/`（6 个 JSON） | 实现无关的业务样例 | 主要覆盖 v1 提炼的评分、结果、归档、票据、名单；新 Capability 覆盖少 |
| 结构门禁 | `tests/gates/`（5 个模块） | Capability 边界、Realtime 核心、路由模块、发布产物、跟踪制品 | 只做静态结构检查，不验证运行时消费者行为 |
| Schema 漂移 | `plus/packages/db/test/schema-drift.test.ts` | `types.ts` 与迁移后的 PostgreSQL 对齐 | 只覆盖数据库 schema，不覆盖共享 TypeBox Schema |
| 命令回执 | `plus/packages/runtime/src/command.ts` | receipt + audit + fact + outbox 同事务；重放先于校验 | 重放语义靠各 handler 自觉提供 `onReplay`，已有遗漏 |
| Capability Manifest | `plus/packages/domain/src/registry.ts` 与 `plus/packages/contracts/src/capability-manifest.ts` | 声明 commands/events/permissions/scopes | 两份定义已发生漂移 |
| Realtime 核心 | `plus/packages/realtime/` + `GATE-REALTIME-CORE-01` | 通知-only、版本、鉴权、有界资源 | 异步订阅与关闭竞态未覆盖 |

## 4. Consumer Graph 的可用种子与动态依赖

### 4.1 可以直接从代码提取的种子

| 种子 | 规模 | 价值 |
| --- | ---: | --- |
| Capability 注册 | 11 个 Capability 文件 | dependencies / conflicts / commands / events / permissions / scopes / commandScopes |
| `executeCommand` 调用点 | 70 处，分布在 16 个 runtime 文件 | 命令 → 服务 → 事务边界 |
| `appendEngineEvent` 调用点 | 76 处，分布在 17 个 runtime 文件 | 事实 → 事件 → 投影 / 实时 |
| API 路由模块 | `plus/apps/api/src/routes/` 下按产品面拆分 | HTTP → runtime 服务 |
| Realtime Topic | `plus/apps/api/src/realtime-topics.ts` 的 `voting` 与 `activity` | 投影 → 订阅者 |
| Outbox Relay | `plus/packages/runtime/src/outbox-relay.ts` | 事件 → 执行投影 / 投票 Live 投影 |
| Repository | `plus/packages/db/src/*-repository.ts` | 表级读写与聚合归属 |

### 4.2 静态 `import` 无法完整还原的部分

- `executeCommand` 的 handler 是闭包；command type 与 capability 只在调用参数中
  出现，不一定有对应导出符号。
- `appendEngineEvent` 的事件类型是字符串，事件消费者在 Relay 中按 type 分派。
- Capability 组合由 `packages/domain/src/defaults.ts`、`packs.ts` 与 Registry 在
  运行时组装，而不是由某个文件静态 import 全部 Capability。
- Realtime Topic 的 snapshot 通过函数引用读取投影或 Repository，Topic 名称与数据
  来源之间没有类型级连接。
- Outbox / pg-boss 的消费者是 Worker 进程，跨进程边界。
- 数据库行与 JSON payload 的形状由 Kysely 接口、领域类型和实际 JSON 共同决定。

这些必须在 Consumer Graph 中有显式声明，并在声明缺失时让门禁失败，而不是靠
“静态分析看起来没引用”来推断没有消费者。

## 5. 已知问题复核

| # | 问题 | 最新代码结论 | 现有测试是否覆盖缺陷机制 |
| --- | --- | --- | --- |
| 1 | 归档状态下仍允许不应发生的 Ticket 操作 | **存在** | 否 |
| 2 | Roster 最终确定后仍可产生新 Registration | **存在** | 否，只测了“final 后 review 被拒” |
| 3 | Outbox 消费失败与 Live Projection 恢复不一致 | **存在** | 否，只测了纯投影函数 |
| 4 | Judge Claim 响应丢失后无法恢复凭证 | **存在** | 否，只测了首次领取与席位复用 |
| 5 | Realtime 异步订阅与连接关闭竞态 | **存在** | 否 |
| 6 | Capability Manifest 与共享 Schema 漂移 | **存在** | 否，共享 Schema 测试的样例本身不含新字段 |

### 5.1 归档后仍可执行 Ticket 变更

证据：

- `issueTicket` 与 `redeemTicketCredential` 都调用 `requireActive`：
  `plus/packages/runtime/src/voting-ticket-service.ts:463`、
  `plus/packages/runtime/src/voting-ticket-service.ts:649`。
- `rotateTicketCredential`、`revokeTicket`、`revokeTicketAccessSession`、
  `reissueJudgeCapability`、`closeJudgeEntry` 只检查 `requireCapability`，没有检查
  活动状态：`voting-ticket-service.ts:493`、`:536`、`:732`、`:772`、`:810`。
- 领域不变量明确要求终态不可写，并把“归档后继续写票据”列为必须攻击的形状：
  `docs/invariants/lifecycle.md:105`（LIFE-05）与 `:119`。

失败路径：活动归档后，只要 Ticket 仍处于 `issued`，`ticketing.ticket.rotate`
仍会递增凭证版本并返回一个可用的新凭证；`ticketing.judge_capability.reissue`
仍会递增评委入口版本。归档活动因此可以继续产生新的对外凭证。

修复时需要区分“归档后禁止一切写入”与“关闭后仍允许事故性撤销”。当前实现两者
都没有显式语义。

### 5.2 Roster final 后仍可 start / answer / submit

证据：

- `startRegistration` 只检查 `requireActive` 与 `requireRegistrationOpen`：
  `plus/packages/runtime/src/registration-service.ts:142`、`:162-163`；没有读取
  roster。
- `saveRegistrationAnswer` 同样没有 roster 检查：`registration-service.ts:204`、
  `:228-229`。
- `submitRegistration` 同样没有 roster 检查：`registration-service.ts:273`、
  `:292-293`。
- 只有 `reviewRegistration` 在锁定 roster 后拒绝：`registration-service.ts:366-369`。
- `finalizeRoster` 只写 roster 行，不更新 release 的 registration lifecycle：
  `registration-service.ts:395-437`。
- 领域不变量 LIFE-09 明确把“roster final 后 start/answer/submit”列为攻击形状：
  `docs/invariants/lifecycle.md:188`、`:198-203`。
- 现有测试只覆盖“final 后 review 被拒”：
  `plus/packages/runtime/test/registration-service.test.ts:274`。

失败路径：roster 已 final 后，新参与者仍可 `registration.start` → `answer` →
`submit`。这条 registration 永远无法被 review（review 已冻结），但会作为
submitted 行存在，破坏“final 名单就是最终参与者集合”的语义，也会让 Ops 的
待处理计数与 approvedCount 不一致。

### 5.3 Outbox 失败后 Live Projection 被静默“恢复”

证据：

- Relay 对投票 Live 投影的失败是“记录 block + 继续标记 published”：
  `plus/packages/runtime/src/outbox-relay.ts:178-195`。失败事件在 `:195` 被
  `markPublished`，不会重试。
- 下一个事件成功时会调用 `upsertLiveState`：`outbox-relay.ts:93-99`；
  `plus/packages/db/src/live-state-repository.ts:59-66` 的冲突更新会把
  `status` 改回 `running`，并清空 `blocked_sequence` / `blocked_reason`。
- 读面没有检查 blocked 状态：`plus/packages/runtime/src/voting-read-service.ts:49-69`
  直接使用 `live.state`；`plus/apps/api/src/routes/voting.ts:147-155` 在没有行时
  才返回 `stale: true`，有 blocked 行时按原样返回。
- `rebuildVotingLiveProjection` 存在，但只有测试调用：
  `plus/packages/runtime/src/outbox-relay.ts:239`；
  `plus/apps/worker/src/ops.ts:49-64` 的运维命令只重建执行投影，没有投票 Live
  投影的恢复入口。
- 现有测试只覆盖纯投影函数：`plus/packages/runtime/test/live-projection.test.ts:21`、
  `:36`；Relay 测试只覆盖执行投影的 dead letter：
  `plus/packages/runtime/test/relay.test.ts:75`。

失败路径：`BallotSubmitted` 事件 A 的 Live 投影失败 → 记录 block → A 被标记
published。下一个事件 B 成功 → `upsertLiveState` 清空 block，并把 B 的计数叠加
在缺少 A 的旧状态上。此后读面看到 `status: "running"` 和偏小的票数，且 A 永远
不会自动重放。只有人工调用一个没有 CLI 入口的重建函数才能恢复。

### 5.4 Judge Claim 响应丢失后凭证不可恢复

证据：

- `claimJudgeSeat` 生成随机 `sessionToken` 后，把它从回执中抹掉：
  `plus/packages/runtime/src/voting-ticket-service.ts:891`、`:913-914`。
- 该命令没有提供 `onReplay`：`voting-ticket-service.ts:861-916`。
- 重放路径直接返回已持久化的 `persistedBody`：
  `plus/packages/runtime/src/command.ts:79-85`。
- 对照 `redeemTicketCredential`，它在重放时重新生成 access token：
  `voting-ticket-service.ts:681-686`。

失败路径：事务提交成功但 HTTP 响应丢失，客户端用同一 `commandId` 重试。回执
命中，返回 `sessionToken: null`；席位已经被占用，客户端没有可用凭证，也没有
重新签发入口。现有测试只验证首次领取与后续席位复用：
`plus/packages/runtime/test/judge-entry-reuse.test.ts:183-227`。

### 5.5 Realtime 异步订阅与连接关闭竞态

证据：

- 连接关闭时 `hub.remove(this.id)`：`plus/packages/realtime/src/server/connection.ts:73-76`。
- `subscribe` 在 `authorize` 与 `snapshot` 两个 await 之后，无条件写入本地订阅并
  `hub.add`：`connection.ts:180-203`。期间没有检查连接是否已经关闭。
- 现有 Realtime 测试覆盖未认证、快照、更新、退订、背压与心跳：
  `plus/packages/realtime/test/server.test.ts:104-238`；没有“关闭发生在订阅
  await 期间”的用例。

失败路径：客户端发出 subscribe 后立即断开。`close` 先把 peer 从 hub 移除；
随后 in-flight 的 `subscribe` 继续执行，把 peer 重新加入 hub。`send` 因 socket
不是 OPEN 而 no-op，但 hub 会永久保留这个订阅者并持续轮询快照。每次“订阅中
断线”都可能留下一个幽灵订阅。

### 5.6 Capability Manifest 与共享 Schema 漂移

证据：

- 领域侧的 `CapabilityManifest` 已包含 `commandScopes`：
  `plus/packages/domain/src/registry.ts:42`；实际 Capability 正在使用：
  `plus/packages/domain/src/capabilities/attendance.ts:96`、
  `competition.ts:370`、`publishing.ts:296`、`voting.ts:211`。
- 共享 TypeBox Schema 没有 `commandScopes`，且设置了
  `additionalProperties: false`：
  `plus/packages/contracts/src/capability-manifest.ts:15-34`。
- 共享 Schema 的测试样例也不含 `commandScopes`：
  `plus/packages/contracts/test/contracts.test.ts:231`。

失败路径：任何用共享 Schema 校验真实 Capability Manifest 的调用都会因为
`commandScopes` 是额外字段而失败；同时 TypeScript 无法发现两份独立声明的字段
差异。现有测试只验证少量手写样例，所以一直绿色。

## 6. 缺口与重复建设风险

### 6.1 缺口

1. **没有 Consumer Graph**：无法从 `executeCommand`、事件类型、Schema 或 Realtime
   Topic 反向找到所有消费者。
2. **没有机器可读的 Contract 清单**：不变量、测试断言和实现约束之间靠人工映射。
3. **生命周期测试按 Capability 重复**：registration、competition、publishing、
   grouping、attendance、voting 各自重复“非法边 / revision 冲突 / 终止态”断言。
4. **故障注入是点状的**：已有 Relay dead letter、并发竞争、重放测试，但没有统一的
   故障 seam、可控时钟、延迟/乱序/取消/响应丢失矩阵。
5. **没有“Provider 改了，Consumer 测试必须失败”的机制**：测试通常只从 Provider
   自身行为出发，不证明消费者依赖的契约被破坏。
6. **已有已知缺陷没有复现测试**：见 §5。
7. **Golden 覆盖偏旧**：6 个 fixture 来自 v1 提炼，新 Capability（attendance、
   tasks、grouping）没有同等粒度的实现无关样例。
8. **没有变更影响报告**：CI 失败只能看到具体断言，不能自动回答“哪些消费者受
   影响、违反哪条契约”。

### 6.2 重复建设风险

- 如果为每个 Capability 复制完整生命周期套件，测试量会随 Capability 数量线性增长，
  而真正的新规则只占很小一部分。
- 如果 Adapter 需要模拟大量内部步骤，Adapter 会比业务代码更难维护。
- 如果把所有不变量都塞进一个 TypeBox Schema，会得到无法演进、无法定位失败的
  巨型契约。
- 如果故障注入靠全局开关或随机 sleep，测试会不稳定并污染其他用例。
- 如果 Consumer Graph 只做 import 图，会漏掉 handler 闭包、事件字符串、Registry
  组装和跨进程 Worker，产生虚假的安全感。

## 7. 成本基线

- CI `gates` job 超时 15 分钟，已包含类型检查、全量 Vitest、schema check、
  生产构建、结构门禁与 Golden。
- Web E2E 独立 job 超时 20 分钟，`workers: 1`。
- `runtime` 与 `api` 的数据库测试串行执行；新增数据库用例会直接增加这两个包的
  墙钟时间。
- 本轮未测量本机全量测试耗时；P1 开始前应记录一次基线，作为新套件的预算依据。

## 8. P0 结论

- 不重建测试体系；在现有 Vitest / PostgreSQL / TypeBox / 门禁之上增量建设。
- 先做 Consumer Graph 与 Contract 清单的最小原型，再用六个已知问题检验它是否
  真的能发现缺陷。
- 六个已知问题应作为 P3 的第一批样本；在修复前先提交会失败的复现测试。
- 新增抽象必须通过“能否减少重复、能否发现真实问题、能否保持 CI 成本”三项检验，
  否则不进入 `main`。
