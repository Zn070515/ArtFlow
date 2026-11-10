# ADR-0038: 签到是独立的观测 capability

- **Status**: accepted
- **Date**: 2026-11-10

## 背景

v1 的 `tickets`/`entry_access` 同时承担入场、签到和投票资格，票据状态在
`CHECKED_IN` 与 `REDEEMED` 之间耦合。v2 的 `ticketing` 已经用
`ticketing.ticket.redeem` 表达“创建短时投票 access session”，但没有任何事实
记录“谁在哪个签到点到场”。M15.3 要求统一记录 participant、ticket、staff
三类主体的现场签到，供 Ops/Live 查看和统计。

若把签到放进 `ticketing`、`registration` 或 `tasks`，会出现三套状态、三套
统计口径和跨 capability 的隐式依赖；若把 ticket redeem 当作签到，观众不投票
也会消耗票据，且无法表达选手和工作人员到场。

## 决策

1. 新增可选 capability `attendance`，拥有自己的签到点、staff roster、签到事实
   和 current 投影；只读引用报名、票据和 staff roster，不修改它们的任何事实。
2. 签到是观测事实：评分、投票、发布、活动生命周期都不读取它，不把它作为 gate。
3. 票据签到与 `ticketing.ticket.redeem` 完全分离：签到不改变 `ticket.state`，
   不创建 `ticket_access_session`，同一张票可以先入场再扫码投票。
4. `attendance.checkin` 和 `attendance.undo` 绑定运行中的 `checkin` execution
   session；mode 来自 session，事实与 current 按 formal/test 分区。
5. 签到点和 staff roster 是活动级运行数据；签到/撤销是 append-only fact，
   current 只保留每个主体在每个点的一条投影。
6. 读面走 `config.access: "attendance"`，写面要求 `attendance.manage`；打开/关闭
   check-in session 沿用现有 execution 端点，因此需要 `studio.manage` 或
   `competition.manage`。
7. 第一版不做签退、迟到/缺席终态、自助签到、摄像头扫码或跨活动签到。

## 被替代的方案

- **扩展 ticketing/registration/tasks**：三套签到实现和 UI，统计口径分裂；
  不满足统一签到的要求。拒绝。
- **把 ticket redeem 当作签到**：入场与投票资格永久绑定，观众不投票也消耗票据；
  也无法覆盖选手和 staff。拒绝。
- **只做现有事实的只读投影**：没有真正的签到事实，无法记录工作人员现场操作、
  撤销和备注。拒绝。

## 后果

- 活动需要显式启用 `attendance`；现有活动行为不变。
- 签到人数只反映观测结果，不影响比赛或投票 result；Ops 必须用其他权威命令
  修正名单/资格。
- 签到场次依赖 execution session；现场的 mode 和窗口由 session 明确。
- 票据 credential 只在 API 层解析成 ticket id，不进入 command payload、
  receipt、audit、outbox 或日志。
- 后续如需签退/时长，应新增 fact 类型与 current 列，不能原地改写签到事实。
