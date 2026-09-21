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
| 闭场的“可核定”必须与 `PUBLISH_RESULT` 活动阶段策略一致 | `activity_phase_not_ready`、精确状态标记和浏览器 UI 彩排 |

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

`m2_d1_result_closure_mutation_rehearsal.mjs` 是本机 Compose 专用的黑盒彩排：fixture
命令只在非 production 创建测试活动、管理员会话、当前/陈旧/跨活动结果；Node 脚本随后真实
调用 confirm、重复 confirm、stale confirm、Award archive、带原因 unlock，以及伪造
`activity_id` 的 archive。归档检查会继续解包内层 XLSX，不能只检查外层 ZIP 字节；报告中的
重复确认、陈旧拒绝和正式来源泄漏计数由 web 容器内 inspector 读取数据库后填入。脚本拒绝
非回环 HTTP 地址，不打印 cookie 或 token：

闭场页面的浏览器彩排使用 `data-stage-status`、`data-result-version` 和
`data-input-fingerprint-prefix` 这类精确 machine-readable 标记；不能用“核定并锁定”或
“上游已核定”等页面文案的包含关系代替状态断言。管理员解锁必须从阶段详情页渲染的
`data-stage-result-unlock-form` 提交，并验证解锁后的持久化状态回到
`ready_to_confirm`。

```powershell
$containerFixture = "/tmp/artflow-m2-d1-result-closure-$PID.json"
$hostFixture = Join-Path ([IO.Path]::GetTempPath()) "artflow-m2-d1-result-closure-$PID.json"
docker compose exec -T web python manage.py prepare_result_closure_rehearsal --output-file $containerFixture
docker compose cp "web:$containerFixture" $hostFixture
$env:ARTFLOW_CLOSURE_FIXTURE_PATH = $hostFixture
$env:ARTFLOW_REHEARSAL_BASE_URL = "http://127.0.0.1:8000"
try { node scripts/m2_d1_result_closure_mutation_rehearsal.mjs }
finally {
  [IO.File]::Delete($hostFixture)
  docker compose exec -T web rm -f -- $containerFixture | Out-Null
}
```

该脚本是有限本地彩排，不是公网 DDoS；每个请求超时 5 秒，且不 reset 数据库或 volumes。
它验证单线程 HTTP mutation/export 边界，不替代 PostgreSQL 并发确认、WAF/边缘 DDoS、学校
IdP/MFA 或真实现场角色流程。测试完成后必须清理 fixture 活动、会话和临时文件。

## 本轮证据记录

| 字段 | 值 |
| --- | --- |
| 变更 commit | `1ca9171`（彩排工具）；`9893683`、`8ce5b60`（测试 Award cleanup authority）；`49863de`、`672aeac`（门禁修复） |
| 数据库/服务 | Docker Compose web + PostgreSQL，`127.0.0.1:8000` |
| HTTP 总请求/并发 | 7 / 1（confirm、replay、stale、3 次 archive、unlock） |
| p50/p95/p99/max、2xx/3xx/4xx/5xx、timeout | 67.87 / 248.80 / 248.80 / 248.80ms；3 / 4 / 0 / 0；0 |
| duplicate confirm / stale rejection / official-source leakage | 0 / 1 / 0；数据库 inspector 与内层 XLSX 检查均通过 |
| token/secret leakage / official-source leakage | 必须为 0；任何非 0 立即 FAIL |
| PostgreSQL 并发、备份恢复、浏览器流程 | Docker 不可用时 `BLOCKED`，不得以 SQLite PASS 替代 |
| 学校 IdP/MFA/TLS/WAF/DDoS/留存 | 外部责任，`HOLD` |

### 2026-09-21 M2-D1-GATE-CLOSE mutation/export 执行记录

| 指标 | 实际值 | 判定 |
| --- | --- | --- |
| HTTP black-box mutation/export | 7 requests；2xx=3、3xx=4、4xx=0、5xx=0、timeout=0 | PASS |
| latency | p50=67.87ms、p95=248.80ms、p99=248.80ms、max=248.80ms | PASS；本机隔离服务，不外推公网容量 |
| confirm replay | 首次与重复确认均 302；`confirm_audit_count=1`、`duplicate_confirm_count=0` | PASS；幂等且不重复物化 |
| stale candidate | stale confirm 302；`stale_rejection_count=1`、stale audit=0 | PASS；旧 fingerprint 未被核定 |
| confirmed archive | 当前 Award marker=true，foreign marker=false | PASS；检查到内层 `award_list.xlsx` |
| unlock 后旧来源 | 当前/foreign marker 均 false；source Award row=1、official current Award=0 | PASS；旧正式来源 fail closed |
| forged `activity_id` archive | 当前/foreign marker 均 false | PASS；query 不能改变 path authority |
| fixture cleanup | 8 个测试活动 runtime residue 清理；5 个临时 operator 失活；source volumes 未 reset | PASS |

本轮运行中发现并修复一项测试清理 authority 缺口：已确认测试赛段的来源 Award 原先会阻断
`clear_activity_test_data()`；现在仅在显式 `TEST_DATA_CLEANUP` scope 且由测试数据清理服务
调用时允许清理，正式 Award authority 路径不放宽。新增回归测试覆盖 confirmed StageResult
及其 Award 的清理。

## M2-D2 公示 authority 交接边界

M2-D1 的 `CONFIRMED` 只代表内部结果 authority，不自动代表公网可见。M2-D2 增加独立的
`ResultRelease`：结果文章的 `PUBLISHED` 仍是编辑状态，必须再由当前管理员在闭场通过后以
非空原因创建 `ACTIVE` release。公共首页、结果列表、详情和受控媒体必须全部经过同一
release-aware 查询；撤销、解锁、更新结果、版本或 ruleset 变化均应 fail closed，并保留
历史 release 记录。归档索引只记录 release 状态、结果版本和时间，不复制完整 fingerprint、
authority hash、token、评分或学生隐私。

这一层仍不是学校 SSO/MFA、TLS/WAF、volumetric DDoS、留存审批或部署 ownership 证据；
这些项目继续单独标记 `HOLD`，不得用应用 release 审计替代。

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

因此本地 M2-D1 authority、PostgreSQL、浏览器、HTTP mutation/export 彩排和恢复证据已通过；
PostgreSQL 并发确认、学校外部责任项和真实现场角色仍是放行前置条件。

## 阈值与处置

- 任意 5xx、timeout、越权成功、旧来源可见、完整 fingerprint/secret 回显：`FAIL`，停止后续压力，保留脱敏请求摘要和 correlation ID。
- SQLite 单测可证明业务分支和 serializer 不变量，但不能证明 PostgreSQL 行锁、恢复、连接池或真实反代行为。
- 本地应用级有限压力通过也不能推出 volumetric DDoS 能力；该项必须由部署方在批准窗口使用边缘/WAF/供应商证据验收。
