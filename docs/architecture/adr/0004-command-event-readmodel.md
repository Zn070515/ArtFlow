# ADR-0004: Command / domain event / read model 分层

状态：proposed（2026-10-19）

## 背景

v1 的页面、列表、PDF、归档各自拼查询，导致同一事实出现多个 selector 并漂移；
写路径也分散在视图、service、queryset。v2 需要把“写事实”和“读事实”分开，并让
公开出口只有一个来源。

## 决策

- **四种数据形态**（GOAL §14）：Facts（已发生/已权威提交）、Decisions（由事实
  与规则得出的结论）、Snapshots（权威边界上的不可变表示）、Projections（可重建
  的读模型）。候选/计算结论必须与正式 Decision 可区分。
- **写**：每个聚合只有一个 command；command 负责授权、OCC、状态校验、审计与
  事件写入。
- **事件**：command 在同一事务内记录领域事件（outbox）；事件是过去式，不可变。
- **读**：公开/列表/导出消费 read model；read model 只由投影产生，不自行拼
  业务条件。
- **快照**：权威转换（freeze/release/confirm/archive）产出不可变 snapshot；
  历史读只读 snapshot。
- **错误**：command 返回带 code 的领域错误；API 层只映射，不重新解释。

## 后果

- 需要维护投影与重建机制；
- 读模型的最终一致可接受，但“发布后立即读到自己”的路径要显式处理；
- 禁止跨模块直接查表；模块间通过 contract/事件。

## 替代方案

- **ActiveRecord 直写 + 视图查询**：v1 的模式，已证明会漂移，否决。
- **CQRS + 独立读库**：当前规模不需要第二套数据库，否决。
