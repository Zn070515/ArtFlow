# M1 Authority and Goal v4 Closure Design

## 目标

依据 `GOAL.md v4` 与 `C:\Users\16275\Desktop\advices\ChatGPT.md`，把现有 ArtFlow 的正式数据权威、现场录分可靠性和生产运行契约收口。完成后，任何正式状态、身份、结果和权限变更都必须经过可审计的业务服务；网络失败、重复请求、旧页面和错误对象不能静默制造错误正式结果。

本设计不提前实现 GOAL 的 M2 QR Ticket、JudgeSeat、JudgeSession 或评委直连评分；只修复当前已有 Staff/Rapid Score 流程所需的 M1 能力。

## 范围与不变量

### 必须保持的产品不变量

1. Activity 是活动级 aggregate root；正式活动只有一个写入 authority。
2. `FORMAL` 数据不能回到测试生命周期；测试清理只能删除命令拥有的测试运行数据。
3. 原始评分、criterion score、投票、轮次 roster/group/performance 和正式结果各自有明确 authority，不能通过换 FK 搬到未锁定对象逃避保护。
4. `StageAwardDecision` 是候选事实；只有已确认的 StageResult 才能物化为正式 `Award`。
5. 结果缺失、冲突、同分未裁决或规则不明时保持 HOLD/REVIEW，不猜测。
6. 客户端 pending draft 只是待提交 command 缓存，不是第二个正式数据库。
7. 部员保持一个统一的日常 Staff 角色；主席/部长共用最高业务权限，技术 superuser 仅作为维护机制。
8. 根 `docker-compose.yml` 继续只代表 development/integration；生产演练必须使用显式的生产 manifest，PPT 播放不纳入 ArtFlow authority。

### 本次明确不做

- 不引入微服务、Kafka、Kubernetes、Redis Cluster 或新的异步队列。
- 不恢复“锁定投票自动生成最佳人气奖”的旧 authority。
- 不把 IP、观众姓名或客户端缓存当成真实身份或正式结果 authority。
- 不通过减少测试、跳过 Windows 或降低安全门禁解决 CI 问题。

## 架构设计

### 1. Authority 防线

在 `common.authority` 增加 `ACCOUNT_AUTHORITY` 与必要的测试清理 scope。Activity、ContestRound、VoteSession、User 的受保护字段在 instance `save`、QuerySet `update/delete`、`bulk_create`、`bulk_update`、`_base_manager` 上统一检查。创建路径只允许合法初始状态：Activity 为 DRAFT/未锁定，ContestRound 为 DRAFT/未锁定/zero score version/初始 advancement，VoteSession 为关闭且未锁定。正式父对象不能通过 hard delete 绕过 child guard：只有测试、草稿且未被正式结果消费的对象可按明确 service 清理；正式生命周期通过 ARCHIVED 或 unlock/reset service 处理。

User 的 `role`、`is_active`、`is_superuser` 是账户 authority 字段，普通 ORM 和 Admin change view 只读。现有 `change_user_role`、`set_user_active` 在锁定并重读最后管理员状态后，进入 `ACCOUNT_AUTHORITY` scope 保存并写 AuditLog。开发管理员 provisioning 走 management command 的显式路径。

SingerRegistration 的 `activity_id/user_id` 与 Judge 的 `activity_id` 创建后不可迁移；正常资料字段和 Judge active 状态仍可修改。已有 raw fact、snapshot、StageResult、Award provenance 的保护继续由各自 model/queryset/service 负责，并纳入统一 matrix，避免只保护页面路径。

### 2. Rapid Score 可靠提交

前端每次通过本地校验的改动先写入 `localStorage` pending record，再发 POST。record 至少包含 activity、round、API endpoint、base_version、pending cells、client `command_id` 和更新时间。页面同时显示服务端已保存数量与本机待提交数量；有 pending 时刷新/离开给出提示，重新进入同一轮次恢复 pending。网络失败不删除 pending，使用退避重试，`online` 事件和显式按钮都可触发重试。

409 不清空 dirty state。客户端先取得最新 grid，把服务端未改变的 cell 自动 rebase 到本地 pending；同一 cell 同时改变则显示显式冲突，保留两边值并要求工作人员选择。服务器不接受客户端猜测的上下文，仍校验 activity、round、judge/operator、entry 与 score version。

后端新增 PostgreSQL/SQLite 兼容的 `ScoreWriteReceipt`（或等价命名）模型，唯一键为 `command_id`，记录 operator、operation、payload hash、结果版本、结果状态/载荷和时间。receipt 与 ScoreRecord 变更在同一 transaction 内提交：相同 command 与相同 hash 返回首次结果；相同 command 不同 payload 返回 `IDEMPOTENCY_CONFLICT`。该抽象保留给未来 Judge direct scoring 复用，但本次只接入现有 Rapid Score API。

### 3. 部署、限流和文档契约

新增 `deploy/compose.production.yml`，通过生产 env 文件注入配置，不硬编码开发口令，`APP_ENV=production`，web 不直接公网暴露，反向代理承担 TLS，PostgreSQL 只在 internal network，数据库和 media 使用持久卷，healthcheck 与生产拓扑一致。新增 event/local-only profile 说明，使现场可在本机运行；公网 tunnel 只作为入口，不作为正式 authority。

生产 rate limit 使用共享 PostgreSQL 表，按 key、窗口起点、计数和过期时间做事务安全的原子递增；开发/test 保留 LocMem。Admin login 与 vote passcode 共用 backend，IP 只作粗粒度节流。

更新 production readiness 与 rehearsal runbook，删除投票锁定自动生成人气奖的旧契约，改为 Ruleset AWARD → StageAwardDecision → StageResult confirm → Award materialize，并覆盖重复确认、旧候选、解锁重算和 stale candidate。新增生产 manifest 配置检查与相关文档检查。

## 文件与模块边界

- `common/authority.py`：scope 定义和线程局部 authority 上下文。
- `accounts/models.py`, `accounts/services.py`, `accounts/admin.py`：账户字段 guard、业务服务和 Admin 只读入口。
- `core/models.py`, `core/services.py`, `core/admin.py`：Activity 初始状态/删除保护和生命周期服务。
- `singer_contest/models.py`, `singer_contest/services.py`, `singer_contest/tests.py`：轮次删除、报名/评委 identity、Rapid Score receipt、已有结果 authority。
- `voting/models.py`, `voting/services.py`：VoteSession 删除保护和测试清理协作。
- `staff_panel/views.py`, `staff_panel/forms.py`：sequence 表单、command_id 传递、明确冲突响应。
- `static/js/rapid_score.js`：pending store、重试、恢复和冲突 UI。
- `deploy/compose.production.yml` 与 `scripts/`：生产/event manifest、配置门禁和验证脚本。
- `docs/production-readiness.md`, `docs/production-rehearsal-runbook.md`：正式演练契约。
- `common/test_authority_matrix.py`：跨模型、跨 ORM 入口的领域 invariant 参数化测试。

## 错误处理与安全

- 未授权 mutation 返回 `ValidationError`/`PermissionDenied`，不依赖模板隐藏按钮。
- 跨活动、跨轮次、跨投票会话和 stale version 请求拒绝并指出对象上下文；不产生 partial mutation。
- 幂等冲突返回稳定 reason code；客户端保留本地输入，不静默覆盖。
- 所有高风险服务在 transaction 中锁定 parent、重新读取 authority、验证后写入并审计。
- 私有文件继续走 controlled media view；生产日志不记录完整敏感 payload。
- 生产配置必须通过 `manage.py check --deploy`，不得用开发 Compose 伪装生产配置。

## 验证策略

每个批次采用 RED → GREEN → REFACTOR：先增加最小失败回归并确认失败原因，再实现最小修复。至少覆盖：

1. 三个 parent 的非法创建、bulk_create、删除和 `_base_manager` 路径。
2. User authority 与最后管理员保护。
3. SingerRegistration/Judge identity 迁移与已准备轮次引用。
4. Rapid Score pending 恢复、网络重试、响应丢失幂等、不同 cell rebase、同 cell 冲突。
5. duplicate sequence 的表单错误与连续默认创建。
6. 生产 manifest、`check --deploy`、本机 event fallback 和 shared rate limit 的 PostgreSQL 并发语义。
7. 人气奖新 authority 演练和统一 authority mutation matrix。

最终门禁：`makemigrations --check --dry-run`、`check`、`check --deploy`、完整 Django/pytest suite、Ruff、mypy、CSS、文档检查、Docker PostgreSQL acceptance、PostgreSQL concurrency、production compose config check、backup/restore rehearsal。所有门禁完成后，对代码做两轮独立自审：第一轮核对 authority/数据流/错误语义，第二轮核对安全边界、并发、迁移、部署和 GOAL v4 不变量。

