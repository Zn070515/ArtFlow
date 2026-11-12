# 契约测试与消费者故障注入：任务书复核

状态：复核完成（2026-11-12）。
来源：外部任务书 `C:\Users\16275\Desktop\advices\ChatGPT.md`（2026-11-11）。
对照：

- [任务书规格](../specs/2026-11-11-contract-testing-program-design.md)
- [P0 现状审核](../analysis/2026-11-11-contract-testing-audit.md)
- [实施计划](../plans/2026-11-11-contract-testing-plan.md)
- [自审计测试体系设计](../specs/2026-11-11-self-auditing-test-system-design.md)

## 1. 结论

任务书不是一份尚未启动的新计划。它描述的能力在 `main` 上已经完成了 P0–P3，P4
也接入了主要 CI 门禁。**不需要重做，也不应该重新起一套框架。**

剩余工作集中在 P4 扩面：把 Adapter 从 4 个 Capability 扩到其余高风险 Capability、
补 2–3 条跨产品面 journey、补事件/状态/依赖类故障注入、收紧 Manifest 与不变量
baseline。这些可以与前端的 Console 迁移并行推进，互不阻塞。

## 2. 任务书阶段与现状对照

| 任务书阶段 | 现状 | 证据 |
| --- | --- | --- |
| P0 现状审核 | 已完成 | [审核文档](../analysis/2026-11-11-contract-testing-audit.md) |
| P1 Consumer Graph | 已完成并接入 CI | `plus/tools/contracts/src/graph/`；`gates.yml` 的 `graph:check`；最近一次 1952 nodes / 3465 edges / **unresolved 0** |
| P2 Contract Schema + Adapter | 原型完成 | `plus/packages/contracts/src/contracts/`；4 个 Adapter：registration、ticketing、competition、publishing |
| P3 六个已知问题 | 全部修复并有复现测试 | 审核文档 §5.7；ADR-0039/0040；TICK-08、LIFE-05/09、RT-09/10 |
| P4 CI 门禁 | 大部分完成 | `graph:check`、`audit:check`、PR `impact` job、夜间 `mutation-audit.yml` |
| 防膨胀 | 有硬约束 | Adapter ≤150 行、模板 ≤300 行、baseline 棘轮、禁止 cartesian matrix |
| Change Impact | 已有报告，但**不阻塞** | `impact` job 设置 `continue-on-error: true`，目前只作为 artifact |

## 3. 现有资产规模

| 资产 | 数量 | 位置 |
| --- | ---: | --- |
| 契约测试文件 | 15 | `plus/tools/contracts/test/contracts/` |
| 真实 Adapter | 4 | `plus/tools/contracts/src/harness/adapters/` |
| Journey spec | 2 | `plus/tools/contracts/journeys/` |
| 故障 helper | 3 | `assertRollbackPoints`、`assertConcurrentCommand`、`assertRelayIdempotence` |
| Gap baseline | 130 | `gap-baseline.json`（invariant 58、manifest 54、ui-route 18） |
| CI 门禁 | 4 | `graph:check`、`audit:check`、`impact`、夜间 mutation audit |

## 4. 仍然缺的（按风险排序）

### 4.1 Voting Adapter（最高风险）

`voting` 是票据、ballot 唯一性、release/session 绑定和重复投票语义的交叉点，目前
只有 runtime/API 测试，没有接入统一生命周期模板。建议按 `ticketing` Adapter 的
模式新增，覆盖：

- 同一 ticket 只能产生一个权威 ballot；
- revoked/expired ticket 不能投票；
- session 的 frozen release 与 ballot/close 的 stale-context 拒绝；
- 重复 `commandId` 重放不产生第二张 ballot；
- `formal` 与 `test`/`rehearsal` 分区隔离。

成本约 1–1.5 人日；不新增测试框架，只新增一个 ≤150 行的 Adapter 与一个反例。

### 4.2 其余 Capability Adapter

`grouping`、`attendance`、`archive`、`tasks` 尚未接入生命周期模板。优先级：
`grouping`（成员历史与冻结）> `attendance`（三主体签到）> `archive`（终态）
> `tasks`（非权威任务）。每个约 0.5 人日，接入成本应为“1 个 Adapter + Manifest
声明”，超过就停止推广。

### 4.3 Journey 覆盖

目前只有 `singer-registration-roster` 与 `singer-judge-score`。缺：

- 主办方主线：Studio 创建 → 激活 → 发布 → Live 准备 → 结果发布；
- 参与者主线：报名 → 材料 → 投票（browser 与 ticket 各一条）；
- 终止路径：归档 → 拒绝写入 → 取消归档（或明确拒绝）。

建议每条 journey 只覆盖一个稳定业务目标，不把 UI 选择器或内部字段写进 spec。

### 4.4 故障矩阵

现有 helper 覆盖事务回滚、并发同命令、relay 幂等。仍缺：

| 故障类 | 缺口 | 建议 seam |
| --- | --- | --- |
| 事件 | 重复投递、乱序、消费者崩溃、重放中新事件 | Relay 批次注入 + 事件日志重放 |
| 状态 | 过期快照、权限撤销、生命周期变化 | 读面注入 stale revision / revoked actor |
| 依赖 | DB 暂时不可用、Realtime 断开、Worker 停止 | Repository/连接层注入一次性失败 |
| 响应丢失 | Judge Claim 已覆盖；轮询/发布接口未覆盖 | 回执命中后重新签发路径 |
| Schema | Manifest 漂移已有测试；旧 release 不兼容未覆盖 | release snapshot + 当前 Schema 校验 |

只补能真实失败的用例，不做 5×6 的笛卡尔积。

### 4.5 Baseline 与 Manifest 缺口

`gap-baseline.json` 仍接受 130 条缺口：

- `manifest` 54 条：competition 多条命令、`questionnaire.answer`、若干事件未声明；
- `invariant-coverage` 58 条：ATT/AUTH 等不变量尚未被测试引用；
- `ui-route` 18 条：Consumer Graph 已发现但 UI 尚未引用的 mutation route。

建议顺序：先修 manifest（影响 Provider 契约），再修 invariant（影响测试有效性），
最后处理 ui-route（影响产品完整性）。每修一条就删除 baseline 条目，不批量接受新缺口。

### 4.6 Impact Gate 仍是建议性

`impact` job 是 `continue-on-error: true`，失败不会阻止合并。任务书要求的是
“Provider 改了，受影响的 Consumer 测试必须被执行/被发现”。建议：

1. 先观察 2 周报告的误报率；
2. 把“存在受影响 Consumer 但未运行对应测试”变成可失败的检查；
3. 只在报告稳定后再移除 `continue-on-error`，避免把噪声变成红灯。

## 5. 与开发并行的推进方式

不要停下来做一轮“测试体系专项”。每个开发 slice 按下面的规则顺手接入：

| 开发动作 | 并行契约动作 |
| --- | --- |
| 新增/修改 API route | 跑 `graph:check`；确认 `consumes-route` 有消费者或被 `api-only.json` 显式声明 |
| 修改命令/事件/权限 | 更新 Manifest 与 `dynamic-dependencies.json`；跑对应 Adapter 契约 |
| 新增页面旅程 | 增加一条 journey spec，不复制生命周期模板 |
| 修改票据/投票/发布 | 先补失败测试（voting Adapter），再改业务 |
| 修复已知缺口 | 删除 `gap-baseline.json` 对应条目，不新增 baseline |

优先级建议：

1. **P4.1 Voting Adapter**（1–1.5 人日）：最高风险，先做；
2. **P4.2 主办方 journey**（0.5–1 人日）：与当前 Console 迁移同步；
3. **P4.3 事件/状态故障**（1–2 人日）：只补可复现的真实缺陷；
4. **P4.4 Manifest baseline**（1 人日）：先 54 条降到 20 条以内；
5. **P4.5 Impact 阻塞**（观察 2 周后再做）。

## 6. 停止条件与防膨胀

继续遵守实施计划的硬约束：

- Adapter 平均 ≤150 行；模板出现大量 Capability 分支时停下拆契约；
- 不为每个状态写独立测试文件，不做无意义笛卡尔积；
- 故障注入不依赖随机 `sleep`、全局开关或污染其他测试；
- 契约测试必须能用真实 PostgreSQL 运行，不 Mock Repository；
- 新增抽象必须回答“发现了什么真实问题 / 减少了什么重复 / CI 成本增加多少”；
- 不以测试数量或覆盖率宣布完成。

## 7. 复核结论

任务书的十三个设计原则与六阶段体系已经在 `main` 上成立。当前不是“要不要建这套
体系”，而是“把剩下的高风险 Capability、journey 和故障类补齐，并收紧 baseline”。

建议把 P4.1 Voting Adapter 与当前前端 Console 迁移并行推进：前端改动不碰
runtime，Adapter 只消费现有命令，二者没有写冲突；每天各自独立提交，互不阻塞。

## 8. 实施进展（2026-11-12）

- **Voting Adapter 已实现**：`plus/tools/contracts/src/harness/adapters/voting.ts`。
  8 个契约测试覆盖生命周期、事务原子性、重放、命令 payload 冲突、actor 绑定、
  重复 browser ballot、执行 release 变化和 mode 变化；`contract-tools` 105 tests
  全绿。票据身份的 revoked/expired 分支仍由既有
  `voting-ticket-service.test.ts` 覆盖，下一步再决定是否并入 Adapter。
