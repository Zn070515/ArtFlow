# 全平台契约测试与消费者故障注入体系（任务书）

状态：提案，第一轮只做审核、调研与可行性设计。
日期：2026-11-11。
范围：`plus/` 的 Capability、Runtime Service、Repository、API、Realtime、前端与 Worker。

配套文档：

- 现状审核：[2026-11-11-contract-testing-audit.md](../analysis/2026-11-11-contract-testing-audit.md)
- 实施计划：[2026-11-11-contract-testing-plan.md](../plans/2026-11-11-contract-testing-plan.md)

## 1. 背景

ArtFlow 已从单一赛事系统演化为由 Studio、Ops、Live、Portal 四个产品面共同使用的
赛事与活动运营平台。Capability、Runtime Service、Repository、API、Realtime、前端
组件和后台 Worker 持续增加，依赖关系越来越密。

现有测试主要证明局部功能正确，但还不能稳定回答下面这些问题：

1. 某个函数修改后，自身测试通过，依赖它的其他模块是否回归。
2. 生命周期和事务约束散落在多个服务中，是否出现遗漏或解释不一致。
3. 不同消费者依赖同一个接口，却对行为有不同要求。
4. 正常路径正确，异常、并发、超时、重试和恢复路径是否仍然正确。
5. 测试数量增长时，重复测试和维护成本是否同步膨胀。
6. Coding Agent 能保证局部代码正确，却难以持续保证全平台一致性。

目标不是再建一套大型测试框架，而是建立一套随代码规模增长仍能发挥作用的工程
保障机制：**修改重要对象时，系统能识别下游消费者、定位相关契约、运行必要测试，
并用可控故障注入验证正常、异常、并发和恢复路径。**

## 2. Consumer 的含义

这里的 Consumer 指代码层面的依赖方，不是业务用户。包括：

- 函数、方法与类的调用者；
- 接口的实现方与调用方；
- Schema 的消费者；
- Domain Event 的订阅者；
- Command Handler 的调用方；
- Repository 的使用方；
- API 的前端或外部消费者；
- Realtime Topic 的订阅者；
- 投影、后台任务及跨 Capability 的依赖方。

例如：

```text
executeCommand()
    ├── Registration Service
    ├── Competition / Scoring Service
    ├── Voting Service
    ├── Publishing Service
    └── Archive Service
```

修改 `executeCommand()` 时，不仅要验证函数自身，还要验证这些消费者实际依赖的
行为契约仍然成立。

## 3. 设计目标与非目标

目标：

- 尽量完整地发现静态与动态依赖，支持正向追踪、反向追踪和传递影响分析。
- 用小型、正交、可组合的 Contract 描述稳定边界，而不是一个包含全部业务细节的
  巨型 Schema。
- 生命周期、事务、权限、幂等、事件和恢复规则可以被模板化复用，但由各 Capability
  的 Adapter 提供业务事实。
- 同一个 Provider 的不同 Consumer 可以声明不同行为期待。
- 故障注入可重复、可控制、可定位，能验证故障发生时和恢复后的最终状态。
- 变更影响分析把测试成本压到受影响的消费者上，而不是每次跑全量状态空间。

非目标：

- 不为每个私有函数生成独立测试套件。
- 不追求覆盖率、测试数量或代码行数作为完成标准。
- 不把当前实现自动生成的输出当作正确性判据。
- 不为了统一而强行抽象本质不同的业务行为。
- 不因为某个工具成熟就直接引入。
- 不在第一轮直接大规模创建框架。

## 4. 六阶段体系

### 4.1 Consumer Graph

先建立代码依赖关系图谱，至少识别：

1. 函数与方法调用关系；
2. 类、接口及实现关系；
3. 模块依赖关系；
4. Capability 之间的显式依赖；
5. Command、Event、Query 的生产与消费关系；
6. API 与前端调用关系；
7. Realtime 发布与订阅关系；
8. 数据库及 Read Model 的关键消费关系。

依赖图必须支持：

- 正向追踪：当前对象依赖谁？
- 反向追踪：谁依赖当前对象？
- 传递影响分析：修改当前对象可能影响哪些下游模块？
- 按 Capability、产品面和风险级别聚合。

实现可以使用 TypeScript AST、类型系统、现有 Manifest、注册表和必要的显式依赖
声明。不能假设静态 `import` 能完整还原运行时依赖，必须显式处理：

- `executeCommand` 的 handler 闭包与 command type；
- `appendEngineEvent` 的事件生产；
- Capability Registry 的 dependencies / commands / events / permissions / scopes；
- Outbox Relay 的消费分区；
- Realtime Topic 的发布与订阅；
- Repository 与投影的表级读写。

目标是尽可能完整地发现依赖，而不是要求每个私有函数都有独立测试文件。

### 4.2 统一 Contract Schema

每个重要 Contract 至少描述：

| 字段 | 含义 |
| --- | --- |
| Provider | 能力提供方 |
| Consumers | 已知消费者 |
| Preconditions | 前置条件 |
| Inputs | 输入约束 |
| Outputs | 输出保证 |
| State Transitions | 允许的状态转换 |
| Invariants | 必须始终成立的不变量 |
| Errors | 错误语义 |
| Side Effects | 数据、审计、事件等副作用 |
| Idempotency | 幂等与重放语义 |
| Concurrency | 并发保证 |
| Recovery | 故障恢复要求 |
| Version | 契约版本及兼容性要求 |

Contract 按能力组合与继承，但避免构建包含所有业务细节的巨型 Schema。优先小型、
正交、可组合的契约：

```text
Base Contract
    ├── Lifecycle Contract
    ├── Transaction Contract
    ├── Authorization Contract
    ├── Idempotency Contract
    ├── Event Contract
    └── Recovery Contract
```

具体 Capability 只组合它需要的契约，各产品面通过 Adapter 接入同一套测试机制。

### 4.3 生命周期模板测试

针对不同 Capability 的生命周期，设计可复用测试模板，至少覆盖：

- 初始状态；
- 合法状态转换；
- 非法状态转换；
- 终止状态；
- 终止状态后的写入保护；
- 版本冲突；
- 重复命令；
- 并发状态转换；
- 跨 Capability 的前置条件；
- `test`、`rehearsal`、`formal` 模式隔离；
- 归档、撤销、重新发布与恢复。

模板负责通用规则；Capability Adapter 提供：

- 状态构造；
- 命令执行；
- 状态查询；
- 业务特有约束。

允许扩展具体测试，但避免每个模块重复编写全部生命周期逻辑。

### 4.4 Consumer-Driven Contract Testing

原则：Provider 必须满足消费者实际依赖的行为保证；同一个 Provider 可以有多个
消费者，不同消费者可能依赖不同契约。

```text
Provider: executeCommand()

Consumer A: Registration Service
    要求：事务原子性

Consumer B: Judge Claim
    要求：凭证安全、幂等和失败恢复

Consumer C: Voting Service
    要求：不能重复产生权威投票事实

Consumer D: Publishing Service
    要求：发布状态、审计和事件保持一致
```

需要同时验证：

1. Consumer 的调用符合契约；
2. Provider 的实际行为满足契约；
3. Provider 修改后，所有受影响的 Consumer Contract 仍然成立。

必须避免循环论证：不能直接根据当前实现自动生成预期结果，再用同一结果验证同一
实现。正确性判据优先来自独立的领域不变量、明确业务规则、Golden Fixture 和消费者
契约。

### 4.5 消费者故障注入

故障注入不仅作用于 Provider 本身，还要验证不同 Consumer 面对同一故障时的正确
行为。至少研究以下类型：

#### 调用故障

- Provider 抛出异常；
- 超时；
- 取消；
- 返回异常数据；
- 返回已废弃或不兼容的数据结构。

#### 事务故障

- 事务开始前失败；
- 事务执行中失败；
- 提交前失败；
- 提交成功但响应丢失；
- 外部副作用失败；
- 相同命令重复执行。

#### 事件故障

- 重复投递；
- 延迟投递；
- 乱序投递；
- 消费者崩溃；
- 事件重放；
- 投影更新失败；
- 恢复过程中出现新事件。

#### 状态故障

- 读取过期快照；
- 使用旧版本；
- 生命周期发生变化；
- 执行权限被撤销；
- 缓存与权威数据不一致。

#### 并发故障

- 两个消费者同时操作；
- 锁竞争；
- 异步回调乱序；
- 请求取消后异步操作仍然完成；
- 订阅建立与连接关闭竞争；
- 重试与正常执行并发。

#### 依赖故障

- 数据库暂时不可用；
- Realtime 中断；
- Worker 停止；
- Repository 返回错误；
- 下游消费者落后；
- Schema 版本不兼容。

故障注入应尽量具备：可重复、可控制、能确定故障位置、不依赖随机 `sleep`、不污染
其他测试、能输出复现所需参数、能验证恢复后的最终状态。优先通过依赖注入、可控
时钟、调度器和测试专用故障点实现，不为测试大量污染生产业务代码。

### 4.6 Change Impact Gate

理想流程：

```text
检测代码变更
    ↓
识别变更的函数、类、接口或 Schema
    ↓
查询 Consumer Graph
    ↓
计算受影响的消费者
    ↓
定位相关 Contract
    ↓
加载对应 Adapter
    ↓
执行正常、异常和故障注入测试
    ↓
验证不变量
    ↓
输出影响报告
```

报告不仅显示失败的 Test Case，还要指出：

- 哪个 Provider 发生变化；
- 哪些 Consumer 受到影响；
- 违反了什么 Contract；
- 具体是什么故障条件；
- 哪个不变量遭到破坏；
- 如何稳定复现。

## 5. 已知问题作为首批验收样例

体系必须能稳定识别 ArtFlow 已经发现的真实问题，而不是只证明框架能跑。优先级：

1. 归档状态下仍允许不应发生的 Ticket 操作；
2. Roster 最终确定后仍可能出现不符合业务规则的新 Registration；
3. Outbox 消费失败与 Live Projection 恢复过程中的一致性问题；
4. Judge Claim 事务成功但响应丢失后的凭证恢复问题；
5. Realtime 异步订阅与连接关闭之间的竞态；
6. Capability Manifest 与共享 Schema 之间的契约漂移。

第一轮已在最新代码上逐项复核，结论与证据见
[审核文档 §5](../analysis/2026-11-11-contract-testing-audit.md#5-已知问题复核)。对仍然
存在的问题，实施顺序固定为：

1. 先添加能复现问题的测试；
2. 运行并确认测试确实失败；
3. 单独修复业务代码；
4. 运行并确认测试通过。

对已经修复的问题，检查现有测试是否真正覆盖缺陷形成机制，而不是只覆盖表面结果。

## 6. 防止测试体系膨胀

这是强约束。目标是增加测试有效性，不是增加测试数量。必须避免：

- 每个函数生成独立的大型 Test Suite；
- 对所有维度做无意义的笛卡尔积；
- 测试模板内部存在大量重复代码；
- Adapter 比业务代码更复杂；
- 将实现细节固化为契约；
- 过度 Mock，导致测试无法发现真实集成问题；
- 仅依赖单元测试，不运行真实数据库与跨模块测试；
- 为追求统一而强行抽象本质不同的业务行为。

建议分级：

- 高频、快速的静态检查与契约测试；
- 中等成本的数据库和 API 集成测试；
- 高成本的并发、故障恢复及跨产品 E2E；
- 定期运行的大规模状态空间探索。

使用风险分级、组合测试、变更影响分析控制成本。不要让测试框架成为 ArtFlow 的
第二套复杂业务系统。

## 7. 技术选型与现有技术栈适配

候选实践：Consumer-Driven Contract Testing / Pact、Property-Based Testing /
fast-check、Model-Based Testing、State Machine Testing、Fault Injection、Mutation
Testing、Dependency Graph / Call Graph Analysis、Deterministic Concurrency Testing、
Vitest Fixtures / Mocking、Playwright 跨上下文集成测试。

评估维度：与 pnpm Monorepo 的适配、能解决什么问题、运行成本、维护成本、对生产
代码的侵入程度、与现有测试体系的重复程度。

当前判断（详细见实施计划）：

- **优先复用** Vitest、fast-check、真实 PostgreSQL、Kysely、TypeBox、现有
  `tests/gates/` 与 `tests/golden/`。
- Pact 的 broker/provider 服务模型与单仓库、进程内 Provider 不匹配；先实现轻量的
  Consumer Contract 清单与断言，不引入外部 Broker。
- Consumer Graph 用 TypeScript Compiler API 生成，不新增解析依赖。
- 故障注入优先依赖注入与测试 seam，不把故障开关散落到生产路径。
- Playwright 只用于跨浏览器上下文的旅程，不承担契约或并发验证。

## 8. 实施顺序与验收

不要一次性重构所有测试。阶段与出口：

### P0：现状审核

- 全面盘点测试架构；
- 梳理现有不变量、契约和故障测试；
- 识别缺口与重复建设风险；
- 复核已知问题。

出口：审核文档可回答“已有什么、缺什么、哪些已知问题仍存在”，并给出证据链接。

### P1：Consumer Graph 原型

- 建立初步依赖图；
- 验证反向影响分析；
- 标识动态依赖等无法自动识别的部分。

出口：对 `executeCommand`、Outbox Relay、Realtime 三条链能给出正向与反向消费者
列表；动态依赖有显式声明与失败提示。

### P2：核心契约与 Adapter 原型

- 优先 `executeCommand`；
- 然后 Outbox Relay；
- 最后 Realtime。

出口：至少一个 Capability 通过 Adapter 接入生命周期、事务、权限、幂等与恢复
契约；新增 Capability 的接入成本可量化。

### P3：已知缺陷复现实验

- 验证框架能否稳定暴露真实问题；
- 检查测试是否有误报、漏报；
- 评估运行成本和维护复杂度。

出口：每个仍存在的已知问题先有失败测试，再有独立修复，最后测试通过；故意破坏
修复会让测试再次失败。

### P4：逐步推广

- 扩展生命周期契约；
- 扩展其余 Capability；
- 建立 CI 门禁；
- 建立变更影响报告。

出口：CI 在合理时间内运行；变更影响报告能指出 Provider、Consumer、Contract、
故障条件、被破坏的不变量和复现方式。

不得以测试数量、代码行数或覆盖率单一指标宣布完成。核心评价标准：

1. 是否发现了原本难以发现的问题？
2. 是否能够防止已知缺陷重新出现？
3. 是否减少重复测试代码？
4. 是否能在 Provider 修改后发现受影响的 Consumer？
5. 是否能稳定验证异常与恢复路径？
6. 是否保持合理的 CI 成本？
7. 新增 Capability 的接入成本是否足够低？

## 9. 最终设计原则

1. 测试架构必须服务于业务架构，不能反过来控制业务架构。
2. 全局依赖发现尽可能完整，但契约测试聚焦稳定边界和高风险行为。
3. 同一个 Provider 的不同 Consumer 可以有不同的行为期待。
4. 生命周期、事务、权限、幂等和恢复是不变量体系的重要组成部分。
5. 故障注入必须同时检查故障发生时和恢复后的行为。
6. 测试应独立验证业务正确性，不能简单复述当前实现。
7. 统一 Schema 与 Adapter 是手段，不是最终目标。
8. 新增抽象必须证明其收益大于维护成本。
9. 重要测试应经过故意破坏或缺陷复现实验，验证其确实能够失败。
10. 任何门禁都不应通过静默跳过必要测试来获得绿色结果。

## 10. 最终目标

> 当 Coding Agent 修改任意重要函数、方法、类、接口、Schema 或事件时，系统能够
> 识别其下游消费者，定位相关契约，自动运行必要测试，并通过可控故障注入验证
> 正常、异常、并发和恢复路径。
>
> 最终让 ArtFlow 的长期正确性更多依赖可执行的工程机制，而不是依赖开发者或 Agent
> 的记忆与自觉。

第一轮任务以全局审核、技术调研和可行性设计为主，输出实现方案、优先级、预期成本
与现有代码适配情况。未经论证，不直接大规模创建测试框架。
