# ADR-0045: 站外邮件通知走 outbox 消费者

- **Status**: accepted
- **Date**: 2026-11-18

## 背景

站内通知已经存在，但报名确认、审核结果、节目单发布和赛果发布仍依赖组织者
在微信群里手动通知。密码重置已经接入 SMTP，但活动通知没有投递路径。

直接在命令事务里发信会把外部 I/O 放进 authority 事务，重试还可能重复发送；
让每个 capability 自己写一张通知表则会复制投递逻辑。

## 决策

1. 新增 `notification_cursor` 与 `notification_delivery`。worker 以独立通道
   `email` 扫描 `outbox`，按事件类型解析收件人并在同一事务内写入待投递行、
   推进 cursor。
2. 首次启用时把 cursor 推进到当前 outbox head，避免把历史事件全部补发。
3. 投递在事务外执行；失败写入 `attempts/last_error`，3 次后置 `failed`，
   成功置 `sent`。唯一键 `(event_id, channel, recipient)` 保证重放不重复。
4. 覆盖事件：`RegistrationSubmitted`、`RegistrationReviewed`、
   `ScheduleReleased`、`ResultReleased`。报名类事件发给该报名者；日程/赛果
   发给该活动的 approved 报名者。
5. 只使用账号已登记的邮箱；没有邮箱的账号跳过。没有 SMTP 或
   `ARTFLOW_PLUS_EMAIL_NOTIFICATIONS != 1` 时消费者不发信。
6. 邮件正文包含活动名、状态说明和对应公开/个人中心链接；纯文本与 HTML 同时
   提供。

## 替代方案

- **命令内同步发信**：把网络 I/O 放进权威事务，失败回滚或重复发送，否决。
- **每个 capability 写通知表**：复制投递、重试、去重逻辑，否决。
- **一次性扫描全部历史事件**：启用时会补发旧报名/旧赛果，否决。
- **引入消息队列**：现有 outbox + worker 已足够，否决。

## 后果

- 通知是至少一次投递；唯一键保证同一事件/收件人只发一次。
- 没有退订和偏好中心；需要后续补充。
- 只有 approved 报名者收到日程/赛果；未登记邮箱的参与者仍依赖站内通知。
- 投递状态目前只落库，没有管理 UI；失败可从 `notification_delivery` 查询。
