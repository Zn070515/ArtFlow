# Activity（活动）— thin root container

## 目的

Activity 是 capabilities 协作的**薄根容器**。它提供身份、归属、粗生命周期、
启用的 capability 集合和当前 definition release；它不积累每个 capability 的
内部状态。

## 实体与值

- `Activity`：id、标题/元数据、owner、粗生命周期
  （DRAFT → ACTIVE → CLOSED → ARCHIVED）、enabled capabilities、active definition
  release、公共身份。
- `PublicEntry`：公开入口码/二维码；只是定位，不是凭证（TICK-01）。
- `ActivityPack`：一组 opinionated capability + 默认值 + 引导；不是 Activity
  子类。

## 生命周期

```text
DRAFT → ACTIVE → CLOSED → ARCHIVED
```

- 只允许这四条边；普通命令不能跳级或回退。
- 各 capability 拥有自己的更丰富生命周期（Registration DRAFT→OPEN→REVIEW→FINAL、
  Competition PREPARING→READY→RUNNING→CLOSED、Voting DRAFT→OPEN→CLOSED、
  Publishing PRIVATE→READY→RELEASED→REVOKED）。
- 不得把本质并行的运营过程压成一个全局线性阶段；执行由多个 scoped Execution
  Sessions 表达，冲突由 capability 组合声明。

## 不变量

- **ACT-01** 所有子事实必须带 activity 归属；命令在锁后重新验证归属（AUTH-03）。
- **ACT-02** Activity 生命周期只能由命令迁移；没有 `save(status=...)`。
- **ACT-03** TEST/FORMAL 生命周期分离；正式结果/归档拒绝 TEST 活动（AUTH-06）。
- **ACT-04** 公开入口码不是凭证；权限动作另有 capability（TICK-01）。
- **ACT-05** Activity 只持有粗生命周期；capability 内部状态不得堆进 Activity。

## 事件

`ActivityCreated`、`ActivityActivated`、`ActivityClosed`、`ActivityArchived`、
`ActivityCapabilityEnabled/Disabled`、`ActivityRenamed`（只影响展示，不影响已
冻结的结果身份）。

## v1 证据

v1 把报名/审核/彩排/现场/结果做成 Activity 的单一路径阶段；这证明了现场顺序，
但不是 v2 的规范。v1 的 `core.models.Activity` 与
`core.services.transition_activity_phase` 是证据来源，不是要保留的模型。

## Plus 要求

- Activity 模块只暴露命令与只读查询；其他 capability 不得直接写 activity 表。
- 生命周期是显式枚举 + 边集合。
- 启用/停用 capability 是显式命令，且要校验依赖/冲突。
- 归档/解归档是独立用例，带审计和包版本。

## 待决问题

- Activity Pack 的“默认 capability 组合”是否允许用户之后禁用其中某一项？
  GOAL 说可以启用/禁用/定制兼容 capability；依赖关系需要在包定义里显式。
- 归档后是否允许解归档并重新启用 capability？v1 有独立解归档路径；v2 需要
  明确读模型与审计。
