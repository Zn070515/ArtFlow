# Activity 领域

## 目的

活动是**所有其他聚合的归属边界**。报名、赛制、轮次、票据、结果、归档都通过
activity 判定“属于哪个世界”，但活动本身不替它们做业务决定。

## 实体与值

- `Activity`：id、标题、类型、生命周期（draft/active/archived）、阶段、锁定、
  公开入口码、owner。
- `ActivityPhase`：现场推进的阶段（registration/review/…/live/results/archived）。
- `PublicEntry`：公开入口码与二维码；只是定位，不是凭证（TICK-01）。

## 生命周期

```text
draft ──activate──▶ active ──archive──▶ archived
                         │
                         └── phase: registration → review → rehearsal → live
                                    → results_pending → results_published
```

- 阶段只能沿显式边前进；普通命令不能进入/离开 archived（LIFE-01/05）。
- archived 是只读终态；解归档是独立命令，不能伪造一个从未发生的阶段。
- 活动的标题不是公开结果的标题：正式结果的标题在 release 时冻结（RES-06）。

## 不变量

- **ACT-01** 所有子聚合必须带 activity 归属，命令在锁后重新验证归属（AUTH-03）。
- **ACT-02** 活动状态变化只能由命令完成；没有 `save(status=...)`。
- **ACT-03** TEST/FORMAL 生命周期分离；正式结果/归档拒绝 TEST 活动（AUTH-06）。
- **ACT-04** 公开入口码不是凭证；需要权限的动作另有 capability（TICK-01）。

## 事件

`ActivityCreated`、`ActivityActivated`、`ActivityPhaseChanged`、
`ActivityArchived`、`ActivityUnarchived`、`ActivityRenamed`（只影响展示，
不影响已冻结的结果身份）。

## v1 参考

- `core/models.py::Activity`、`core/services.py::transition_activity_phase`
- 事故：`docs/incidents/admin-reauth-405.md`（活动管理动作的再验证落点）

## Plus 要求

- Activity 模块只暴露命令与只读查询；其他模块不得直接写 activity 表。
- 阶段是显式枚举 + 边集合，不是散落在视图里的字符串比较。
- 活动归档与解归档是独立用例，带审计和包版本。

## 待决问题

- 活动是否允许多个并行“当前阶段”（例如报名与彩排重叠）？v1 是单阶段；
  v2 若引入并行，需要先定义读模型和 gate。
