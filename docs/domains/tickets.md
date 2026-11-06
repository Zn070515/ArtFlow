# Ticketing / Capabilities / Access（capability）

## 目的

把“谁能进入哪个现场动作”变成可验证、可失效、不可重放的凭证；公开的活动码
只用于定位，不授予任何权限。

## 实体与值

- `Ticket`：一张可恢复凭证；只存哈希/摘要，不存明文。
- `TicketAccessSession`：一次扫码后的会话；绑定 ticket 与过期时间。
- `JudgeEntryCapability`：活动级的评委入口凭证；带版本与 HMAC。
- `JudgeSeatGrant` / `AccessGrant`：一次性领取席位/资源的授权。
- `EphemeralSession`：短时、可撤销的现场会话。

## 生命周期

Capability 级（入口/票据发放）：

```text
DRAFT → OPEN → CLOSED
```

单张票据/凭证：

```text
ISSUED → REDEEMED → EXPIRED / REVOKED
```

- 关闭入口只拒绝新 claim，不驱逐已领取的会话（TIC-02）。
- 重新签发立即让旧凭证失效，但不影响已建立会话的继续使用。

## 流程

```text
staff 签发票据/评委入口
  → 用户扫码（fragment/一次性链接）
  → 解析 capability 定位活动
  → 锁活动行
  → 对锁定行重验 capability/version/入口状态
  → 领取 seat/session
```

## 不变量

- **TIC-01** public code 不是凭证；权限动作必须持有独立 capability（TICK-01）。
- **TIC-02** 重新签发递增版本，旧凭证立即失效；关闭入口只拒绝新 claim，不驱逐
  已领取的会话（TICK-02）。
- **TIC-03** claim 必须“解析 → 锁 → 重验 → 领取”，不能信任解析阶段（TICK-03）。
- **TIC-04** 投票 session 显式声明 `ticket`、`browser` 或 `anonymous` 身份策略；
  ticket 身份决定票据投票唯一性，browser 只用于显式允许的无票场景，anonymous 不
  得由客户端从其他身份降级而来。
- **TIC-05** 原始 token 不落库、不进日志/URL/导出；使用 HttpOnly cookie 或
  fragment（TICK-05）。
- **TIC-06** 未授权请求不泄漏活动/席位是否存在（TICK-06）。
- **TIC-07** 公共入口按 actor/IP 限流，后端故障策略显式（TICK-07）。

## 事件

`TicketIssued`、`TicketRedeemed`、`TicketRevoked`、
`JudgeCapabilityIssued`、`JudgeCapabilityReissued`、`JudgeEntryClosed`、
`JudgeSeatClaimed`、`AccessGrantIssued`、`AccessGrantRedeemed`。

## v1 参考

- `tickets/models.py`、`tickets/services.py`
- `singer_contest/judge_entry.py`、`singer_contest/judge_authority.py`
- `entry_access/models.py`
- 事故：`docs/incidents/admin-reauth-405.md`（相邻的再验证语义）

## Plus 要求

- Capability 是领域对象，签发/验证/失效都有命令与审计。
- 版本是行上事实；验证在锁内完成。
- Token 只以哈希/摘要持久化；日志层有脱敏。
- 限流是网关 + 应用双层，但正确性不依赖限流。

## 待决问题

- 是否支持一次性链接（magic link）替代纸质二维码？需要定义重放窗口。
- 票与座位的物理模型（是否选座）不在 v2.0 范围，但凭证模型要允许扩展。
