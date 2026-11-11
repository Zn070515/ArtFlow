# 契约测试与消费者故障注入：实施计划

日期：2026-11-11。
范围：`plus/`。
任务书：[2026-11-11-contract-testing-program-design.md](../specs/2026-11-11-contract-testing-program-design.md)。
P0 审核：[2026-11-11-contract-testing-audit.md](../analysis/2026-11-11-contract-testing-audit.md)。

## 1. 总体策略

不新建第二套业务系统，也不一次性重构现有测试。按 P0 → P1 → P2 → P3 → P4 推进，
每阶段必须有独立出口；任何阶段未通过“能否发现真实问题 / 是否减少重复 / CI 成本
是否可控”三项检验，就停止扩展。

优先级顺序由风险与复用价值决定：

1. 先修共享契约的机器可读性（Manifest 漂移），成本最低、立刻能防回归。
2. 再做 Consumer Graph 与 Change Impact，否则后续测试无法按影响范围选择。
3. 然后做 `executeCommand` 的 Contract 与 Adapter 原型。
4. 用六个已知问题验证体系，而不是先铺开所有 Capability。
5. 最后接入 Outbox Relay、Realtime，并推广到其余 Capability。

## 2. P0：现状审核（已完成）

产物：本目录对应的审核文档。

已确认：

- 现有 137 个测试文件与完整分层；
- 6 个已知问题全部仍存在，且现有测试未覆盖缺陷机制；
- 共享 Capability Manifest Schema 已发生真实漂移；
- 现有技术栈已具备 Vitest、fast-check、真实 PostgreSQL、TypeBox 与 TypeScript
  类型检查，不需要新增基础设施。`typescript@7.0.2` 不暴露 Compiler API，因此
  Consumer Graph 使用自写的有界扫描器 + 显式动态依赖声明。

P0 后续补齐项（进入 P1 前完成）：

- 记录一次 `REQUIRE_DB=1 pnpm -C plus run test` 的本机墙钟时间；
- 记录 `pnpm -C plus run check`、`uv run pytest tests/gates -q` 的耗时；
- 把基线写入本文件 §8。

## 3. P1：Consumer Graph 原型

### 3.1 目标

对三条高风险链给出正向与反向消费者列表：

1. `executeCommand`（命令 → 服务 → 事实 / 审计 / Outbox）；
2. Outbox Relay（事件 → 执行投影 / 投票 Live 投影）；
3. Realtime Topic（投影 → WebSocket 订阅者）。

### 3.2 落点

新增一个只用于开发与 CI 的 workspace package：

```text
plus/tools/contracts/
  package.json                 # @artflow-plus/contract-tools, private
  tsconfig.json
  src/graph/
    build.ts                   # 有界 TS 扫描：imports / 调用点 / Manifest 字面量
    schema.ts                  # 节点 / 边类型
    dynamic.ts                 # 动态依赖声明加载与校验
    impact.ts                  # 反向追踪与传递影响
    cli.ts                     # graph / impact / check
  dynamic-dependencies.json    # 无法静态恢复的依赖声明
  test/
    graph.test.ts
    impact.test.ts
```

配置同步：

- `plus/pnpm-workspace.yaml` 增加 `"tools/*"`；
- 新包提供 `check`、`test`、`graph:check`、`impact` 脚本；
- 不把 `plus/tools` 加入任何运行时镜像的依赖闭包；
- 确认 `tsconfig`、`.dockerignore`、Dependabot 与 `pnpm-lock.yaml` 的清单同步。

### 3.3 图模型

节点：

| 类型 | 示例 |
| --- | --- |
| `file` | `packages/runtime/src/voting-ticket-service.ts` |
| `symbol` | `claimJudgeSeat` |
| `capability` | `ticketing` |
| `command` | `ticketing.judge_seat.claim` |
| `event` | `JudgeSeatClaimed` |
| `topic` | `voting:<activityId>` |
| `table` | `judge_session` |
| `route` | `POST /api/tickets/redeem` |

边：

- `imports`：文件级静态 import；
- `calls`：函数调用（优先解析同包符号，无法解析时记 `unresolved`）；
- `invokes-command`：`executeCommand` 调用点的 `commandType`；
- `emits`：`appendEngineEvent` 的 `type`；
- `declares`：Capability Manifest 的 commands/events/permissions/scopes；
- `subscribes`：Realtime Topic 的 `snapshot` 数据来源；
- `reads` / `writes`：Repository 方法到表；
- `serves`：API 路由到 runtime 服务；
- `derived-from`：投影到事件类型。

### 3.4 动态依赖声明

`dynamic-dependencies.json` 必须显式列出：

- command type → handler 文件；
- event type → Relay 消费分支；
- Capability → 注册入口；
- Realtime Topic → snapshot 数据来源；
- Worker 消费的跨进程任务。

每条声明包含 `owner`、`reason`、`source`、`lastReviewed`。门禁规则：

1. 代码中出现新的 `commandType` 或事件类型，但图中没有对应消费者声明 → 失败；
2. 声明指向的文件或符号不存在 → 失败；
3. 声明超过 30 天未复核 → 只警告，不阻塞（避免变成日历门禁）。

### 3.5 命令与产物

```bash
pnpm -C plus --filter @artflow-plus/contract-tools run graph:check
pnpm -C plus --filter @artflow-plus/contract-tools run impact -- --symbol executeCommand
pnpm -C plus --filter @artflow-plus/contract-tools run impact -- --base origin/main
```

产物写入 `.artifacts/consumer-graph.json` 与 `.artifacts/contract-impact.md`，不提交
到 Git；CI 作为 artifact 上传。

### 3.6 出口

- `executeCommand` 能列出 16 个 runtime 服务文件与 70 个调用点；
- `claimJudgeSeat` 的反向追踪能定位到 API 路由、ticketing Capability 声明与
  相关测试；
- 修改 `voting-ticket-service.ts` 的 `claimJudgeSeat` 时，`impact` 能指出
  `packages/runtime/test/judge-entry-reuse.test.ts` 与 HTTP 路由；
- 新增一个未声明的 command type 时，`graph:check` 失败并指出文件与行号；
- 运行时间 < 30 秒，不依赖数据库。

### 3.7 成本

约 2 人日。主要风险是 TypeScript 符号解析的边界；原型允许 `unresolved`，但必须
把 unresolved 数量作为指标，不能静默忽略。

### 3.8 原型结果（2026-11-11）

已落地 `plus/tools/contracts`：

- `pnpm --filter @artflow-plus/contract-tools run check`、`test` 通过；15 个测试。
- `graph:check` 首次运行：1756 个节点、2831 条边、0 个 unresolved、48 条 warning。
- 已验证的反向影响：`claimJudgeSeat` → `POST /api/judge-entry/claim`、`ticketing`
  capability、`JudgeSeatClaimed` 事件；`topic:voting` → `readVotingSessionsState`。
- 动态 seam 已显式声明：`competition.score.*`、`tasks.*` 与 `appendRuntimeFact`
  的运行时事件类型。
- warning 暴露了新的声明缺口，作为 P2/P3 的输入：competition 的多条命令未出现在
  Manifest；`questionnaire.answer` 声明与实际 `registration.answer` 不一致；
  `MaterialContentStored`、`RegistrationSupplement*`、`RehearsalRoundReset`、
  `StageResultMarkedStale` 等事件没有 Manifest 声明。
- 尚未接入 CI（P4）；当前通过包内脚本运行。

## 4. P2：Contract 与 Adapter 原型

### 4.1 目标

先覆盖 `executeCommand`，再覆盖 Outbox Relay，最后覆盖 Realtime。每个 Provider
只声明它真正稳定的边界，不把实现细节固化成契约。

### 4.2 契约落点

机器可读的契约描述放在共享 contracts 包：

```text
plus/packages/contracts/src/contracts/
  common.ts            # ContractId、Version、Consumer 描述
  lifecycle.ts         # 状态集合、合法边、终止态写保护
  transaction.ts       # 原子性、回执、审计、副作用
  authorization.ts     # 权限、actor、scope
  idempotency.ts       # commandId、payload hash、replay
  event.ts             # 事件类型、顺序、分区、去重
  recovery.ts          # 失败恢复与最终状态
  index.ts
```

每个契约都是小型 TypeBox Schema + TypeScript 类型，不包含具体业务字段。例如
Lifecycle Contract 只描述：

- `states`；
- `transitions`；
- `terminalStates`；
- `writeGuards`；
- `expectedRevision` 语义。

### 4.3 测试 Harness 与 Adapter

测试专用 harness 放在 tooling 包，不进入生产依赖闭包：

```text
plus/tools/contracts/src/harness/
  lifecycle.ts
  transaction.ts
  authorization.ts
  idempotency.ts
  event.ts
  recovery.ts
  fault.ts             # 可控故障注入点
  clock.ts             # 可控时钟
  adapters/
    registration.ts
    competition.ts
    publishing.ts
    voting.ts
    ticketing.ts
    attendance.ts
```

Adapter 只提供四类能力：

1. 构造状态；
2. 执行命令；
3. 查询状态；
4. 声明业务特有约束。

Adapter 不复制服务内部步骤，不 mock Repository；数据库测试仍使用真实 PostgreSQL
与临时 schema。

### 4.4 首个 Provider：`executeCommand`

契约测试至少覆盖：

- 同一 `commandId` + 同一 payload → 重放，返回已持久化回执；
- 同一 `commandId` + 不同 payload → 冲突错误；
- 不同 actor 复用 `commandId` → 拒绝；
- handler 抛错 → 不写 receipt、不写 audit、不写事实、不发事件；
- 提交成功但响应丢失 → 重放可恢复消费者需要的响应；
- 审计、事实、Outbox 同事务；
- 并发重试只产生一个事实。

首个 Adapter 选择 `registration`（状态简单、已有测试基础），第二个选择
`ticketing`（凭证与重放语义最敏感）。

### 4.5 故障 seam

不把故障开关散落到生产代码。优先使用：

- handler 依赖注入（Repository / storage / clock）；
- 在测试中包裹 `executeCommand` 的 handler；
- 在数据库层用真实约束制造唯一冲突；
- 在 Relay 测试中注入一个会抛错的事件 payload；
- 在 Realtime 测试中用 deferred Promise 控制 authorize / snapshot 的完成顺序。

### 4.6 防止 Adapter 膨胀

硬约束：

- 单个 Adapter ≤ 150 行；
- 生命周期模板 ≤ 300 行；
- 不为每个状态写一个独立测试文件；
- 业务特有断言放在 Adapter 的 `specificAssertions`，不复制模板；
- 模板只接受纯数据与命令函数，不 import 具体 Capability 实现。

超过阈值时先拆契约，而不是继续加分支。

### 4.7 出口

- `registration` 通过生命周期、事务、权限、幂等四类契约；
- `ticketing` 通过同一套模板，并额外覆盖凭证重放；
- 删除任意一个 Provider 的关键保证（例如把 receipt 写入移出事务）时，至少一个
  Consumer Contract 失败；
- 新增一个 Capability 的接入成本 ≤ 1 个 Adapter 文件 + Manifest 声明；
- 契约测试运行 < 60 秒（不含数据库迁移）。

### 4.8 成本

约 3 人日。若不满足“新增 Capability ≤ 1 个 Adapter 文件”，停止推广并重新设计
模板。

### 4.9 原型结果（2026-11-11）

已落地：

- 共享契约 Schema：`packages/contracts/src/contracts/` 的 `descriptor`、
  `lifecycle`、`idempotency`、`authorization`、`transaction`、`event`、
  `recovery`。
- 测试 harness：`tools/contracts/src/harness/` 的 `ContractContext`、
  `ContractClock`、`assertLifecycle`，以及 `assertReplay` / `assertConflict` /
  `assertActorBinding` / `assertAuthorization` / `assertAtomicSuccess` /
  `assertRollback`。
- 两个 Adapter：`registration`（生命周期、回执、权限、事务、roster final）与
  `ticketing`（票据生命周期、权限、凭证重放、归档守卫）。
- 29 个 contract-tools 测试（其中 14 个契约测试）；全量 581 tests 通过。
- 故意破坏验证：移除 `insertAudit` 后，`assertAtomicSuccess` 与 `assertReplay`
  立即失败；恢复后 6/6 registration 契约测试通过。
- 决策记录：ADR-0041（仓库内 Descriptor + Adapter harness，不引入 Pact Broker）。

尚未完成：把 `graph:check` 与契约测试接入 CI、生成变更影响报告（P4）。

## 5. P3：已知问题复现与修复

每个问题独立提交，顺序固定：**失败测试 → 修复 → 通过测试**。测试与修复分开
commit，便于审查和回滚。

### 5.1 顺序与落点

| 顺序 | 问题 | 复现测试落点 | 修复方向 |
| ---: | --- | --- | --- |
| 1 | Manifest / 共享 Schema 漂移 | `plus/packages/contracts/test/contracts.test.ts` | Schema 增加 `commandScopes`；新增“每个注册 Capability 的 Manifest 必须通过共享 Schema”的测试 |
| 2 | 归档后 Ticket 写入 | `plus/packages/runtime/test/voting-ticket-service.test.ts` | 统一 activity 状态守卫：归档拒绝一切票据写入；`closed` 只允许带原因的 revoke |
| 3 | Roster final 后新 Registration | `plus/packages/runtime/test/registration-service.test.ts` | `start` / `answer` / `submit` 在锁内读取 roster 并拒绝 `final` |
| 4 | Judge Claim 重放丢凭证 | `plus/packages/runtime/test/voting-ticket-service.test.ts` | 增加 `onReplay`：为同一 session 重新签发 token 并轮换 digest，不持久化明文 |
| 5 | Live Projection 失败后被静默恢复 | 新增 `plus/packages/runtime/test/live-projection-recovery.test.ts` | block 必须 sticky；读面暴露 `stale/blocked`；Worker 增加投票投影重建命令 |
| 6 | Realtime 订阅 / 关闭竞态 | `plus/packages/realtime/test/server.test.ts` | 增加 `closed` 标志；每个 await 后检查；关闭后不再 `hub.add` |

### 5.2 每个问题的验收

1. 先提交测试，运行后确认失败，保留失败输出摘要；
2. 再提交最小修复；
3. 修复后运行该包测试；
4. 故意回滚修复（本地）确认测试再次失败；
5. 在 commit message 中写明：缺陷机制、复现命令、修复边界。

### 5.3 关键设计决定

- **归档与关闭的票据语义**：归档是终态，拒绝 issue / rotate / redeem /
  reissue / claim / revoke；`closed` 允许带原因的 revoke 与 session revoke，
  但拒绝产生新凭证。理由：保留事故响应，同时不重新打开对外凭证面。
- **Live 投影恢复**：失败后 block 必须保持到显式重建；后续成功事件不得清除 block；
  读面必须告诉调用方“这不是权威计数”。已实现为 sticky block + `stale` 读面 +
  Worker `rebuild-voting-live`；见 ADR-0040 与 RT-10。
- **Judge Claim 重放**：重放不能在响应里返回空凭证，也不能持久化明文 token。
  judge session token 从 `sessionId` + 服务端 secret 确定性派生（HMAC），重放用
  持久化的 `sessionId` 重新计算同一个 token，不创建第二个 session。见 ADR-0039
  与 TICK-08。
- **Manifest 单一真相**：短期用共享 Schema 加门禁；共享 Schema 已补
  `commandScopes`，事件名接受 CamelCase 领域事件与 dotted lowercase 失效信号。
  长期评估让领域类型从 TypeBox Schema 派生，减少两份声明。先不引入包依赖方向变化。

### 5.4 成本

约 3 人日（六个问题，含修复与回归）。若某个修复需要改数据库迁移或审计语义，
单独拆阶段，不混在契约测试提交里。

### 5.5 结果（2026-11-11）

六项都已完成“失败测试 → 修复 → 通过”：

| 问题 | 复现测试 | 修复 |
| --- | --- | --- |
| Manifest / Schema 漂移 | contracts：every manifest passes shared schema | 补 `commandScopes`；事件名双约定 |
| 归档后票据写入 | runtime：archived ticket writes | `ACTIVITY_NOT_ACTIVE` / `ACTIVITY_ARCHIVED` |
| Roster final 后新报名 | runtime：start/answer/submit after final | 锁内 roster 守卫 |
| Judge Claim 重放 | runtime：replay with a usable token | 确定性 HMAC token + `onReplay` |
| Live Projection | runtime：blocked live sticky | block sticky + stale 读面 + ops rebuild |
| Realtime 竞态 | realtime：close during authorize | `closed` 标志与 await 后检查 |

全量回归 567 tests 通过。记录：TICK-08、LIFE-05/LIFE-09 补强、RT-09/RT-10、
ADR-0039/0040。仍开放的 Manifest 声明缺口（competition commands、
`questionnaire.answer`、若干事件）由 Consumer Graph warning 继续跟踪。

## 6. P4：推广与 CI 门禁

### 6.1 风险分级

| 级别 | 内容 | 运行时机 | 预算 |
| --- | --- | --- | --- |
| R0 | 类型检查、结构门禁、Contract Schema、Consumer Graph 检查 | 每次 push / PR | < 90 秒 |
| R1 | 现有 Vitest 全量 + 真实 PostgreSQL + 已知问题回归 | 每次 PR | 保持现状 |
| R2 | 故障注入、并发、恢复、月度状态空间探索 | 每晚 / 发布前 | < 10 分钟 |
| R3 | Playwright 关键旅程 | 每次 PR | 保持现状 |

### 6.2 CI 接线

`.github/workflows/gates.yml` 增加：

```yaml
- name: Build and check the consumer graph
  run: pnpm -C plus --filter @artflow-plus/contract-tools run graph:check

- name: Run contract tests
  run: pnpm -C plus --filter @artflow-plus/contract-tools run test
```

新增 `.github/workflows/contract-nightly.yml` 运行 R2；失败时上传
`.artifacts/contract-impact.md` 与复现参数。

### 6.3 变更影响报告

报告必须包含：

- 变更的 Provider；
- 受影响的 Consumer（Capability、服务、路由、Topic、测试文件）；
- 相关 Contract；
- 执行的测试与故障条件；
- 被破坏的不变量；
- 稳定复现命令。

不做自动 PR 评论，避免扩大 CI 权限；作为 artifact 上传即可。

### 6.4 新 Capability 接入清单

1. 在 Manifest 声明 commands / events / permissions / scopes / commandScopes；
2. 在 `dynamic-dependencies.json` 声明 command / event 消费者；
3. 提供 Adapter（≤ 150 行）；
4. 至少一个反例测试与一个故障/恢复测试；
5. 运行 `graph:check` 与契约测试。

### 6.5 成本

约 2 人日接入，之后每个 Capability 约 0.5 人日。CI R0 增加 < 90 秒；R2 夜间
增加 < 10 分钟，不影响 PR 反馈时间。

## 7. 技术选型评估

| 技术 | 结论 | 理由 |
| --- | --- | --- |
| Vitest | 采用 | 已在全部 Node 包中使用，零迁移成本 |
| fast-check | 采用 | 已是根依赖；适合状态机与生命周期属性测试 |
| 自写有界 TS 扫描器 | 采用 | `typescript@7.0.2` 不暴露 Compiler API；原型只需 import、调用点和 Manifest 字面量，避免新增解析依赖。若后续需要符号级精度，再评估 `@babel/parser` 等依赖 |
| TypeScript Compiler API | 不采用（当前版本） | 原生编译器没有 `createSourceFile` / `createProgram`，无法直接建符号图 |
| TypeBox | 采用 | 共享契约已使用；小型 Schema 可组合 |
| 真实 PostgreSQL + Kysely | 采用 | 现有多数集成测试已如此；避免过度 Mock |
| Pact / Pact Broker | 暂不采用 | 单仓库、进程内 Provider，Broker 增加服务与版本管理成本；先用轻量 Contract 清单 |
| Model-Based Testing | 采用其思想 | 用 fast-check `fc.commands` 驱动生命周期状态机，不新增框架 |
| Mutation Testing | P4 评估 | 只对 2–3 个高风险模块跑，避免全仓成本 |
| Playwright | 保持现状 | 只做跨浏览器上下文旅程，不承担契约或并发 |
| 新增故障注入服务 | 不采用 | 依赖注入与测试 seam 足够；避免污染生产路径 |

## 8. 成本汇总

| 阶段 | 人日 | CI 影响 | 主要风险 |
| --- | ---: | --- | --- |
| P0 审核 | 已完成 | 无 | 无 |
| P1 Consumer Graph（原型已完成） | 2 | +30 秒 | 符号解析边界、动态声明遗漏 |
| P2 Contract / Adapter（原型已完成） | 3 | +60 秒 | Adapter 膨胀、契约固化实现 |
| P3 已知问题（已完成） | 3 | 现有套件内 | 修复触及凭证或投影语义 |
| P4 推广 | 2 | +90 秒；夜间 +10 分钟 | CI 成本、夜间稳定性 |
| 合计 | 约 10 人日 | — | 估算误差 ±50% |

运行基线（2026-11-11）：

- `REQUIRE_DB=1 pnpm -C plus run test`：通过，581 个测试；墙钟未记录；
- `pnpm -C plus run check`：通过；
- `uv run pytest tests/gates -q`：25 passed；
- `uv run python tests/golden/validate_fixtures.py`：6 个 fixture、78 条不变量，OK；
- `pwsh -NoProfile -File scripts/check_docs.ps1`：通过。

## 9. 验收指标

不以测试数量或覆盖率单一指标宣布完成。P4 完成时必须能回答：

1. 是否发现了原本难以发现的问题？——六个已知问题中至少五个由新机制复现。
2. 是否能防止已知缺陷重新出现？——回滚任一修复，回归测试失败。
3. 是否减少重复测试代码？——生命周期断言集中到模板，Capability 只保留 Adapter。
4. 是否能在 Provider 修改后发现受影响的 Consumer？——`impact` 能列出路由、
   Topic、测试与 Capability。
5. 是否能稳定验证异常与恢复路径？——故障注入可重复，不依赖 sleep。
6. 是否保持合理的 CI 成本？——R0 < 90 秒，PR 总时长不显著增加。
7. 新增 Capability 的接入成本是否足够低？——≤ 1 个 Adapter 文件 + 清单声明。

任一项不满足，暂停扩展并回到 P1/P2 修正设计。

## 10. 配置同步清单

每次新增包或文件后检查：

- `plus/pnpm-workspace.yaml` 是否包含 `tools/*`；
- `plus/pnpm-lock.yaml` 是否已更新；
- 新包的 `tsconfig.json` 是否被 `pnpm -r run check` 覆盖；
- `.dockerignore` 是否排除测试产物与 `.artifacts/`；
- `.github/dependabot.yml` 是否需要新增依赖生态；
- `tests/gates/test_plus_route_modules.py` 是否仍然只约束 API 路由；
- 新增文档是否通过 `pwsh -NoProfile -File scripts/check_docs.ps1`；
- `docs/artflow-plus/README.md` 是否已索引新文档。

## 11. 停止条件

出现以下任一情况，停止推广并重新设计：

- Adapter 平均超过 150 行，或模板出现大量 Capability 分支；
- 契约测试需要 Mock Repository 才能运行；
- 故障注入依赖随机 sleep 或全局开关；
- CI R0 超过 3 分钟，或 PR 总时长增加超过 20%；
- 新增 Capability 接入成本超过 1 人日；
- 连续两个阶段没有发现任何真实问题。

## 12. 下一步

1. P1 Consumer Graph 原型已完成并合入 `main`；
2. P2 Contract / Adapter 原型已完成：29 个 contract-tools 测试，其中 14 个
   契约测试；故意移除审计写入会让契约测试失败；
3. P3 六项已知缺陷已完成复现与修复；
4. 下一阶段进入 P4：把 `graph:check` 与契约测试接入 CI，生成变更影响报告，
   建立 R2 夜间故障/恢复套件；
5. 继续用 Consumer Graph 的 warning 收敛 Manifest 声明缺口。

## 13. 外部审核驱动的加固（2026-11-11）

外部审核的 15 条 Issue（`#51`–`#65`）暴露的是“能力测试通过，但产品路径不
连通”。本轮先不逐条修产品，而是把它们变成可重复的诊断：

- **API → Web 消费者缺口**：Consumer Graph 新增 `consumes-route` 边与
  `findUnreferencedMutationRoutes` 报告，首次运行发现 31 条未引用 mutation
  route，包括 tasks sync、podium recompute、close/archive、judge-entry close。
- **Starter Pack 就绪诊断**：`checkPackReadiness` 检查 materials/file question、
  competition/ticketing、voting identity policy，首次运行发现 6 条 finding；
  PR #68 让 singer-competition 默认启用 ticketing 后剩 5 条。
- **统一缺口棘轮**：`audit:check` 把 UI、Pack、Manifest、文档、部署、不变量覆盖
  合成一个缺口集合，并与 `gap-baseline.json` 比较。当前 baseline 接受 168 条
  缺口（ui-route 31、pack-readiness 5、manifest 68、doc-drift 5、
  invariant-coverage 59）；**新增缺口失败，修复后必须删除 baseline 条目**。
  该步骤已接入 `.github/workflows/gates.yml`。
- **PR 处理结果**：PR #66 修复 Compose 挂载并加 gate；#67 补 organizer 开户
  文档；#68 让 singer pack 默认启用评委入口。棘轮自动把两个已修复条目标为
  stale，baseline 从 170 降到 168。
- 设计文档：[自审计测试体系设计](../specs/2026-11-11-self-auditing-test-system-design.md)。

后续优先级：

1. L3：fast-check lifecycle model、随机命令序列（禁止 500 / SQLSTATE 泄漏）、
   确定性并发、读模型差分。
2. L4：Journey spec runner（organizer / participant / judge）。
3. L5：变异审计自动化（删除 audit/receipt/guard，确认测试失败）。
4. 逐步清理 baseline：先修 P0 产品缺口，再收紧对应类别的 `--strict`。

完整映射与验收建议见
[外部审核驱动的测试体系加固](../analysis/2026-11-11-external-review-test-hardening.md)。
