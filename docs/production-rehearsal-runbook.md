# M1-J 正式彩排 Runbook（Production Rehearsal）

> 配套文档：[production-readiness.md](production-readiness.md)（事件日检查矩阵 + 发布门禁 + 演练报告表）。
> 目的：在首次正式活动前，按事件日矩阵逐项演练，**确认错误/重试/并发/恢复路径不会污染正式数据**。
> 每个场景都给出 **Setup → Execute → Expected** 三列。标 `[automated]` 的步骤已有对应自动化回归（pytest / verify 脚本），标 `[manual]` 的必须人工在运行的栈上点一遍。

## 0. Preflight

```powershell
# 1) 复制生产环境变量清单，逐项替换为真实值（生产配置校验会拒绝占位值）
Copy-Item .env.production.example .env.production
#    APP_ENV=production, DEBUG=False, 非占位 SECRET_KEY/ADMIN_LOGIN_KEY,
#    ALLOWED_HOSTS, CSRF_TRUSTED_ORIGINS, CADDY_SITE_ADDRESS,
#    DATABASE_ENGINE=postgresql + POSTGRES_*（生产 manifest 固定
#    TRUST_X_FORWARDED_FOR=true、POSTGRES_HOST=db）

# 2) 只验证并启动显式生产栈（Postgres + web + Caddy proxy），等待健康检查
docker compose --env-file .env.production -f deploy/compose.production.yml config --quiet
docker compose --env-file .env.production -f deploy/compose.production.yml up --build --wait
Invoke-WebRequest https://<公开域名>/healthz/   # 应返回 200（匿名、仅通用状态）

# 3) 运行时诊断（只读）
docker compose --env-file .env.production -f deploy/compose.production.yml exec web python manage.py doctor    # Configuration/Database/Migration/Directory 全 ok
```

## 1. 发布门禁（自动化）

```powershell
pwsh -NoProfile -File scripts/verify.ps1
```
涵盖：根开发 Compose 容器契约、显式 `deploy/compose.production.yml` 的生产契约与 `docker compose -f deploy/compose.production.yml config --quiet`（只验证配置，不启动或销毁生产服务）、CI workflow 契约、`uv lock --check`、`ruff check .`、`ruff format --check .`、`mypy`、`manage.py check`、`makemigrations --check --dry-run`、`pytest -q --cov`、`check_docs.ps1`、`export-requirements.ps1`、`manage.py check --deploy --fail-level WARNING`。

## 2. PostgreSQL 验收（自动化）

```powershell
pwsh -NoProfile -File scripts/verify_postgres_acceptance.ps1 -StartCompose -VerifyResetSafety
```
涵盖：`migrate`、`doctor`、`/healthz/`（200）、`seed_demo_data` 连续两次（幂等）、`seed_demo_data --reset` 后重播（仅清 command-owned/test-marked 行）、在容器内跑 `manage.py test`。终态：**服务与卷原样保留**。

## 3. 备份 / 恢复演练（自动化）

### 3.1 数据库恢复（PostgreSQL）

```powershell
# 生成 custom-format dump 到 backups\，恢复到隔离容器 artflow_restore，
# pg_restore --list / --no-owner / --exit-on-error，SELECT 1 FROM django_migrations，
# 再对隔离库跑 manage.py check。源库与卷不被 reset。
pwsh -NoProfile -File scripts\verify_postgres_backup_restore.ps1 -ComposeProjectName artflow -BackupPath backups\artflow-rehearsal.dump
```

### 3.2 应用级备份（数据库 + 媒体 + manifest）

```powershell
# 备份集合：backups\<tag>\{database.dump, media.tar.gz, manifest.json}
pwsh -NoProfile -File scripts\backup_artflow.ps1 -OutputDirectory backups -ComposeProjectName artflow

# 恢复到隔离库 + 只读媒体，跑 manage.py verify_app_backup --manifest
pwsh -NoProfile -File scripts\verify_app_backup_restore.ps1 -ComposeProjectName artflow
```

## 4. 事件日检查矩阵（13 场景）

> 在运行的 Compose 栈上执行。`staff:` = `/staff/...`，`voting:` = `/voting/...`，`public:` = `/`（public_portal）。先确保管理员/评委/选手/轮次/投票会话已就位（可用 `seed_demo_data` + staff 界面创建，或 `.env` 就绪后人工造数）。

### 4.1 评分缺评委
- **Setup**：新建轮次，录入选手 A 只让 4/5 位评委打过分。
- **Execute**：POST `staff:round_lock` → `/staff/rounds/<pk>/lock/`。
- **Expected**：锁定被拒绝，响应指出缺分的具体选手与评委。
- **[automated]** `staff_panel/tests.py` 缺分拒锁场景已覆盖。

### 4.2 损坏 Excel
- **Setup**：导出评分模板，在后部单元格填入非法/超范围/非有限值。
- **Execute**：POST `staff:excel_import_scores` → `/staff/export/import-scores/<round_id>/`。
- **Expected**：全表解析失败，**数据库无本次导入的任何部分写入**（0 partial mutation）。
- **[automated]** `singer_contest/services.py` 导入原子性 + `staff_panel/tests.py` 回归已覆盖。

### 4.3 角色降级
- **Setup**：`staff` 角色用户。
- **Execute**：POST `staff:user_role_update` → `/staff/users/<pk>/role/` 改成 `participant`。
- **Expected**：`is_staff` 同步清除，访问 `/staff/` 立即被拒（403）。
- **[automated]** `staff_panel/tests.py:3223-3350`（`test_get_user_role_endpoint_does_not_change_role` 等）。

### 4.4 伪造 ID
- **Setup**：两个活动各有 singer/program/投票选项。
- **Execute**：对活动 A 的写接口 POST 活动 B 的 singer/program/vote-option ID。
- **Expected**：请求被拒，**不产生跨活动数据**。
- **[automated]** `staff_panel/tests.py:3321`（导出活动作用域不越界）+ `voting/tests.py:218`（跨投票会话选项被拒）。

### 4.5 GET mutation
- **Setup**：列出所有锁/解锁/切换/导入/生成 URL（`staff:round_lock/round_unlock`、`activity_lock/unlock`、`activity_test_toggle`、`activity_clear_test_data`、`excel_import_scores`、`word_generate`、`activity_archive`、`stage_result_confirm/unlock`、`ruleset_freeze` 等）。
- **Execute**：对每个 mutation URL 发 **GET**。
- **Expected**：返回 **405**，或只渲染页面不改变状态。
- **[automated]** `staff_panel/tests.py:489, 2295, 3291`（GET 不产生 mutation）。

### 4.6 并发投票
- **Setup**：开启一个投票会话。
- **Execute**：同一浏览器重复提交；不同浏览器共享出口 IP 提交。
- **Expected**：同一浏览器只有一张 ballot；不同浏览器不因同 IP 被误伤。
- **[automated]** `voting/tests.py:183`（`test_same_browser_can_submit_only_one_ballot`）、`voting/tests.py:95`（伪造 cast 无 ballot）、`voting/tests.py:218`。

### 4.7 测试数据残留
- **Setup**：把活动切成测试模式（`staff:activity_test_toggle` → `/staff/activity/<pk>/test-toggle/`），创建报名/票/评分/奖项/文件。
- **Execute**：尝试退出测试模式——未清理时被拒；POST `staff:activity_clear_test_data` → `/staff/activity/<pk>/clear-test/` 清理后再退出。
- **Expected**：未清理不能退出；清理同时移除数据库行和媒体对象。
- **[automated]** `seed_demo_data --reset` 的递归清理 + `staff_panel/tests.py` 回归已覆盖。

### 4.8 当前媒体替换
- **Setup**：同一用途上传多个版本，删除当前版。
- **Execute**：通过受控文件查看视图访问当前版。
- **Expected**：只有一个是当前版本；删除后自动恢复最近的上一版。
- **[manual]** 需人工在 UI 上传/替换/删除确认当前版行为。

### 4.9 解锁改分重锁
- **Setup**：锁定轮次 → 管理员带原因解锁（`staff:round_unlock`）→ 改分（`staff:round_score_entry`）→ 重新锁定。
- **Execute**：按上述顺序操作，并查审计日志（`staff:audit_log_list`）。
- **Expected**：缺分仍不能锁定；评分审计含 old/new 明细。
- **[automated]** 评分审计明细 + `staff_panel/tests.py` 锁/解锁回归已覆盖。

### 4.10 AWARD 核定、重试、stale 与解锁重算
- **Setup**：从 Production 模板克隆并冻结包含 AWARD 节点的 RulesetVersion。若 AWARD 消费投票，绑定 purpose 一致的 VoteSession，并在核定前锁定这个被消费的原始输入；不依赖投票的 AWARD 不需要 VoteSession。
- **Execute**：resolve 后记录 `READY_TO_CONFIRM` 的 StageResult 与其 `StageAwardDecision`；确认正式 Award 列表/导出尚无该候选。POST `staff:stage_result_confirm` 后再重复提交一次核定。随后解锁 StageResult，修改其被消费输入，尝试核定旧候选，再 resolve 并核定新候选。
- **Expected**：正式链路严格为 `AWARD → StageAwardDecision → CONFIRM → Award`。`StageResult.status == CONFIRMED` 才是赛段来源 Award 的正式 authority；Staff 正式奖项列表和 `award_list` 导出只显示无赛段来源的历史 Award，或 `source_stage_result.status == CONFIRMED` 的 Award。`VoteSession 锁定本身不会创建 Award`；首次核定只物化一份来源完整的 Award，重复核定不重复；input fingerprint 或 result version 已变化的 stale 候选不能物化；解锁后旧来源赛段不再 `CONFIRMED`，所以旧 Award 不进入正式列表/导出，新候选必须重新核定。
- **Legacy provenance**：`Award.source_vote_session` 只解释可能存在的历史行，不是当前 Award authority。删除或迁移前先核查历史数据，不得用它恢复 vote-lock 自动颁奖。
- **[automated + manual]** 自动回归覆盖 vote lock 不颁奖、候选/核定、重复核定、stale 拒绝和解锁；人工演练核对 Staff 正式列表与导出只显示当前已核定来源。

### 4.11 过期评分 Excel
- **Setup**：导入的 workbook 的报名名单/评委名单/规则版本或指纹与当前轮次不一致（§15.5）。
- **Execute**：POST `staff:excel_import_scores`。
- **Expected**：**全表拒绝，0 partial mutation**，提示"名单过期/版本过期/指纹不匹配"。
- **[automated]** `singer_contest/services.py` snapshot 指纹 strict match + `staff_panel/tests.py` 回归已覆盖。

### 4.12 大视频直传
- **Setup**：正式活动（非测试模式），`ARTFLOW_VIDEO_UPLOAD_MAX_MB`（默认 100）。
- **Execute**：POST 超过上限的演唱/背景视频。
- **Expected**：被拒"正式活动不支持大视频直传"；正式报名页不出现视频字段；**测试活动仍可传**。
- **[manual]** 需人工确认表单隐藏与限资源端到端。

### 4.13 PostgreSQL 恢复
- **Setup**：见 §3.1。
- **Execute**：`verify_postgres_backup_restore.ps1` 在隔离库 `artflow_restore` 恢复。
- **Expected**：`pg_restore` 成功、`manage.py check` 通过、**源卷未被重置**。
- **[automated]** 由 §3.1 脚本驱动。

## 5. 填写 Production Rehearsal Report

彩排完成后，把结论追加到 [production-readiness.md](production-readiness.md) 的 **Production Rehearsal Report** 一节。一场演练一份报告；首次正式活动前必须至少有一份，并填入：

| 字段 | 采集途径 |
| --- | --- |
| 时间 | 演练开始时间 |
| 参与者 | Admin / Staff / Participant 各几人，Judge/Audience 是否模拟 |
| 场景 | 正常彩排 / 恶意彩排 / 灾难演练（web crash、PG 重启、media restore、database loss、clean restore） |
| 结论 | PASS / FAIL |
| 录分到 READY 时间 | 第一张纸质评分录入 → 最后一次自动 resolve（`recompute_activity_result`/`maybe_resolve_checkpoints`）耗时 |
| 实际恢复时间 | 模拟故障 → login/ruleset/score/decision/vote/material/document/archive 全通耗时 |
| 已知风险 | 本次发现、尚未修复的问题（记录到 `production-readiness.md` 的"已知风险"表） |
| Plan B | 压轴时的降级/绕行方案 |
