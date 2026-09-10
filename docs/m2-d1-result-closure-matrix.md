# M2-D1 结果闭场恶意彩排矩阵

本矩阵只允许在本机或专用隔离环境执行。目标是验证 `StageResult`、`StageAwardDecision`、`Award` 和原始事实锁定之间的 authority 边界，不是证明公网抗 DDoS。默认脚本最多 32 个请求并发、单请求 3 秒超时，禁止对学校网络、公共域名或第三方服务发压测。

## 放行不变量

| 不变量 | 证据 |
| --- | --- |
| 候选结果不能进入正式 Award 列表/导出 | `official_stage_award_queryset()` 回归测试与旧来源泄漏计数 |
| 旧版本、旧 fingerprint、非当前 ruleset 不能核定 | service regression、确认异常和 `STALE_CANDIDATE` |
| 跨活动 URL、query、Award/source decision 不能改变当前活动结论 | activity scope tests、closure GET probe、跨活动来源测试 |
| 闭场预检只读 | `CaptureQueriesContext` 无 INSERT/UPDATE/DELETE/FOR UPDATE，计数不变 |
| GET 不能触发状态变化，闭场页面拒绝 POST | 405、StageResult/Award/RoundEntry/AuditLog 计数不变 |
| 并发确认最多一个正式确认轨迹 | PostgreSQL `TransactionTestCase`；SQLite 不得替代此证据 |
| raw token、secret、完整 fingerprint 不进入页面/报告 | serializer prefix 测试、响应 canary 扫描 |

## 本地自动化矩阵

| ID | 攻击 | 预期 | 覆盖 |
| --- | --- | --- | --- |
| AUTH-CLOSURE-01 | 用不存在的 `stage_key`、`result_id`、`activity_id` query 参数污染闭场页 | 只按 path activity 读取；query 不改变结果，不回显伪造 ID | `ResultClosureServiceTests`, `ResultClosureViewTests`, rehearsal |
| AUTH-CLOSURE-02 | 用另一活动的 StageResult/Award/source decision 拼接正式来源 | 查询结果排除跨活动来源，0 official-source leakage | service regression |
| AUTH-CLOSURE-03 | 用旧 `result_version` 或已确认的旧行重放 confirm | 拒绝 stale，只有当前 candidate 可核定；重复当前确认保持幂等 | confirmation tests |
| AUTH-CLOSURE-04 | 修改输入 fingerprint、ruleset current 状态后继续确认 | 拒绝并要求重新 resolve；旧行不进入正式读取 | stale confirmation/closure tests |
| AUTH-CLOSURE-05 | 活动已操作锁定时请求闭场/核定 | 闭场显示 `activity_operationally_locked`，确认不越过锁 | closure service/view tests |
| AUTH-CLOSURE-06 | 同时确认、解锁、重算同一活动/赛段 | 由 Activity 行锁串行化；最多一条确认审计、一个来源 Award，无孤儿 confirmed trail | PostgreSQL-only concurrency tests；Docker unavailable 时 HOLD |
| PRIV-CLOSURE-01 | 读取闭场页并扫描 token、secret、Authorization、完整 fingerprint | 只允许状态、计数、阻塞码和 fingerprint 前缀 | serializer/view/script |
| METHOD-CLOSURE-01 | 对 GET-only 闭场 URL 发 POST | HTTP 405，业务计数不变 | view test/rehearsal |
| DOS-CLOSURE-01 | 本地闭场页有限并发读取 | 无 5xx、无 timeout；记录 p50/p95/p99 和状态分布 | bounded rehearsal |

## 彩排脚本

启动隔离的本地 web 服务后设置测试活动 ID；如要验证工作人员页面，用一次性测试 Staff cookie 设置 `ARTFLOW_STAFF_COOKIE`。脚本拒绝非回环 HTTP 地址，不打印 cookie：

```powershell
$env:ARTFLOW_REHEARSAL_BASE_URL = "http://127.0.0.1:18000"
$env:ARTFLOW_CLOSURE_ACTIVITY_ID = "<test-activity-id>"
$env:ARTFLOW_STAFF_COOKIE = "<test-only-cookie>"
node scripts/m2_d1_result_closure_rehearsal.mjs
```

脚本是只读 HTTP 彩排，报告中的 `duplicate_confirm_count`、`stale_rejection_count` 和 `official_source_leakage_count` 在该脚本中固定为 0，并同时列入 `not_exercised_by_read_only_script`；它们不能被解释为确认并发或导出测试已通过。确认 replay、stale reject、旧 Award 导出和 PostgreSQL row-lock 必须以 Django/PostgreSQL 证据补齐。

## 本轮证据记录

| 字段 | 值 |
| --- | --- |
| 变更 commit | 待 Task 6 提交后填写 |
| 数据库/服务 | SQLite 单测；Docker/PostgreSQL 状态待记录 |
| HTTP 总请求/并发 | 脚本执行后填写；默认 27 / 8 |
| p50/p95/p99、2xx/4xx/5xx、timeout | 脚本 JSON 原样保存后填写 |
| duplicate confirm / stale rejection / cross-activity rejection | Django 测试与脚本 JSON 分开记录 |
| token/secret leakage / official-source leakage | 必须为 0；任何非 0 立即 FAIL |
| PostgreSQL 并发、备份恢复、浏览器流程 | Docker 不可用时 `BLOCKED`，不得以 SQLite PASS 替代 |
| 学校 IdP/MFA/TLS/WAF/DDoS/留存 | 外部责任，`HOLD` |

### 2026-09-11 Task 6 执行记录

| 指标 | 实际值 | 判定 |
| --- | --- | --- |
| Django 闭场/authority 回归 | 22 passed, 1 PostgreSQL-only skipped | SQLite 代码证据 PASS；并发证据 BLOCKED |
| Pyright baseline / entry-access | 0 / 0 diagnostics | PASS |
| Ruff、文档检查、Node syntax | PASS | PASS |
| Docker daemon / PostgreSQL | Compose acceptance：`1122 passed, 3 skipped`；PostgreSQL 并发确认专项：`1 passed` | PASS；skip 仍按各测试声明记录 |
| 本地 HTTP 服务 `127.0.0.1:8000` | 27 请求 / 并发 8；p50 5.75ms、p95 14.40ms、p99 23.71ms；2xx=0、4xx=1、5xx=0、timeout=0 | PASS；4xx 是匿名 mutation 的预期拒绝 |
| duplicate confirm / stale rejection / official-source leakage | Django 回归覆盖；HTTP 只读脚本明确未执行 mutation/export | 本地 authority PASS；HTTP mutation/export NOT EXERCISED |
| token/secret leakage | serializer/view/Playwright/HTTP 响应扫描均为 0 | PASS |
| Playwright smoke | 7 passed；Judge redeem、ACK-loss retry、幂等 receipt、Ticket boundary 均覆盖 | PASS |
| backup/restore | custom-format dump；隔离恢复目标 `manage.py check` 通过；源库/源卷未重置 | PASS |
| 学校 IdP/MFA/TLS/WAF/DDoS/留存 | 未在部署方环境执行 | HOLD |

因此本地 M2-D1 authority、PostgreSQL、浏览器、HTTP 只读彩排和恢复证据已通过；确认 mutation/export 的独立运行时恶意脚本仍未执行，学校外部责任项仍是放行前置条件。

## 阈值与处置

- 任意 5xx、timeout、越权成功、旧来源可见、完整 fingerprint/secret 回显：`FAIL`，停止后续压力，保留脱敏请求摘要和 correlation ID。
- SQLite 单测可证明业务分支和 serializer 不变量，但不能证明 PostgreSQL 行锁、恢复、连接池或真实反代行为。
- 本地应用级有限压力通过也不能推出 volumetric DDoS 能力；该项必须由部署方在批准窗口使用边缘/WAF/供应商证据验收。
