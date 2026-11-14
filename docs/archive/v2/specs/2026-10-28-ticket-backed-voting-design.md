# ArtFlow-Plus：票据持有者投票入口

状态：已确认（2026-10-28）
范围：票据投票的公开 Web 入口、票据兑换、票据身份投票状态与 E2E 旅程。
非目标：参与者账号认领/迁移、票据发行后台 UI、票据打印模板、投票结果展示改版。

## 背景

M6 已经完成 ticket credential、一次性兑换、HttpOnly ticket access session、票据身份
ballot 以及重复投票约束；M12 的公开投票页目前只支持 browser/anonymous，遇到
identityPolicy = ticket 会阻断。这样运行时具备票据投票能力，但观众仍不能从真实票据
进入完整投票旅程。

## 决策

- 继续复用既有 /api/tickets/redeem 和 artflow_ticket_session，不新增票据认证模型。
- 票据 credential 通过 /vote/<sessionId>#ticket=<credential> 传递。fragment 不会进入
  HTTP 请求；页面读取后立即用 history.replaceState 清除，避免 credential 留在后续 URL
  与 Referer 中。页面同时提供手工粘贴入口，兼容没有二维码扫描能力的设备。
- 公共投票读接口在存在有效 ticket session 时返回 ticketReady = true，并按该 ticket
  计算 voted；无效、过期、撤销或跨活动的 cookie 按未准备处理，不泄露错误详情。
- API 只把有效的 ticket session 解析为 ticketId 传入公共读服务；ballot 提交仍由
  submitBallot 在活动锁和投票场次锁下重新验证票据 session、ticket 状态和活动归属。
- ballot/audit/event 只保留 ticketId 或 digest 等非 credential 信息；原始 credential 不
  出现在响应持久化、日志字段或事件 payload 中。
- browser/anonymous 页面行为保持不变；投票场次的 identity policy 仍由冻结 ruleset
  决定，客户端不能降级为其他身份。

## 公共读契约

GET /api/public/vote/:sessionId 继续只公开 formal、非 draft 场次，并新增：

    {
      // existing fields...
      ticketReady: boolean
    }

当 identityPolicy != ticket 时 ticketReady 恒为 false。ticket 场次仅在 cookie 对应的
access session 有效、属于同一 activity 且其 ticket 仍可使用时为 true；公开响应不返回
 ticketId、credential、票数或身份明细。

## 页面流程

1. 页面读取公共投票数据。
2. browser 场次沿用现有 browser identity cookie 流程。
3. ticket 场次若响应 ticketReady = false：先消费 URL fragment 中的 credential，或显示
   票据输入框；调用 /api/tickets/redeem，成功后重新读取公共数据。
4. ticketReady = true 且 voted = false 时显示候选与提交按钮，提交 body 使用
   { identity: { type: "ticket" } }，原始 credential 不进入 ballot 请求。
5. 刷新页面通过 HttpOnly cookie 恢复 ticketReady 和 voted；票据已投时显示已投状态。

错误提示：无效/重复/过期/撤销票据统一提示“票据无效或已使用，请联系工作人员”；投票
本身仍复用既有 DUPLICATE_BALLOT、VOTE_SESSION_CLOSED 等错误映射。

## 数据库与迁移

不新增迁移。ticket_access_session、ticket、ballot.ticket_id 及既有唯一索引已经
承载所需状态；只新增公开读所需的 hasBallotForTicket 查询。

## 验收

- 有效票据可从 URL fragment 或手工输入兑换并投票。
- 刷新后不需要再次输入 credential；同一 ticket 在同一场次重复提交被拒。
- 无票据、无效/过期/撤销/跨活动 ticket session 均不能投票。
- ticket 场次不能通过 browser/anonymous 身份提交。
- credential 不出现在 API body、ballot、审计/事件持久化字段或清除后的 URL 中。
- browser/anonymous 现有投票页、公开读、结果发布与实时票数旅程零回归。
- Plus 的相关单测、API 集成测试、Web E2E 和 pnpm -C plus run check 通过；跳过真实
  彩排，不跑全量 Django 测试。
