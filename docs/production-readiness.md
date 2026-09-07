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

## 发布门禁

本地静态资源必须从锁定的 npm 依赖构建，运行时 HTML 不得依赖 Tailwind CDN：

```powershell
npm ci
npm run check:css
uv run python manage.py collectstatic --noinput --clear
```

应用门禁：

```powershell
uv run ruff format --check .
uv run ruff check .
uv run mypy
uv run python manage.py check
uv run python manage.py makemigrations --check --dry-run
uv run pytest -q --cov
pwsh -NoProfile -File scripts\check_docs.ps1
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
