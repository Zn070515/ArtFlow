# 事件响应与证据链

本流程用于生产活动中的异常、滥用、凭据泄露、评分争议和恢复事件。它不替代学校的正式事件响应制度；上线前必须由学校和部署方补齐联系人、通知时限、法律保全和 RTO/RPO。

## 立即动作

1. 事件负责人记录时间、环境、活动、轮次和 request ID，先暂停受影响的评分、投票或公开发布窗口。
2. 不在聊天、工单、截图或命令行回显中复制 QR secret、session token、数据库口令或学生完整信息。必要时立即撤销 grant/session，并保留 digest、范围、状态和时间。
3. 记录 actor、source（direct judge、staff proxy、paper DR 或 import）、reason、context version、payload hash、结果码和关联审计 ID。分数内容只按学校批准的最小范围取证。
4. 对数据库、media 和备份执行只读证据保全；恢复必须使用隔离目标。不得用 `down --volumes`、源库 drop 或未批准的 reset 代替恢复。

## 评分与 authority 事件

正式 `ScoreRecord` 是原始事实。普通 judge command 不能覆盖既有事实；需要修正时必须使用有原因的新命令、保留 before/after 审计和 provenance。`DIRECT_JUDGE` 必须能回到活动快照、席位、会话和成功 receipt；代录与纸面录入必须分别标注来源参考和操作员。panel 变化、轮次锁定、过期会话、stale context 和重复 command 都应 fail closed。

现场网络或终端不可用时，使用纸面评分表作为降级方案：记录原始表单编号、轮次、表演、评委席位、录入操作员、录入原因和复核人；恢复后逐条录入并保留纸面引用。纸面录入不是 direct judge 输入，重复录入或错轮次必须停止并转人工复核。

## 恢复与复盘

恢复前由 Admin 确认目标、备份版本、RTO/RPO 和数据保全范围；恢复后运行迁移检查、Django check、健康检查、审计抽样和正式事实计数比对，再由业务负责人批准恢复流量。复盘报告至少包含时间线、影响范围、证据位置、根因、临时措施、永久修复、学校通知决定、保存/删除决定和下一次彩排日期。

原始 token 不得出现在 audit、access log、trace、备份 manifest、导出、Playwright artifact 或错误响应。若发现泄露，按已泄露凭据处理并撤销对应 grant/session，不依赖“尚未使用”的推测。
