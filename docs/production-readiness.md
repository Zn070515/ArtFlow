# Production Readiness Rehearsal

ArtFlow 首次正式活动前必须完成一次完整彩排，并保留验证记录。目标不是只确认 happy path，而是确认错误、重试、并发和恢复路径不会污染正式数据。

## 事件日检查矩阵

| 场景 | 验证 | 通过标准 |
| --- | --- | --- |
| 评分缺评委 | 少录一个评分后尝试普通锁定 | 锁定被拒绝，并显示具体选手与评委 |
| 损坏 Excel | 后部单元格使用非法、超范围或非有限值 | 全表解析失败，数据库没有本次导入的部分写入 |
| 角色降级 | `staff` 改为 `participant` 后访问后台 | `is_staff` 同步清除，后台立即拒绝 |
| 伪造 ID | POST 使用另一活动的选手、节目或投票选项 ID | 请求被拒绝，跨活动数据不产生 |
| GET mutation | 对所有锁定、解锁、切换、导入和生成 URL 发 GET | 返回 405 或只渲染页面，不改变状态 |
| 并发投票 | 同一浏览器重复提交，不同浏览器共享出口 IP 提交 | 同一浏览器只有一张 ballot；不同浏览器不因 IP 被误伤 |
| 测试数据残留 | 测试模式创建报名、票、评分、奖项和文件后退出 | 未清理时不能退出；清理同时移除数据库行和媒体对象 |
| 当前媒体替换 | 同一用途上传多个版本并删除当前版 | 只有一个当前版本，删除后自动恢复最近历史版 |
| 解锁改分重锁 | 锁定、管理员带原因解锁、改分、重新锁定 | 缺分仍不能锁定，评分审计含 old/new 明细 |
| AWARD 核定与重算 | Ruleset AWARD resolve 后检查候选、核定、重复核定，再解锁并改变输入重算 | 候选不冒充正式奖项；核定只物化一次；stale 候选被拒；解锁后的旧奖项不进入正式列表/导出 |
| 过期评分 Excel | 导入名单/评委名单/规则版本或指纹与当前轮次不一致的工作簿 | 全表拒绝，0 partial mutation，提示“名单过期/版本过期/指纹不匹配”（§15.5） |
| 大视频直传 | 正式活动 POST 超过 `ARTFLOW_VIDEO_UPLOAD_MAX_MB` 的演唱/背景视频 | 被拒“正式活动不支持大视频直传”，正式报名页不出现视频字段；测试活动仍可传（§15.6） |
| PostgreSQL 恢复 | 创建备份并在隔离数据库恢复 | `pg_restore` 成功、Django check 通过，源卷未被重置 |

## 奖项 authority 演练契约

正式奖项链路是：

```text
AWARD → StageAwardDecision → CONFIRM → Award
```

Ruleset resolver 先把 AWARD 节点输出写成 `StageAwardDecision`，其父
`StageResult` 此时只能是候选状态（通常为 `READY_TO_CONFIRM`）。候选不得进入正式
Award 列表或导出。只有 `confirm_stage_result()` 验证当前冻结赛制、最新 result
version、input fingerprint 和已消费输入后，才把赛段改为 `CONFIRMED` 并物化
`Award`。重复核定必须幂等，不能产生重复 Award。

`StageResult.status == CONFIRMED` 才是赛段来源 Award 的正式 authority。Staff
正式奖项列表和 `award_list` 导出只显示无赛段来源的历史 Award，或
`source_stage_result.status == CONFIRMED` 的 Award。

`VoteSession` 锁定本身不会创建 `Award`。当 AWARD 节点确实消费投票时，该
VoteSession 只是核定前必须静止的原始输入，且其 `purpose` 必须与冻结绑定一致；
不依赖投票的 AWARD 不需要 VoteSession。不得恢复“锁投票即颁奖”的旧流程。

演练还必须覆盖 stale 与解锁路径：输入或最新结果版本变化后，旧候选必须拒绝核定，
先重新 resolve 再核定；解锁已核定 StageResult 后，其已物化 Award 因来源赛段不再
`CONFIRMED` 而退出正式列表/导出。修正输入产生的新候选必须重新核定，旧候选和旧
Award 只保留可追溯性，不能冒充当前正式奖项。

`Award.source_vote_session` 仅作为历史行可能仍需的 legacy provenance 保留。它不再
授权 Award 创建、重算或替换；删除该字段或清理历史值前，必须先审计真实历史数据并
通过显式迁移处理。

## M2-A 入口访问能力状态

M2-A 当前标记为 `EXPERIMENTAL`，只提供工程基础能力，不代表 Judge/Ticket 的正式业务
流程已经上线。已具备的边界是：Staff/Admin 可创建入口并签发一次性短期 grant；公共兑换
必须使用显式 `POST` body token，生成的 ephemeral session 具有更短有效期和精确的
activity/round/kind 范围；grant/session 均可由 Staff/Admin 撤销。GET 兑换、未知/过期/已
撤销授权以及错误范围的会话都不会改变状态或返回差异化的敏感信息。

`M2-A-FINAL` 已关闭反向代理下的限流边界：兑换端点使用受配置保护的
`common.audit.client_ip()` 同时作为限流 bucket 和兑换审计 IP。因而在 Caddy 等可信代理
后面，不同真实客户端不会因共享容器 `REMOTE_ADDR` 而互相串桶；未启用可信代理时仍只
使用直接连接地址。兑换请求体上限和基础速率限制也属于该边界的一部分。

grant 和 session 只在成功的签发/兑换响应中返回一次原始 token，数据库、审计记录和只读
Admin 检查页不保存或展示原始 token。公共兑换端点是刻意的无 cookie、body-only bearer
边界，因此不依赖 CSRF cookie；Staff 的签发和撤销仍走登录会话与 CSRF 保护。后续接入
JudgeSeat、正式扫码页或业务工作区前，仍必须完成 PostgreSQL 并发/恢复彩排和真实角色
流程验证；因此 M2-A 继续保持 `EXPERIMENTAL`，不会被误标为 Judge/Ticket 已上线。

## M2-B Ticket / Check-in / Audience Entitlement

M2-B 的票据是非个人化的权威输入：Ticket 只保存 SHA-256 digest、活动和库存标识，
原始 secret 只在 Staff 签发响应中出现一次。生命周期由服务层审计并锁定活动与票据：
`CREATED → ISSUED → CHECKED_IN`，另有受控的 `VOID/REVOKED` 终态。公开兑换只生成
短期 HttpOnly `artflow_ticket_session` cookie，不改变票据状态；过期会话可通过
`uv run python manage.py purge_ticket_sessions` 清理。

配置了 `VoteSession.requires_ticket` 的投票，提交时必须持有同活动、未过期、未撤销且
已 `CHECKED_IN` 的票据会话。`VoteBallot.ticket` 是 PROTECT 关系，数据库约束保证同一
票据在同一投票场次最多产生一张 ballot；浏览器 session 和 IP 只用于兼容性、幂等和
滥用信号，不构成投票资格。未启用 ticket 的旧投票仍按浏览器 session 去重且 ballot
不附带 Ticket。

彩排必须逐项验证：重复扫码/兑换、未检票票、作废/撤销票、过期 cookie、跨活动票、
同票并发投票、同浏览器换票、无票旧流程，以及 TEST cleanup 不触碰 FORMAL Ticket、
ballot 和 audit。数据库故障时 `doctor` 只报告连接失败，不继续查询票据表；doctor、
备份 manifest 和 audit 只输出非秘密计数/元数据。

应用限流和 body 上限不等于 DDoS 防护。TLS 洪泛、慢连接、连接数上限、volumetric
DDoS、WAF challenge/黑名单和学校公网入口审批仍由部署方、学校网络或边缘服务负责，
必须在正式接入前单独验证并保留证据。

## M2 渐进式能力门禁

每个新增能力必须保留此前已经建立的门禁，并同步加入自己的边界验证；门禁通过不等于
已经具备 Production 资格。

| 能力 | 必须通过的本地/CI 门禁 | 标记 Production 前的额外场景 |
| --- | --- | --- |
| M2-A 临时入口基础 | `entry_access` scoped Pyright、mypy、Django/pytest、PostgreSQL 测试、Playwright runtime smoke | 真实 Staff/公共兑换彩排、撤销/重放、恢复 |
| JudgeSeat / JudgeSession | TypeScript client check、Playwright 浏览器流程、PostgreSQL 并发测试 | 缺席评委、过期会话、`STAFF_PROXY`、纸笔 DR |
| Ticket / Check-in | TypeScript client check、Playwright 资格流程、服务测试 | 重复票、已检票状态、投票边界、公共端失败 DR |
| 电子直录分 | 类型化 payload/state client、Playwright 提交/重试流程、PostgreSQL 竞态测试 | ACK 丢失、重复命令、错误目标、panel 变化 HOLD |
| Production 发布 | 以上全部门禁、彩排脚本、安全门禁、备份/恢复证据 | 真实角色现场彩排并保留报告 |

门禁覆盖随能力推进扩大，不允许为了通过新能力而静默移除既有门禁。Playwright 初始
检查只读的 `/healthz/`；进入 Judge/Ticket 流程后，测试必须使用可丢弃数据，携带 bearer
token 的用例关闭 trace/video/screenshot，避免凭据进入测试产物。

## 发布门禁

本地静态资源必须从锁定的 npm 依赖构建，运行时 HTML 不得依赖 Tailwind CDN：

```powershell
npm ci
npm run check:css
npm run check:client
npm run test:client
uv run python manage.py collectstatic --noinput --clear
```

应用门禁：

```powershell
uv run ruff format --check .
uv run ruff check .
uv run mypy
npm run check:pyright:entry-access
uv run python manage.py check
uv run python manage.py makemigrations --check --dry-run
uv run pytest -q --cov
pwsh -NoProfile -File scripts\check_docs.ps1
```

运行时浏览器门禁要求服务已启动，并使用本地/Compose 回环地址：

```powershell
npx playwright install chromium
npm run test:e2e
```

PostgreSQL 验收和恢复演练：

```powershell
pwsh -NoProfile -File scripts\verify_postgres_acceptance.ps1 -StartCompose -VerifyResetSafety
pwsh -NoProfile -File scripts\verify_postgres_backup_restore.ps1 -ComposeProjectName artflow -BackupPath backups\artflow-rehearsal.dump
```

备份脚本必须在源服务仍运行时执行。它只创建隔离恢复目标，不允许使用 `down --volumes`、源库 `dropdb` 或任何重置源卷的命令。

## Production Rehearsal Report

每次正式彩排（§15.2 正常 / §15.3 恶意 / §15.4 灾难）完成后，把结果追加到本节。一份报告一场演练；首次正式活动前必须至少完成一份，并把“录分到 READY 时间”和“实际恢复时间”填入。

| 字段 | 内容 |
| --- | --- |
| 时间 | `YYYY-MM-DD HH:MM` |
| 参与者 | Admin / Staff / Participant 各几人，Judge/Audience 是否模拟 |
| 场景 | 正常彩排 / 恶意彩排 / 灾难演练（web crash、PG 重启、media restore、database loss、clean restore） |
| 结论 | PASS / FAIL |
| 录分到 READY 时间 | 从第一张纸质评分录入到最后一次自动 resolve 的耗时 |
| 实际恢复时间 | 从模拟故障到 login/ruleset/score/decision/vote/material/document/archive 全通的耗时 |
| 已知风险 | 本次发现的尚未修复问题 |
| Plan B | 压轴时的降级/绕行方案 |

> 注：`录分到 READY` 需配套 M1-H 的 `round_scores_api` 自动 resolve（`recompute_activity_result`）链路；若评分表在彩排中依赖 Excel 导入，另按 §15.5 用过期工作簿验证全表拒绝。

### 2026-09-07 本地技术彩排记录

本次记录是工程技术彩排，不替代首次正式活动前由真实 Admin / Staff /
Participant / Judge / Audience 参加的现场彩排。

| 时间 | 参与者 | 场景 | 结论 | 录分到 READY 时间 | 实际恢复时间 | 已知风险 | Plan B |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 2026-09-07 17:06–17:18 +08:00 | 自动化 Django TestCase 模拟角色与恶意请求；真实参与者 0；Judge/Audience 未模拟 | 正常流程与恶意输入（容器 PostgreSQL 隔离测试库；948 tests） | PASS（技术彩排） | 未测量：本次未执行真实首张评分到最后一次自动 resolve | 不适用：无故障；完整套件 `948 tests`，`OK (skipped=3)` | 仍需真实角色在运行栈上完成登录、规则、评分、决定、投票、材料、文档和归档串联；媒体替换、大视频限制等人工步骤未执行 | 纸质评分 + Staff 工作区；锁定前人工核对缺分、结果和审计 |
| 2026-09-07 17:06–17:18 +08:00 | 自动化 Django TestCase；真实参与者 0 | 灾难/恢复：web 重启、PostgreSQL 重启、应用备份恢复、PostgreSQL 隔离恢复 | PASS（技术彩排） | 未测量 | web 健康恢复 7.3s；PostgreSQL 重启后健康恢复 6.9s；应用备份恢复脚本 8.2s；PostgreSQL dump 恢复脚本 8.4s；各自恢复后健康检查/Django check 通过 | 尚未在真实域名、TLS、Caddy 和真实媒体负载下演练；生产 `.env`、DNS/ACME 和备份目标仍需活动部署方提供并验证 | 维持源库和媒体卷；切换到纸质评分/人工登记，暂停正式发布，按备份清单恢复到隔离或备用栈后由 Admin 复核再继续 |

补充：首次直接在容器内运行完整测试时漏掉了验收脚本的 root-only `/app/.env`
fixture，导致 1 个配置测试因权限失败；按现有验收脚本补齐 fixture 后，单测和完整
`948` 测试均通过。镜像仍保持非 root `artflow` 运行，未为测试放宽 `/app` 写权限。

因此，M1 的代码、自动化验收和本地技术恢复彩排已完成；M1-J 的“正式现场彩排”
仍待真实参与者、真实部署域名和人工步骤完成后才能最终关闭。
