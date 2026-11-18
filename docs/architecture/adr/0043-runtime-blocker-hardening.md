# ADR-0043: 现场运行加固 —— 公共限流身份、流式材料、投票锁与恢复入口

- **Status**: accepted
- **Date**: 2026-11-18

## 背景

在一次真实活动规模的审计中，领域 authority 层没有发现会写错结果或丢事实的
缺陷；问题集中在现场运行：

1. 公共读按 `request.ip` 限流，场馆 NAT 下几十个观众就会把 120/min 打满；
   默认 `ARTFLOW_PLUS_TRUST_PROXY` 为空时，所有访客共用 nginx 容器地址。
2. 资料上传/下载使用 128 MiB 的 Buffer，下载不支持 Range；100 MiB 视频在
   1 GiB 的 API 容器里几个并发就能 OOM。
3. pg pool 默认 5、无 `statement_timeout`/`lock_timeout`；ballot 先锁 activity
   行，千人投票会排队到 5 秒连接超时。
4. 归档在事务内同步 `zipSync`，阻塞 event loop 并长时间持有活动锁。
5. 投影 dead-letter 只能通过源码树里的 `ops` CLI 恢复，生产镜像没有该入口。
6. 会话绝对 8 小时；备份对全部用户表加写屏障；容器日志无轮转；生产没有
   应用日志和指标。

## 决策

1. **公共限流身份**：浏览器发送稳定的 `x-artflow-visitor`；公共读按 visitor
   计数，写请求额外保留每 IP 上限（`ARTFLOW_PLUS_PUBLIC_IP_CEILING_MULTIPLIER`，
   默认 200）。Compose 固定 `172.28.0.0/16`，信任代理覆盖 Caddy 与 nginx 两跳。
2. **材料上限 600 MiB**：`MAX_MATERIAL_UPLOAD_BYTES` 是领域硬上限，Pack 默认值、
   API 传输、nginx、Caddy、k8s 资源与文档统一到该值。
3. **流式材料**：上传直接写入临时文件（内存 O(64 KiB)），attach 时采用
   `putFile`；下载与归档下载使用 `readStream`，支持单段 HTTP Range。
4. **数据库护栏**：默认 pool 20、连接超时 10s、`statement_timeout` 30s、
   `lock_timeout` 15s；迁移使用独立的短生命周期 pool，两个超时都为 0。
5. **ballot 锁顺序**：ballot 先锁 vote session，再读 activity（不加锁），最后
   `FOR UPDATE` 锁 execution session。`execution.close` 仍按 activity → session
   顺序；两者不会形成循环，且 ballot 不会在关闭后写入。
6. **归档**：ZIP 使用 fflate 的异步实现，不再阻塞 event loop；归档仍要求
   `closed` 与 revision 不变。
7. **恢复入口**：`projection.retry` / `projection.rebuild` 进入 runtime 管理服务，
   暴露为受 `studio.manage` 保护的 HTTP 路由，并在 Ops Diagnostics 提供按钮；
   worker 镜像内置 `ops.cjs`，API 镜像内置 `create-account.cjs`。
8. **会话与备份**：会话在后半段滑动续期；备份默认依赖 `pg_dump` 的 MVCC 快照，
   写屏障改为 `ARTFLOW_BACKUP_WRITE_LOCK=1` 可选。
9. **可观测性**：生产启用 pino 请求/错误日志；`/metrics` 在设置
   `ARTFLOW_PLUS_METRICS_TOKEN` 后提供 Prometheus 文本；Compose 日志 50 MiB × 5
   轮转。

## 替代方案

- **把所有公共限流改成全局令牌桶**：失去对单浏览器滥用者的约束，否决。
- **继续 Buffer 上传、只把上限加到 600 MiB**：内存会随上限线性增长，否决。
- **让 ballot 直接锁 activity 但扩大连接池**：锁仍是串行瓶颈，只是把失败推迟，
  否决。
- **归档改异步任务与轮询**：需要新的任务状态面和 UI，当前收益不足以支付复杂度；
  先消除 event loop 阻塞，保留同步命令语义。
- **用 Redis 做公共限流**：单实例部署没有收益，PostgreSQL 限流桶已足够。

## 后果

- 公共面在单个 NAT 出口下可承载数百观众；每 IP 写上限仍能约束伪造 visitor id。
- 600 MiB 文件不再进入 Node 堆；Range 支持断点/拖动，但 nginx 侧仍会有一次
  请求体缓冲（已关闭 `proxy_request_buffering`）。
- ballot 与 execution.close 的竞态由 session 行锁裁决：要么 ballot 先成功，要么
  关闭后返回 `SESSION_NOT_RUNNING`。
- 归档仍持有活动锁直到包落库；但不再冻结整个服务，且受 lock timeout 约束。
- 生产恢复不再需要源码树；Ops 按钮与审计记录成为常规路径。
