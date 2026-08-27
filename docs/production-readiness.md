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
| 人气奖重算 | A 锁定获奖，解锁后 B 获胜再锁定 | 只有当前一个“最佳人气奖”，来源投票会话一致 |
| PostgreSQL 恢复 | 创建备份并在隔离数据库恢复 | `pg_restore` 成功、Django check 通过，源卷未被重置 |

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
