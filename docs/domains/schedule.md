# Schedule / Program Release

## 目的

把舞台类活动的演出顺序变成可编辑、可发布、可审计的权威事实：有哪些槽位、
每个节目排在第几位、公开节目单是哪一版、现场进行到哪一个节目。v1 的公开
节目单只是“已审核报名”的投影，无法表达换序、时长和现场进度；v2 用独立
`schedule` capability 承载这些语义。

## 实体

| 实体 | 关键字段 |
| --- | --- |
| `ScheduleDefinition`（Studio） | `schemaVersion`、`version`、`slots`（key/label/durationMinutes/kind） |
| `schedule_state` | `(activity_id, mode)`、单调递增 `revision`；所有写命令的 OCC 锚点 |
| `schedule_entry` | position、slot_key、participant_id、title、note、revision |
| `schedule_release` | 不可变公开快照 `snapshot`、version、released_at、revoked_at |
| `schedule_current` | `(activity_id, mode)` 的当前条目指针 |

`kind` 只能是 `program`、`break`、`ceremony`；提示词只作用于 Studio 编辑，
不改变运行期顺序。

## 生命周期

```text
definition: draft ──compile──▶ compiled ──release──▶ immutable release
entry:      (none) ──upsert──▶ ordered entry ──remove──▶ (none)
release:    released ──revoke──▶ revoked（快照保留，公开不可见）
current:    entry[n] ──advance──▶ entry[n+1]（必须来自运行中的 schedule session）
```

- 条目编辑、重排、删除、发布使用 `schedule_state.revision` 做 OCC，过期返回
  `STALE_REVISION`；这些命令会递增该 revision。
- 重排要求 `orderedIds` 是当前条目的精确排列。
- 发布要求排期非空，且引用的槽位都存在于已发布定义中；每次发布 version 自增。
- 撤销只写 `revoked_at`，不改写旧快照；公开读取最新未撤销版本。
- `advance` 必须来自运行中的 `schedule` execution session，mode 由 session
  决定，不接受客户端指定。

## 不变量

- 公开只读 **formal**、未撤销的最新 release；test/rehearsal 永远不可见。
- release 是 append-only 版本；已发布快照不可编辑。
- 未启用 `schedule` 的 release 拒绝所有 schedule 命令（`SCHEDULE_NOT_ENABLED`）。
- 空排期不能发布（`SCHEDULE_EMPTY`）；未知槽位拒绝（`SLOT_UNKNOWN`）。
- 所有写命令走 `executeCommand`：receipt + audit + fact + outbox 同一事务。

## 领域事件

`ScheduleEntryChanged`（新增/编辑/删除共用）、`ScheduleReordered`、
`ScheduleReleased`、`ScheduleRevoked`、`ScheduleAdvanced`。

## v1 证据

v1 的节目单是报名表的派生视图（`singer_contest` 的报名/节目字段），没有独立
的排序、版本或现场指针。换序靠工作人员口头协调，公开页无法表达“当前节目”。

## Plus 要求

- 独立 `schedule` capability，依赖 registration；不塞进 publishing 或
  competition。
- Stage Show Pack 默认启用，并提供开场/节目/谢幕三个槽位。
- Studio 提供 `ScheduleEditor`，Ops 提供 `ScheduleCard`，Live 提供只读
  `ScheduleSummary` + “下一位”，Portal 提供 `/program/<publicCode>`。
- 公开页优先读 schedule release，没有 release 时回退到已审核报名，兼容旧活动。
- 归档、导出与消费者图必须能发现 schedule 事件（见 `dynamic-dependencies.json`）。

## 待决问题

- 资源/场地/人员排班（Resources capability）不在本 slice。
- 迟到/换序的自动重排与冲突提示尚未实现。
- 现场大屏节目单视图、跨活动复制排期模板仍是缺口。
