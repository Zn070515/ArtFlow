# PostgreSQL 备份与恢复演练

Archive Package 是活动资料交付物，不是数据库灾难恢复备份。生产 PostgreSQL 必须定期执行“创建逻辑备份、校验、在隔离目标恢复、运行应用检查”这一闭环。

## Compose 演练

先启动并确认源服务健康：

```powershell
docker compose up --build --wait
```

然后在仓库根目录运行：

```powershell
pwsh -NoProfile -File scripts\verify_postgres_backup_restore.ps1 `
  -ComposeProjectName artflow `
  -BackupPath backups\artflow-rehearsal.dump
```

脚本只从运行中的 `db` 容器创建 custom-format `pg_dump`，用 `pg_restore` 恢复到同一内部网络上的临时 PostgreSQL 容器。恢复目标使用独立数据库和临时容器；脚本最后只删除临时恢复容器，不执行 `docker compose down --volumes`、源库 `dropdb` 或源卷重置。

成功标准是：备份文件存在且非空，恢复目标可连接，Django `manage.py check` 通过，并能读取
`django_migrations`。应用级 manifest 记录关键业务表和文件表的完整计数、迁移 provenance、
database/media SHA 以及媒体内容 digest；Ticket digest 属于凭据派生数据，原始 Ticket
secret/session token 不得进入 manifest、日志、导出或演练产物。恢复脚本会在解包或
`pg_restore` 前先验证两个归档 SHA，并拒绝运行 web 镜像的 OCI revision 与 manifest 不一致。
失败时保留源服务和卷，记录失败原因后重新演练。

当前生产数据库基线是 PostgreSQL 16；Web 镜像内的 `pg_dump`/`pg_restore` 也固定为
`postgresql-client-16`，避免用更高版本生成数据库 16 无法读取的 custom-format dump。
如果未来升级 PostgreSQL 主版本，必须同步更新生产数据库镜像、Web 镜像客户端和隔离
恢复目标，并重新完成整套备份恢复验收。

生产环境还应通过 `scripts/offsite_backup.ps1` 或 `scripts/offsite_backup.sh` 把完整备份集合
复制到独立对象存储/故障域，并在另一台主机或隔离 PostgreSQL 集群执行同样的恢复验证；
不要把仓库本地 `backups/` 当作长期备份介质。

显式生产 Compose 会把独立的 `backup_data` 卷挂载到 `/app/backups`，因此直接在 web
容器中运行应用级备份不会落入容器可写层。该卷只是主机上的持久化暂存，不能替代异地或
对象存储副本。生产 `.env.production` 必须设置构建镜像对应的完整 `ARTFLOW_RELEASE_SHA`；
备份 manifest 会记录它，容器内没有 `.git` 时也不会丢失 release provenance。
