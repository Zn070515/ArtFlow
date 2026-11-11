# ADR-0041: 契约测试使用仓库内的小型 Descriptor + Adapter harness

- **Status**: accepted
- **Date**: 2026-11-11

## 背景

P2 需要验证 `executeCommand` 的消费者契约：不同 Capability 对回执、事务、
权限、幂等和恢复有不同期待。可选方案包括 Pact/Pact Broker、为每个 Capability
复制测试、只做端到端测试，或建立一个仓库内的小型 harness。

ArtFlow 是单仓库、进程内 Provider、真实 PostgreSQL 测试；Pact Broker 会引入
额外的服务、版本发布和 CI 凭据。为每个 Capability 复制完整测试会让测试量随
Capability 数量线性膨胀。只做 E2E 又无法稳定覆盖回执、回滚、并发和恢复。

## 决策

1. 契约元数据用小型 TypeBox Schema 放在共享 `packages/contracts/src/contracts/`：
   `descriptor`、`lifecycle`、`idempotency`、`authorization`、`transaction`、
   `event`、`recovery`。每个契约只描述稳定边界，不描述实现。
2. 测试专用 harness 放在 `plus/tools/contracts/src/harness/`，不进入生产依赖
   闭包。它提供：
   - 一次性 PostgreSQL schema 的 `ContractContext`；
   - 确定性 `ContractClock`；
   - `assertLifecycle` 生命周期模板；
   - `assertReplay` / `assertConflict` / `assertActorBinding` /
     `assertAuthorization` / `assertAtomicSuccess` / `assertRollback` 命令断言。
3. Capability 只提供一个 Adapter：构造状态、执行命令、查询状态、声明非法边。
   首个 Adapter 是 `registration`，第二个是 `ticketing`。
4. 契约测试跑真实 PostgreSQL，不使用 Repository Mock；命令回执、事务、锁和
   投影行为必须在真实数据库上验证。
5. 不引入 Pact Broker，不新增外部服务或 CI 凭据。

## 替代方案

- **Pact / Pact Broker**：单仓库进程内 Provider 不需要 broker 的版本协商；
  额外服务和凭据成本大于收益，否决。
- **每个 Capability 复制完整测试**：重复且随 Capability 数量膨胀，否决。
- **只做 E2E**：无法稳定覆盖回执冲突、回滚、并发和响应丢失，否决。
- **一次性铺开所有 Capability 的通用框架**：尚未证明框架能抓真实缺陷，
  先以 `registration` + `ticketing` 验证，否决大铺开。

## 后果

- 新增 Capability 的接入成本目标 ≤ 1 个 Adapter 文件 + Manifest 声明。
- 契约测试不进入生产镜像；`plus/tools/contracts` 只用于开发与 CI。
- 2026-11-11 原型结果：29 个 contract-tools 测试（其中 14 个契约测试），
  全量 581 tests；故意移除 `insertAudit` 后两个契约测试立即失败，恢复后通过。
- 剩余工作：把 `graph:check` 与契约测试接入 CI、生成变更影响报告（P4）；
  Manifest 声明缺口仍由 Consumer Graph warning 跟踪。
