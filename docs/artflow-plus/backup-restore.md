# ArtFlow-Plus 备份与隔离恢复

这份文档是 Plus 生产卷的运维闭环。它只覆盖 Plus 自己的 PostgreSQL、归档包和私有材料；v1 的数据库、`media_data`、静态文件和部署配置仍按 [v1 备份恢复文档](../postgres-backup-restore.md) 管理。

## 覆盖范围

Plus Compose profile 中有三块需要一起保存的持久数据：

| 数据 | Compose volume | 备份文件 | 用途 |
| --- | --- | --- | --- |
| 数据库 | `plus_postgres_data` | `database.dump` | 活动、release、事实、投影、outbox、账户和审计 |
| 归档包 | `plus_archive_data` | `archives.tar.gz` | 已封存的结果包 |
| 私有材料 | `plus_media_data` | `media.tar.gz` | Plus 上传的材料字节 |

`media_data` 是 adoption 期间给 Plus 读取的 v1 只读桥接卷，不属于 Plus 的权威材料卷，也不会被 `backup_plus.sh` 悄悄合并进 Plus 备份。需要保留它时，继续按 v1 备份流程保存。

## 生成备份

先确认 `.env.production` 中的三个 Plus 镜像是同一 release 的 digest，并且 Plus profile 已经运行：

```powershell
docker compose -f deploy/compose.production.yml --env-file .env.production --profile plus ps
```

执行：

```powershell
bash scripts/backup_plus.sh backups/artflow-plus
```

宿主机需要 Python 3.12+、Docker Compose 和 `sha256sum`。也可以通过
`ARTFLOW_ENV_FILE`、`ARTFLOW_COMPOSE_PROJECT` 和 `ARTFLOW_COMPOSE_FILE` 指定部署环境。
命令需要正在运行的 `plus-db` 和 `plus-api`；它从容器中读取 PostgreSQL 和两个 Plus 文件卷，输出一个新的目录：

```text
backups/artflow-plus/<UTC时间>-<release-sha>/
├── manifest.json
├── database.dump
├── archives.tar.gz
└── media.tar.gz
```

`manifest.json` 绑定了 release SHA、数据库/API 镜像、源卷名、文件大小、普通文件数量和三个 SHA-256。备份期间脚本在数据库用户表上持有 `SHARE ROW EXCLUSIVE` 锁，允许 `pg_dump` 读取但会阻塞写入和正在获取行锁的业务事务，直到数据库 dump、两个文件卷和 manifest 全部完成；这避免数据库状态与文件卷跨时间点漂移。锁会话由脚本自己的受管管道持有，不使用 detached 容器进程或无限期 `pg_sleep`；成功和失败路径都会关闭并等待它释放锁。数据库 dump 生成期间只会在源 `plus-db` 容器里留下一个临时文件，完成后由脚本删除；源数据库、归档卷和材料卷不会被重建或清空。

备份目录应按部署方的保存期限复制到独立存储。复制完成后保留 `manifest.json` 与三个文件的原始关系，不要只上传其中一个文件。

## 隔离恢复验证

选择一个完整备份目录执行：

```powershell
bash scripts/restore_plus_verify.sh backups/artflow-plus/<UTC时间>-<release-sha>
```

脚本按以下顺序检查：

1. 校验 schema、文件名、release/image 身份、大小和三个 SHA-256；
2. 拒绝绝对路径、`..`、symlink、hardlink、设备文件等危险 tar member，再解包到临时目录；
3. 在 Plus 内部 Docker network 上启动一次性的 PostgreSQL 容器，把 `database.dump` 恢复进去，并检查 `kysely_migration`；
4. 用 manifest 中的同一个 API 镜像启动一次性的 API 容器，指向临时数据库和只读解包目录，等待 `/readyz`；
5. 对照 manifest 验证归档和材料的普通文件数量；
6. 删除本次创建的临时数据库/API 容器与临时目录。

恢复验证不会执行 `docker compose down --volumes`、`docker volume rm`、源库 reset 或源卷删除。源 Plus 服务和三块源卷在整个过程中保持原状。任何校验或 readiness 失败都应保留日志并修复镜像、备份或部署配置后重新验证，不要用删除源数据来“排障”。

成功输出为：

```text
Plus backup restore verification passed; source services and volumes were not reset.
```

## 与 v1 流程的边界

- `scripts/backup_plus.sh` / `scripts/restore_plus_verify.sh` 只处理 Plus 三块持久数据。
- `scripts/backup.sh` / `scripts/restore-verify.sh` 继续处理 v1 Django 数据库、`media_data` 和 v1 manifest。
- Plus 的 `legacy-file:` 材料引用仍指向 v1 只读桥接；在它被迁移成 Plus 私有材料前，不能把它当作 `plus_media_data` 的备份结果。
- 这一步是部署数据完整性检查，不创建活动、不改变正式事实，也不改变 cutover 的回滚边界。
