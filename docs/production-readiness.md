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
`uv run python manage.py purge_ticket_sessions` 清理。扫描页先取得同源 CSRF token，
再以 body-only `POST` 兑换；缺少或不匹配 CSRF token 的跨站请求不能设置票据会话。

配置了 `VoteSession.requires_ticket` 的投票，提交时必须持有同活动、未过期、未撤销且
已 `CHECKED_IN` 的票据会话。`VoteBallot.ticket` 是 PROTECT 关系，数据库约束保证同一
票据在同一投票场次最多产生一张 ballot；浏览器 session 和 IP 只用于兼容性、幂等和
滥用信号，不构成投票资格。未启用 ticket 的旧投票仍按浏览器 session 去重且 ballot
不附带 Ticket。

工作人员入口现已闭环：`/staff/tickets/manage/` 提供活动、批次、编号和状态筛选及
生命周期统计；`/staff/tickets/issue-page/` 支持 1–100 张原子批量签发并在不落盘的
响应中输出一次性 QR；`/staff/tickets/check-in-page/` 支持 POST 检票和重复扫描提示；
详情页只显示非敏感生命周期元数据，作废/撤销仍由已验证管理员执行。既有 JSON API
保持兼容并统一禁止缓存。公共扫描页会区分 `issued`（尚未获得投票资格）与
`checked_in`（具备票券投票资格，仍受当前投票场次状态约束）。

彩排必须逐项验证：重复扫码/兑换、未检票票、作废/撤销票、过期 cookie、跨活动票、
同票并发投票、同浏览器换票、无票旧流程，以及 TEST cleanup 不触碰 FORMAL Ticket、
ballot 和 audit。数据库故障时 `doctor` 只报告连接失败，不继续查询票据表；doctor、
备份 manifest 和 audit 只输出非秘密计数/元数据。

应用限流和 body 上限不等于 DDoS 防护。TLS 洪泛、慢连接、连接数上限、volumetric
DDoS、WAF challenge/黑名单和学校公网入口审批仍由部署方、学校网络或边缘服务负责，
必须在正式接入前单独验证并保留证据。

## M2 渐进式能力门禁

### M2-C Judge authority / 学校接入准备状态

M2-C 已建立 immutable panel snapshot、JudgeSeat、JudgeSession、server-owned live context、direct judge score receipt、STAFF_PROXY 和 PAPER_DR 来源边界，以及 typed terminal 的内存 bearer 与安全草稿边界。judge 请求不接受客户端选择的 activity、round、judge、seat、singer、source 或 panel；expected context 只作 stale-page equality guard。

恶意彩排不再只验证 13 个事件日错误场景；完整的 authority、会话/CSRF、输入解析、竞态、资源消耗、配置库存、学校 SSO/MFA、DDoS 分层和恢复矩阵见 [`m2-c-malicious-rehearsal-matrix.md`](m2-c-malicious-rehearsal-matrix.md)。本地压力仅限隔离环境的 bounded rehearsal；公网 DDoS、真实 IdP/MFA、TLS/WAF、学校网络和留存责任必须由部署方提供独立证据。

M2-C 的本地代码门禁已覆盖模型 authority guard、命令幂等、重复事实、跨来源 provenance、跨 origin/无 bearer 的 HTTP 失败路径、客户端草稿不落 token 和 stale-context 显示。PostgreSQL 锁顺序/并发验收、真实 Playwright credential flow、学校 IdP/SSO、MFA、TLS/WAF/DDoS、数据责任与保存期限仍是部署前置条件，未被本地 SQLite 或静态检查替代。

学校接入的责任清单见 [学校接入准备清单](school-onboarding.md)，异常取证与纸面 DR 见 [事件响应与证据链](incident-response.md)。

### M2-D1 Result authority / Event-day closure

M2-D1 增加只读的 Staff 闭场预检，统一检查当前冻结赛制、当前结果版本、输入指纹、原始轮次/投票锁定、上游赛段核定和正式 Award/晋级入口来源。`READY_TO_CONFIRM` 仍只是候选；只有 `StageResult.status == CONFIRMED` 才是内部正式结果 authority。预检不写入 StageResult、Award、RoundEntry、锁或审计，也不替代 `confirm_stage_result()` 事务内的二次 freshness 检查。

稳定阻塞码包括：`NO_CURRENT_FROZEN_RULESET`、`RULESET_BINDING_INVALID`、`RAW_FACTS_INCOMPLETE`、`RAW_FACTS_UNLOCKED`、`RULE_REVIEW_REQUIRED`、`UPSTREAM_CONFIRMATION_PENDING`、`STALE_CANDIDATE`、`STAGE_CONFIRMATION_PENDING` 和 `ACTIVITY_OPERATIONALLY_LOCKED`。Staff 页面只展示状态、版本、数量和阻塞码，不展示学生隐私、评分明细、评委备注、bearer、secret 或完整输入指纹。结果板入口为 `/staff/activity/<activity_id>/result-closure/`，只接受 GET。

活动日闭场顺序固定为：最后一批输入审计 → 只读预检 → 逐阶段确认 → 再次预检 → 核对结果板/主持手卡/Award/下游入口 → 保存证据 → 交给后续独立公开发布门禁。解锁必须由管理员带非空原因执行；解锁后的旧来源立即退出正式 Award/导出，新候选必须重新 resolve 和确认。

M2-D1 的本地 PASS 只证明内部 authority 闭合，不证明学校 SSO/MFA、代理 header、TLS/WAF、volumetric DDoS、数据保存期限、备份责任或学校批准接入。上述外部证据仍单独保持 `HOLD`。

本轮恶意彩排的详细矩阵、脚本边界和量化字段见
[`m2-d1-result-closure-matrix.md`](m2-d1-result-closure-matrix.md)。历史只读 HTTP 脚本不能替代
确认重放、stale reject、旧来源导出和 PostgreSQL row-lock 证据；未执行字段必须标记
`BLOCKED`/`NOT EXERCISED`，不能用 0 伪装为通过。本轮已补执行单线程 mutation/export
运行时脚本，但不把它解释为 PostgreSQL 并发或学校公网容量证据。

每个新增能力必须保留此前已经建立的门禁，并同步加入自己的边界验证；门禁通过不等于
已经具备 Production 资格。

| 能力 | 必须通过的本地/CI 门禁 | 标记 Production 前的额外场景 |
| --- | --- | --- |
| M2-A 临时入口基础 | `entry_access` scoped Pyright、mypy、Django/pytest、PostgreSQL 测试、Playwright runtime smoke | 真实 Staff/公共兑换彩排、撤销/重放、恢复 |
| JudgeSeat / JudgeSession | TypeScript client check、Playwright 浏览器流程、PostgreSQL 并发测试 | 缺席评委、过期会话、`STAFF_PROXY`、纸笔 DR |
| Ticket / Check-in | TypeScript client check、服务测试、operator page/issue→redeem→check-in→vote 回归 | PostgreSQL 并发、完整 Playwright 凭据流程、重复票/已检票现场演练、公共端失败 DR |
| 电子直录分 | 类型化 payload/state client、Playwright 提交/重试流程、PostgreSQL 竞态测试 | ACK 丢失、重复命令、错误目标、panel 变化 HOLD |
| Production 发布 | 以上全部门禁、彩排脚本、安全门禁、备份/恢复证据 | 真实角色现场彩排并保留报告 |

门禁覆盖随能力推进扩大，不允许为了通过新能力而静默移除既有门禁。Playwright 初始
检查只读的 `/healthz/`；进入 Judge/Ticket 流程后，测试必须使用可丢弃数据，携带 bearer
token 的用例关闭 trace/video/screenshot，避免凭据进入测试产物。

### 2026-09-11 M2-D1 Task 6 执行记录

闭场相关定向 Django 回归为 `31 passed`；全量 Django 回归为 `1122 passed, 29 skipped`。
Compose PostgreSQL acceptance 为 `1122 passed, 3 skipped`，新增 PostgreSQL 并发确认专项为
`1 passed`。Pyright baseline、entry-access、Ruff、Node syntax、TypeScript client 25 项和文档
检查均通过。CSS gate 曾发现闭场模板生成物未同步，已由独立提交修复并复跑通过。Compose
Playwright smoke 为 `7 passed`；HTTP 只读闭场彩排为 27 请求/并发 8，p50/p95/p99 为
5.75/14.40/23.71ms，2xx/4xx/5xx 为 0/1/0，timeout 与 token/secret 泄露均为 0。custom-format
备份恢复在隔离目标通过，源数据库与源卷未重置。确认 mutation/export 的独立运行时脚本仍
未执行，不能把这些字段伪装成 HTTP attack PASS。具体矩阵和边界见
[`m2-d1-result-closure-matrix.md`](m2-d1-result-closure-matrix.md)。

### 2026-09-21 M2-D1-GATE-CLOSE mutation/export 执行记录

Docker Compose web + PostgreSQL 在 `127.0.0.1:8000` 上执行了 7 个隔离 HTTP 请求：
2xx=3、3xx=4、4xx=0、5xx=0、timeout=0；p50/p95/p99/max 为
`50.96/63.52/63.52/63.52ms`。首次确认和重复确认均为 302，数据库 inspector
报告 `confirm_audit_count=1`、`duplicate_confirm_count=0`；陈旧结果被拒绝，
`stale_rejection_count=1` 且没有 stale confirm audit。确认后的内层 `award_list.xlsx`
只含当前活动 Award，不含 foreign marker；带原因 unlock 后旧来源 Award 仍保留 1 行
供追溯，但正式 queryset 为 0；伪造 query `activity_id` 也未改变结果。正式来源泄漏计数为 0。

彩排期间还发现测试清理服务无法删除“已确认测试赛段”的来源 Award；已在
`TEST_DATA_CLEANUP` authority scope 下修复并加入回归测试，正式 Award 生成/修改 authority
没有放宽。彩排 fixture 的 6 个测试活动 runtime residue 已清理，3 个临时 operator 已失活，
源数据库和 volumes 未 reset。学校 SSO/MFA、TLS/WAF、volumetric DDoS、数据责任和真实
现场角色仍保持 `HOLD`，PostgreSQL 并发确认仍需独立验收。

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
$judgeFixture = Join-Path ([IO.Path]::GetTempPath()) "artflow-judge-e2e-$PID.json"
uv run python manage.py prepare_judge_e2e --output-file $judgeFixture
$env:PLAYWRIGHT_JUDGE_FIXTURE_PATH = $judgeFixture
try { npm run test:e2e } finally { Remove-Item -LiteralPath $judgeFixture -Force -ErrorAction SilentlyContinue }
```

该 fixture 只在非 production 环境创建测试活动、评委席位、一次性 grant 和当前表演；命令不会把 grant 写入 stdout。Compose/CI 必须在 web 容器内生成后用临时文件复制给 Playwright，不能把原始 grant 放进 workflow 日志；完整的 Compose 步骤见 `.github/workflows/integration.yml`。

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

### 2026-09-08 M2-B 本地恶意边界彩排记录

本次是本地工程彩排，不是学校接入或真实活动彩排。测试数据使用本地可丢弃数据库；没有把真实票据 secret 写入日志、测试产物或数据库。

| 时间 | 参与者 | 场景 | 结论 | 录分到 READY 时间 | 实际恢复时间 | 已知风险 | Plan B |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 2026-09-08 | 自动化 Django 测试与 Playwright 请求；真实参与者 0；Staff/Judge/Audience 未模拟 | Ticket 生命周期、authority/锁定规则、重复/跨活动/撤销/过期/换票/并发边界；公共扫描页与 body-only redeem 边界 | PASS（代码与公共边界）；完整 Staff 签发→扫码→投票浏览器流程未执行 | 未测量：本次不含评分录入 | 本地 SQLite 迁移后 Playwright 3/3 通过；完整 pytest `1045 passed, 30 skipped`；Ruff、mypy、Pyright、客户端/CSS、Django、文档与工作流门禁通过 | Docker Engine 当前不可用，PostgreSQL 并发、Compose 验收、备份/恢复未在本机重跑；完整凭据型 Staff 浏览器彩排、真实 TLS/WAF/学校网络 DDoS 演练仍为 HOLD | 票据或投票异常时暂停发布，改用纸质登记/人工核验；保留源库与媒体卷，待部署方提供可控 PostgreSQL/边缘环境后再复测 |

补充：首次直接在容器内运行完整测试时漏掉了验收脚本的 root-only `/app/.env`
fixture，导致 1 个配置测试因权限失败；按现有验收脚本补齐 fixture 后，单测和完整
`948` 测试均通过。镜像仍保持非 root `artflow` 运行，未为测试放宽 `/app` 写权限。

### 2026-09-08 M2-C 本地 authority / 学校准备门禁记录

本轮已完成本机代码门禁：全仓库 Django 测试 `1090 tests, OK (skipped=28)`，
客户端编译与 `25 passed` 客户端测试通过，项目 Pyright、entry-access Pyright 均为
`0 errors, 0 warnings, 0 informations`；Ruff format/check、mypy（275 source files）、
CSS、Django check、migration check 和文档检查均通过。新增 judge authority focused
测试覆盖 direct/proxy/paper provenance、命令幂等、重复事实、stale context、跨 origin
失败、无 bearer、rubric 精确集合/服务端总分、事务回滚和客户端 token 不落草稿。

本轮 Docker/Compose 已可用。当前源码重建 `web` 镜像后，PostgreSQL focused authority
回归为 `42 tests, OK`；custom-format backup/isolated restore 成功，恢复目标上的 Django
check 通过，且源数据库与 volumes 未被重置。当前源码临时 `8002` 服务上的 Playwright
浏览器 smoke 为 `6 passed`。这些结果不替代学校生产接入验收：真实凭据型 Judge 流程、
学校 IdP/SSO、MFA、TLS/WAF/DDoS、数据责任与保存期限仍为部署前置 `HOLD`。

因此，M1 的代码、自动化验收和本地技术恢复彩排已完成；M1-J 的“正式现场彩排”
仍待真实参与者、真实部署域名和人工步骤完成后才能最终关闭。

### 2026-09-08 M2-C2 Staff 现场评委控制面板门禁记录

本轮完成 server-rendered Staff 控制台：实际到场评委与 Panel 准备、一次性 Judge QR、表演切换、Panel/表演 HOLD-resume、STAFF_PROXY 和 PAPER_DR。视图只调用 judge authority service；新增测试覆盖普通用户拒绝、未准备上下文恶意 POST、最低人数 HOLD、重复 grant、QR 明文不回显、stale context、评分幂等和来源绑定。

本机门禁结果：Django 全仓 `1080 passed, 28 skipped`；C2/authority focused `27 passed`；Playwright `6 passed`；client `20 passed`；项目 Pyright 与 entry-access Pyright 均为 0 diagnostics；Ruff、Django check、migration check、文档检查和 CSS/client gates 通过。PostgreSQL focused C2/authority `27 passed`，并完成 Compose 容器内 migrate、doctor、seed 幂等与 reset safety 检查；源数据库和 volumes 保持不变。

完整 `verify_postgres_acceptance.ps1 -StartCompose` 本轮未能启动，因为本机既有开发服务占用 `127.0.0.1:8000`；没有停止或删除该服务/volumes，改用无 host-port 的 Compose one-off focused 验证。完整 PostgreSQL acceptance、备份恢复、带真实 Staff 凭据的浏览器控制台流程、TLS/WAF/DDoS 和学校网络演练仍为部署前置 HOLD。

### 2026-09-08 M2-C3 Judge Client Close 门禁记录

本轮闭合 Judge terminal 的 server-owned 展示上下文、分项评分、即时本地草稿、按上下文隔离、2 秒短轮询和 stale recovery。rubric 轮次必须提交完整 criterion 集合；服务端计算 0–100 总分，并在同一 authority 事务中写入 `ScoreRecord`、`CriterionScore`、receipt 和审计。无 rubric 的历史总分模式继续保留；客户端不保存 bearer、二维码 fragment 或额外个人信息。

已覆盖的本地回归包括：上下文展示字段、rubric 精确集合、跨 rubric/越界/重复/缺项、伪造总分、事务回滚、STAFF_PROXY 一致性、稳定 HTTP reason code、输入未提交草稿、性能切换草稿隔离、polling、HOLD 状态展示和分项请求体。完整门禁结果待本轮最终验证后补录；PostgreSQL 竞态、真实凭据型 Judge 浏览器流程、学校 IdP/MFA、TLS/WAF/DDoS、数据责任与保存期限仍是部署前置 HOLD。

### 2026-09-08 M2-C-GATE 门禁收口记录

M2-C-GATE 将完整项目 Pyright 与 entry-access Pyright 都设为 Linux CI 阻塞门禁，
并在 PostgreSQL integration 的完整测试前加入 Judge authority focused gate，覆盖
`singer_contest.test_judge_authority`、`singer_contest.test_judge_http` 和
`staff_panel.tests.JudgeControlHTTPTests`。门禁契约测试同时防止这些命令被移除、降级
为 `continue-on-error` 或放到完整套件之后。

本地证据：Django 全量 `1090 tests, OK (skipped=28)`；PostgreSQL Judge focused
`42 tests, OK`；backup/isolated restore 通过且源 volumes 未重置；Playwright `6 passed`；
client `25 passed`；两个 Pyright 配置均为 0 diagnostics；Ruff、mypy、CSS、Django、
migration 和文档检查通过。GitHub Actions 最近一次 push 的所有 job 在 runner step
开始前即以 0 秒失败、没有可读取的 step 日志，属于外部 runner/account 级异常，不能被
本地结果冒充为远端 CI 通过；修复远端 Actions 服务后必须重新观察该 Gate。

本 Gate 仍不宣称学校接入完成。真实凭据型 Judge 现场流程、学校 SSO/IdP、MFA/重新认证
批准、TLS/WAF/DDoS、数据责任与保存期限、事件联系人和正式现场彩排继续保持部署前置
`HOLD`。

### 2026-09-08 M2-C 恶意彩排与压力测试量化记录

本轮是本机隔离栈的 bounded rehearsal，不是公网 DDoS，也没有经过学校网络、WAF、
TLS 终端或第三方 IdP。使用最新源码构建的临时 `web` 容器，连接现有 PostgreSQL
16 容器；`RATE_LIMIT_BACKEND=database`，服务映射为 `127.0.0.1:18000`，单请求
超时 5 秒，最大并发 32。测试脚本为
[`scripts/m2_c_malicious_rehearsal.mjs`](../scripts/m2_c_malicious_rehearsal.mjs)，
所有 Judge fixture 均为非生产一次性数据。除 redeem 建立 7 个测试会话外，599 个
协议/负载请求均不提交评分、投票、奖项或其他权威事实；7 个 fixture 在测试后通过
`clear_activity_test_data` 清理，测试活动仅按既有契约保留配置壳。

| 攻击集合 | 请求/并发 | 状态分布 | p50 / p95 / p99（ms） | 结论 |
| --- | ---: | --- | ---: | --- |
| 非法方法、跨源、坏 JSON、超大 body（5 probes） | 5 / 1 | 405、405、403、400、413 各 1；canary 未回显 | 27.60 / 27.60 / 27.60（最长单探针） | PASS |
| 匿名 Judge context 扫描 | 40 / 8 | 30×401，10×429 | 39.46 / 43.54 / 43.65 | PASS；匿名阈值 30/min 生效 |
| 跨源 score 探测突发 | 64 / 16 | 64×403；写入 0 | 78.73 / 91.38 / 94.77 | PASS；Origin 边界生效 |
| `/healthz/` 有界压力 | 320 / 32 | 320×200，错误 0 | 170.54 / 176.41 / 177.97；max 179.34 | PASS；189.05 req/s，墙钟 1692.67ms |
| 6 个合法 Judge session、同一出口 IP | 120 / 6 | 120×200，429 为 0 | 84.73 / 88.68 / 89.76；max 89.83 | PASS；合法 session 未互相限流 |
| 单个合法 Judge session 配额攻击 | 50 / 10 | 45×200，5×429 | 239.34 / 259.72 / 260.49；max 260.49 | PASS；session 阈值 45/min 精确生效 |

本轮包含 5/5 协议探针、594 个负载请求和 7 个 redeem setup 请求，共 606 个本地
HTTP 请求；没有超时、连接错误或 5xx。Django authority/恶意边界回归为
`331 passed, 4 skipped, 53 subtests passed`；4 个 skip 是需要 PostgreSQL 行锁的
测试，并非 HTTP 彩排失败。修复后的专门 test-data cleanup 回归为 `1 passed`。

#### 权威与清理证据

| 项目 | 实测值 |
| --- | ---: |
| 测试活动中的 `RoundJudge` / panel snapshot / seat / grant / session | 全部 0（清理后） |
| 测试活动中的 Performance / run state / ScoreRecord / CriterionScore | 全部 0（清理后） |
| 全局 `ScoreRecord` | 5 |
| 全局 `CriterionScore` | 0 |
| 全局 `JudgeScoreReceipt` | 1 |
| 全局 `Award` | 1 |
| 全局 `VoteRecord` | 2 |

第一次运行发现两处运行时/清理问题并在本轮修复：只读 `/healthz/` 在真实 CSRF
中间件下原先返回 403 而不是源码契约中的 405；Judge test fixture 清理原先因
`RoundPanelSnapshotMember.source_round_judge`、`PerformanceRunState` 和受保护的
临时授权行无法完成。现在只读健康端点显式 exempt CSRF，测试清理通过明确的
`TEST_DATA_CLEANUP`、Judge panel/session authority 和 performance authority 顺序
拆除 disposable graph；正式活动的 snapshot/authority 保护路径不变。

本轮判定：**PASS（本地技术彩排）**。它证明了当前容器配置下的协议边界、限流分层、
同出口合法评委隔离和健康端点有界吞吐；它不证明公网抗 DDoS、WAF 容量、学校 NAT
规模、IdP/MFA、TLS、备份保留期限或事件响应时限。上述项目继续保持部署前置 `HOLD`，
必须由部署方提供独立证据和负责人签字。
