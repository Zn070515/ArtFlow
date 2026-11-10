# 签到与到场不变量（ATT）

签到是现场运营的观测事实。它引用报名、票据和工作人员名单，但不改变它们的权威。

## ATT-01 签到只做观测

- **规则**：任何其他 capability 的命令、投影或放行条件都不得读取签到当前状态；
  签到只能被 Ops/Live 的只读视图消费。
- **为什么**：签到一旦成为评分、投票或发布的 gate，现场误操作会直接改变比赛结果；
  v1 的票务与评分边界也刻意保持分离。
- **必须攻击的形状**：选手未签到仍能开表演/评分；票据未签到仍能投票；工作人员未签到
  仍能执行 Ops 写操作。
- **Plus 要求**：attendance 只写自己的表；其他 capability 不 import attendance；
  结构门禁与代码审查禁止把签到状态接进别的 command gate。

## ATT-02 签到事实只追加

- **规则**：每次签到和撤销都写一条新的 fact；撤销不删除旧 fact，也不把 current 行
  改写成“从未发生”。
- **为什么**：现场纠纷需要还原“谁在什么时候、由谁签到/撤销、备注是什么”。
- **必须攻击的形状**：撤销后 fact 数不变；重复撤销被拒绝；直接删除 fact 的路径不存在。
- **Plus 要求**：`attendance_fact` 无 update/delete API；current 投影通过 fact 命令更新，
  revision 单调递增。

## ATT-03 formal 与 test 分区

- **规则**：签到事实和 current 行按 execution session 的 mode 分区；formal 列表永远
  不显示 test 的到场。
- **为什么**：排练与正式活动的到场人数、名单和统计必须能分开解释。
- **必须攻击的形状**：test 签到后 formal 列表的 expected/present 不变；同一主体在
  两种 mode 下各有一条 current。
- **Plus 要求**：`attendance_current` 的唯一键包含 mode；读路径必须显式取 mode，
  缺省 formal。

## ATT-04 票据签到不消耗 redeem

- **规则**：票据签到只写 attendance；不改变 `ticket.state`，不创建
  `ticket_access_session`，不阻止之后的 `ticketing.ticket.redeem`。
- **为什么**：入场和投票资格是两件事；观众可能入场但不投票，也可能先投票再入场。
- **必须攻击的形状**：签到后 ticket 仍为 `issued`；签到后仍可 redeem；redeem 后仍可
  签到（未撤销/未过期）。
- **Plus 要求**：签到命令只读票据状态；票据状态机不新增 `checked_in` 状态。

## ATT-05 签到必须有运行中的 check-in session

- **规则**：`attendance.checkin` 和 `attendance.undo` 只能在一个运行中的 `checkin`
  execution session 下执行；release 必须把这两个命令绑定到 `checkin` scope。
- **为什么**：没有 session 就没有权威的 mode、时间和操作窗口；否则任何持有权限的人
  可以在任意时刻改到场。
- **必须攻击的形状**：无 session 时签到返回 `SESSION_NOT_RUNNING`；release 未声明
  command scope 时返回 `COMMAND_SCOPE_UNDECLARED`；rehearsal mode 被拒绝。
- **Plus 要求**：命令调用 `requireRunningCommandSession`；打开/关闭 session 沿用现有
  execution 端点。

## ATT-06 每个主体在每个点只有一条 current

- **规则**：`(activity, mode, point, subject type, subject id)` 至多一条 current 行；
  重复签到返回 `ALREADY_CHECKED_IN`，撤销后再签到是允许的。
- **为什么**：没有唯一约束时，两个并发签到会产生两条 current，人数统计翻倍。
- **必须攻击的形状**：同一主体同一点重复签到；两个并发请求；撤销后重新签到。
- **Plus 要求**：数据库唯一约束 + 活动行锁；命令在事务内重新读取 current。

## ATT-07 主体必须属于本活动

- **规则**：报名、票据和 staff roster entry 都必须属于当前活动；跨活动引用返回
  `CROSS_ACTIVITY`。
- **为什么**：签到是活动级事实，不能把另一场活动的票据或选手带进来。
- **必须攻击的形状**：用活动 A 的 registration/ticket/staff id 在活动 B 签到。
- **Plus 要求**：命令在事务内按 `activity_id` 重新读取 subject；不信任 API 的列表。

## ATT-08 原始票据 credential 不落任何持久记录

- **规则**：票据 credential 只在 API 层解析为 ticket id；不得进入 command payload
  hash、receipt、audit、outbox、日志或数据库。
- **为什么**：credential 是可在门口兑换的凭证；写入 receipt 或日志等于泄露票据。
- **必须攻击的形状**：签到后检查 receipt/outbox/审计；不存在原始 credential；重放
  只使用 ticket id。
- **Plus 要求**：`resolveTicketCredentialForAttendance` 只返回 ticket id；命令 payload
  只含 subject id；事件 payload 不含 note/credential。
