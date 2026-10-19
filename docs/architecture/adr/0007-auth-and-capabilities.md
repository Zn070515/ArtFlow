# ADR-0007: 本地会话 + capability token；公开码不是凭证

状态：proposed（2026-10-19）

## 背景

v1 的评委入口曾只要知道公开活动码就能领取真实席位；票据、access grant、评委
capability 都需要可验证、可失效、不可重放。学校 SSO 尚未确定，不能把 v2 锁死
在某一个 IdP 上。

## 决策

- **人员会话**：服务端 session cookie（HttpOnly、SameSite），角色为
  participant/judge/staff/admin；SSO 作为可插拔适配器。
- **现场 capability**：HMAC 签名、带版本与作用域；token 放在 URL fragment 或
  HttpOnly cookie，不进 query/日志/Referer。
- **公开码**：只用于定位（`/e/<code>/`），不授予任何写权限。
- **验证顺序**：解析 capability → 锁聚合 → 对锁定行重验版本/入口状态 → 领取。
- **再验证**：敏感 action 的二次验证只刷新身份，恢复点必须是可安全 GET 的
  页面，不重放原 POST。
- **限流**：按 actor/IP 分层；后端故障策略显式。

## 后果

- 需要 capability 的签发/轮换/失效命令与审计；
- SSO 接入不改变领域授权模型，只替换“谁已登录”；
- token 泄露窗口由版本轮换控制。

## 替代方案

- **公开码即权限**：v1 已证明会被人猜到/转发，否决。
- **JWT 自包含权限**：撤销/换权困难，且需要密钥分发；改用短时 capability +
  服务端会话，否决 JWT 作为主授权载体。
