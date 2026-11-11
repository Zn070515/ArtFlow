# ADR-0040: Live Projection 失败后 block 必须 sticky

- **Status**: accepted
- **Date**: 2026-11-11

## 背景

Outbox Relay 把投票事件投影到 `live_state`。如果某个 `BallotSubmitted` 事件
投影失败，relay 会写入 `status: "blocked"`，但随后仍把该事件标记为 published。
下一个成功事件调用 `upsertLiveState` 时，原来的冲突更新会把 `status` 改回
`running` 并清空 block；读面继续把偏小的 counts 当作当前值。失败事件已经
published，不会再自动重放，系统因此静默进入不一致状态。

Live Projection 是派生便利状态，不是权威计数；但它也不能在失败后假装正常。

## 决策

1. `live_state` 的 blocked 是 sticky 的：普通 `upsertLiveState` 在检测到当前行
   blocked 时直接返回，不写新状态；`applyToLiveProjection` 也不再把后续事件
   叠加到不完整状态上。
2. 读面显式暴露 `stale: true` 与 `blockedReason`，调用方不能把 blocked 计数
   当成当前权威。
3. 恢复必须是显式操作：新增 Worker ops `rebuild-voting-live`，从 durable event
   history 重建该 session 的投影；rebuild 删除旧行后重新写入 `running`。
4. block 不阻塞执行投影或权威命令；它只冻结该投票 Live 投影，直到重建。

## 替代方案

- **失败时阻塞整个 outbox 分区**：会连带停止执行投影和后续命令，影响面过大，
  否决。
- **下一个事件自动重建**：把恢复藏在普通写路径里，故障不可见，且可能与 relay
  并发，否决。
- **继续把 blocked 当 running**：当前缺陷，读面会静默使用错误计数，否决。
- **只在 UI 上提示**：服务端读面仍然撒谎，否决。

## 后果

- Live 计数在 block 后可能停滞，但读面明确标记 stale；HTTP 读面和 rebuild 是
  恢复路径。
- 运维需要执行：
  `pnpm --filter @artflow-plus/worker ops rebuild-voting-live --activity <id> --session <id> --mode <mode>`
- 不变量：`docs/invariants/realtime.md` RT-10。
- 回归测试：`plus/packages/runtime/test/voting-ticket-service.test.ts` 的
  “keeps a blocked live projection sticky until an explicit rebuild”。
