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

成功标准是：备份文件存在且非空，恢复目标可连接，Django `manage.py check` 通过，并能读取 `django_migrations`。失败时保留源服务和卷，记录失败原因后重新演练。

生产环境还应把备份文件复制到独立存储，并在另一台主机或隔离 PostgreSQL 集群执行同样的恢复验证；不要把仓库本地 `backups/` 当作长期备份介质。
