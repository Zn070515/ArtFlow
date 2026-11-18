# ADR-0046: Resources 是规划 capability，预约以活动为范围

- **Status**: accepted
- **Date**: 2026-11-18

## 背景

Stage Show 场景需要场地、设备和人员的排练/使用预约。schedule 只描述节目顺序，
tasks 描述工作项，attendance 描述现场到场；没有一个地方表达“谁在什么时间占用
哪个资源”。

资源预约不是执行事实：它不影响 execution session、评分、投票或公开节目单，
但冲突必须可靠地拒绝。

## 决策

1. 新增 `resources` capability。资源定义（key/name/kind/capacity/notes）随
   Activity Definition Release 冻结；compiler 拒绝重复 key、未知 kind、非法
   capacity。
2. `resource_booking` 以 activity 为范围，不引入跨活动资源池：
   - `draft → confirmed → cancelled`；
   - draft 可重叠；confirm 在 `(activity, resource)` advisory xact lock 内
     检查 confirmed 预约的时间重叠；
   - confirmed 更新后重新检查（排除自身）；cancel 必须带原因且为终态。
3. 所有写命令走 `executeCommand`：receipt、audit、fact、outbox 同事务；OCC 用
   revision；命令在 Activity 锁内执行。
4. 预约只存创建时的 `resource_name` 快照；后续 release 变化不改写历史预约。
5. 读面 `resources.read` 要求 `resources.manage`、`studio.manage` 或
   `schedule.manage`；公开面不暴露资源。
6. 第一期不把预约并入归档包；归档闭包不依赖资源预约。

## 替代方案

- **把资源塞进 schedule entry**：一个节目可能占用多个资源，资源也可能被排练
  占用，语义不一致，否决。
- **用 PostgreSQL exclusion constraint**：需要 btree_gist 扩展；advisory lock +
  查询在当前规模更可移植，否决扩展依赖。
- **跨活动共享资源池**：会引入组织级模型，属于多租户/商业阶段，否决。
- **草稿也检查冲突**：草稿是规划工具，允许重叠；只在确认时裁决，否决。

## 后果

- 同一活动内同一资源的确认预约不会重叠；跨活动不检查（单租户部署通常只有一个
  活动在用同一物理资源，部署方需自行约束）。
- 预约不参与 mode 分区；它不是执行事实。
- 归档包暂时不含资源预约；需要时扩展 archive-package。
