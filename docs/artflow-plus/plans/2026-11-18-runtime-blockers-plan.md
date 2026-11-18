# 2026-11-18 运行 blocker 修复计划

状态：已完成（2026-11-18）

范围：只修复“真实活动会失败或无法恢复”的运行 blocker，不包含多租户、计费、邮件、SSO 等商业/交付项。资料上传上限统一改为 **600 MiB**。

## 目标与验收

1. 公共面在单个出口 IP（场馆 NAT）下可承载 500+ 观众、8+ 评委；合法流量不因 per-IP 限流被拒。
2. API 在生产可输出结构化请求/错误日志，并暴露受保护的 Prometheus 指标。
3. 资料上传/下载全程流式，支持 HTTP Range；600 MiB 单文件不再造成 API 内存爆涨。
4. DB 连接池可配置，查询/锁等待有上限；投票不再串行锁整个 activity。
5. 归档压缩不阻塞 event loop；ZIP 在事务内异步构建，活动锁仍按归档语义持有。
6. 投影 dead-letter 可在 Ops 页面恢复，不依赖生产容器外的 CLI。
7. 会话滑动续期；备份默认不冻结业务写入；Compose 日志轮转。
8. 600 MiB 在 domain、API、nginx、Caddy、k8s 资源与文档中口径一致。

## 非目标

- 多租户、计费、自助开户、邮件/短信、MFA/SSO。
- 单 PostgreSQL 的高可用与 PITR；只记录部署要求。
- v2 release tag；发布由维护者在验证后单独执行。

## 实施顺序

1. 配置与口径：600 MiB、DB 池/超时、代理信任、日志、指标、会话续期、日志轮转。
2. 公共限流：浏览器 visitor 身份 + 可配置上限 + 每 IP 滥用上限；Web 端统一发送 visitor 头。
3. 媒体流式化：存储流接口、上传临时文件、下载 Range、归档下载流。
4. 投票锁：以 vote session + execution session 行锁替代 activity 行锁；补并发测试。
5. 归档：fflate 异步 ZIP，避免阻塞 event loop；落库与活动锁语义保持不变。
6. 投影恢复：runtime 管理服务 + 受权 API + Ops 按钮 + worker 镜像内置 ops CLI。
7. 备份：默认去掉全表写锁；Compose 日志轮转；k8s 资源调整。
8. 文档：roadmap、README、development-baseline、deployment-production、public-api、backup-restore。

## Test architecture

- **Contracts / capabilities touched**：materials（上限与流式内容）、voting（ballot 锁）、archive（构建与落库边界）、engine（投影恢复管理动作）。复用现有 descriptor/lifecycle/authorization/idempotency 契约，不新增业务契约。
- **Consumers / read models affected**：所有公开读（活动站、投票入口、电子票、反馈）、评委终端、Ops Diagnostics、Live 投影、归档下载、材料下载。改动前用 `graph:check` 看反向影响；不新增未声明的消费者。
- **Lifecycle edges / terminal guards / mode isolation**：ballot 在 execution session 关闭前后的接受/拒绝边界；archive 仍要求 `closed` 且 revision 不变；投影恢复只操作 `(activity, mode)`，不读取/写入 formal 事实；测试/彩排/正式分区不变。
- **Adapters**：沿用 `registration`、`voting`、`archive` 现有 adapter；只为“并发关闭执行会话 vs ballot”增加一个使用真实 PostgreSQL 双连接的用例，不复制模板。
- **Fault injection**：上传流中途断开（临时文件清理、无半写入）、下载 Range 非法（416）、归档 ZIP 构建失败（无 package 行、无遗留文件）、投影 blocked 后 retry/rebuild、DB 连接池耗尽（超时错误映射）。
- **Why existing tests are insufficient**：现有测试只用小 Buffer，不覆盖 600 MiB / Range / 流中断；投票并发只测重复 ballot，不测“执行会话关闭 vs ballot”；dead-letter 只测 worker 函数，不测 HTTP/UI 恢复路径。
- **Anti-bloat**：扩展 `material-storage`、`archive-storage`、`voting-session-service`、`DiagnosticsCard` 的现有测试；不新增 per-endpoint 矩阵，不把 600 MiB 写进每个用例（用常量 + 一个小文件模拟流）。
- **Focused gates**：
  - `pnpm -C plus --filter @artflow-plus/runtime test`
  - `pnpm -C plus --filter @artflow-plus/api test`
  - `pnpm -C plus --filter @artflow-plus/web test`
  - `pnpm -C plus run check`
  - `REQUIRE_DB=1 pnpm -C plus run test`
  - `pnpm -C plus --filter @artflow-plus/contract-tools run graph:check`
  - `uv run pytest tests/gates -q`、`check_docs.ps1`

## 证据计划

- 上传流测试：分段写入临时文件、超限拒绝并清理；API 级材料下载断言 `206` 与 `Content-Range`（不写入 600 MiB 大文件）。
- 双连接并发：一个事务持 execution session 行锁，`closeExecution` 必须等待；释放后 ballot 返回 `SESSION_NOT_RUNNING`，关闭后不写入。
- 投影恢复：`POST /api/activities/:id/projections/formal/retry` 在未阻塞时返回 `{retried:false}` 并写审计；Ops 组件在 blocked 状态显示重试/重建按钮。
- 归档：现有归档/完整性/失败清理用例继续通过；异步 ZIP 由 runtime 包测试覆盖。
