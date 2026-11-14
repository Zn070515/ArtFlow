# Attendance / Check-in

## 目的

记录“谁在哪个签到点到场”。签到是现场运营的观测事实：它引用报名、票据和工作人员
名单，但不改变它们的权威。`attendance` 统一 participant、ticket、staff 三种主体，
供 Ops/Live 的只读视图消费。

## 实体

| 实体 | 关键字段 |
| --- | --- |
| `AttendancePoint` | key、名称、是否启用、顺序 |
| `AttendanceStaffEntry` | 活动级 staff roster：本地账号、姓名、角色 |
| `attendance_fact` | 只追加：point、subject type/id、`checked_in`/`undone`、actor、note、时间 |
| `attendance_current` | `(activity_id, mode, point, subject)` 的当前投影与 revision |

主体只能来自本活动的 approved registration、ticket（credential 在 API 层解析为
ticket id）或 staff roster。

## 生命周期

```text
point:    (none) ──create──▶ active ──update──▶ active
staff:    (none) ──add─────▶ active ──update──▶ active
check-in: (none) ──checkin──▶ present ──undo──▶ absent ──checkin──▶ present
```

- `attendance.checkin` / `attendance.undo` 必须绑定运行中的 `checkin` execution
  session；mode 由 session 决定。
- 重复签到返回 `ALREADY_CHECKED_IN`；撤销后再签到允许。
- 撤销写新的 `undone` fact，不删除旧 fact。
- 票据签到只写 attendance，不改变 `ticket.state`，不创建 ticket access session。

## 不变量

见 [`docs/invariants/attendance.md`](../invariants/attendance.md) 的 **ATT-01…08**：
签到只做观测、事实只追加、formal/test 分区、票据签到不消耗 redeem、必须有运行中的
check-in session、每个主体每个点只有一条 current、主体必须属于本活动、原始票据
credential 不落持久记录。

## 领域事件

`AttendancePointChanged`、`AttendanceStaffChanged`、`AttendanceCheckedIn`、
`AttendanceUndone`。

## v1 证据

v1 的 `entry_access/` 与 staff 手工登记分散在票务和现场表格中，没有统一的 participant/
staff 到场事实；签到也没有与 execution session 绑定。v2 将其收敛为独立观测 capability。

## Plus 要求

- 独立 `attendance` capability，依赖 registration；票据主体可选依赖 ticketing。
- 写权限 `attendance.manage`；读面 `config.access: "attendance"`。
- Ops Attendance 卡片（session 开关、签到点、三 Tab、票据 credential、签到/撤销/备注）
  与 Live 只读摘要。
- 签到只做观测，不接进评分、投票、发布或归档 gate。
- 默认 organizer 权限包含 `attendance.manage`。

## 待决问题

- 离线签到与事后对账不在当前 slice。
- 签到是否阻塞活动关闭/归档尚未定义；当前只做观测。
