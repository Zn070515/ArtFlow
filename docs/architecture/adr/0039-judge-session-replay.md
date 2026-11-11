# ADR-0039: Judge session token 由 session id 确定性派生

- **Status**: accepted
- **Date**: 2026-11-11

## 背景

`ticketing.judge_seat.claim` 在事务中创建 judge session，并把一次性
`sessionToken` 放进响应。回执为了不持久化明文 token，只保存
`{ ...body, sessionToken: null }`。如果事务提交成功但 HTTP 响应丢失，客户端用
同一 `commandId` 重试会命中回执，拿到 `sessionToken: null`；席位已经被占用，
客户端没有可用凭证，也没有重新签发入口。

Ticket redeem 已经用 `onReplay` 重新计算 access token；judge claim 遗漏了同等
的恢复 seam。不能通过持久化明文 token 或重新创建 session 来解决。

## 决策

judge session token 由 `sessionId` 与服务端 `credentialSecret` 确定性派生：

```text
HMAC-SHA256(secret, "AF1.JS." + sessionId) -> 前 32 个 hex 字符
token = "AF1.JS." + sessionId + "." + signature
```

首次响应返回该 token；`persistedBody` 仍把 token 置空；同一 `commandId` 的
重放通过 `onReplay` 用持久化的 `sessionId` 重新计算同一个 token。原始 token
不落库，`judge_session.token_digest` 仍只存哈希。

## 替代方案

- **持久化明文 token**：违反 TICK-05，否决。
- **持久化可逆密文**：需要额外的密钥管理与轮换边界，收益不足，否决。
- **重放时创建新 judge session**：席位已占用，会产生第二个 session，且破坏
  command 的幂等语义，否决。
- **重放返回 null**：当前缺陷，客户端无法恢复，否决。

## 后果

- 同一 claim 的首次响应与重放返回同一 session 的可用 token；恢复不再依赖
  客户端保留首次响应。
- token 是确定性的，`credentialSecret` 轮换会使旧 session 失效，这与 ticket
  access token 的既有语义一致。
- 回归测试：`plus/packages/runtime/test/voting-ticket-service.test.ts` 的
  “replays a judge claim with a usable session token”，以及 API
  `apps/api/test/live.test.ts` 的重放 cookie 用例。
- 不变量：`docs/invariants/tickets.md` TICK-08。
