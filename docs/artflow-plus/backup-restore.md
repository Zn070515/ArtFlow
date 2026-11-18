# ArtFlow-Plus 备份与隔离恢复

这份文档是 Plus 生产卷的运维闭环。它只覆盖 Plus 自己的 PostgreSQL、归档包和私有材料；v1 数据不迁移进 v2，其历史备份流程见 [v1 备份恢复文档](../postgres-backup-restore.md)。

## 覆盖范围

Plus Compose 部署中有三块需要一起保存的持久数据：

| 数据 | Compose volume | 备份文件 | 用途 |
| --- | --- | --- | --- |
| 数据库 | `plus_postgres_data` | `database.dump` | 活动、release、事实、投影、outbox、账户和审计 |
| 归档包 | `plus_archive_data` | `archives.tar.gz` | 已封存的结果包 |
| 私有材料 | `plus_media_data` | `media.tar.gz` | Plus 上传的材料字节 |

v1 的 `media_data` 桥接卷已随 ADR-0036 删除，不属于 Plus 的权威材料卷，也不会被 `backup_plus.sh` 合并进 Plus 备份。

## 生成备份

先确认 `.env.production` 中 api/worker/web（以及可选的 export）镜像是同一 release 的
digest，并且服务已经运行：

```powershell
docker compose -f deploy/compose.production.yml --env-file .env.production ps
```

默认情况下，脚本依赖 `pg_dump` 的 MVCC 一致快照，不再对用户表加
`SHARE ROW EXCLUSIVE` 写屏障，因此备份期间业务写入不会被冻结。媒体/归档卷仍
在 dump 之后打包；文件按不可变 key 写入，晚到或正在替换的文件不会破坏已有包。
如果部署要求数据库与文件卷在字节层面严格对齐、且能接受短时写冻结，设置
`ARTFLOW_BACKUP_WRITE_LOCK=1` 恢复旧的写屏障。

执行：

```powershell
bash scripts/backup_plus.sh backups/artflow-plus
```

宿主机需要 Python 3.12+、Docker Compose 和 `sha256sum`。也可以通过
`ARTFLOW_ENV_FILE`、`ARTFLOW_COMPOSE_PROJECT` 和 `ARTFLOW_COMPOSE_FILE` 指定部署环境。
命令需要正在运行的 `plus-db`、`plus-api`、`plus-worker` 和 `plus-web`（`plus-export` 可选，不参与备份）；它从容器中读取 PostgreSQL 和两个 Plus 文件卷，输出一个新的目录：

```text
backups/artflow-plus/<UTC时间>-<release-sha>/
├── manifest.json
├── database.dump
├── archives.tar.gz
└── media.tar.gz
```

`manifest.json` 绑定了 release SHA、数据库/API/Worker/Web 镜像引用及不可变 image ID、源卷名、文件大小、普通文件数量、数据库各表行数和三个 SHA-256。备份期间脚本在数据库用户表上持有 `SHARE ROW EXCLUSIVE` 锁，允许 `pg_dump` 读取但会阻塞写入和正在获取行锁的业务事务，直到数据库 dump、两个文件卷、表行数证据和 manifest 全部完成；这避免数据库状态与文件卷跨时间点漂移。锁会话由脚本自己的受管管道持有，不使用 detached 容器进程或无限期 `pg_sleep`；成功和失败路径都会关闭并等待它释放锁。数据库 dump 生成期间只会在源 `plus-db` 容器里留下一个临时文件，完成后由脚本删除；源数据库、归档卷和材料卷不会被重建或清空。

备份目录应按部署方的保存期限复制到独立存储。复制完成后保留 `manifest.json` 与三个文件的原始关系，不要只上传其中一个文件。

## 隔离恢复验证

选择一个完整备份目录执行：

```powershell
bash scripts/restore_plus_verify.sh backups/artflow-plus/<UTC时间>-<release-sha>
```

脚本按以下顺序检查：

1. 校验 schema、文件名、release/image 身份、大小和三个 SHA-256；
2. 拒绝绝对路径、`..`、symlink、hardlink、设备文件等危险 tar member，再解包到临时目录；
3. 创建独立的 internal Docker network，使用 manifest 中锁定的 image ID 启动一次性的 PostgreSQL 容器，把 `database.dump` 恢复进去，检查 `kysely_migration`，并逐表比对数据库行数；
4. 在同一隔离 network 上用 manifest 中锁定的 Worker 镜像启动 outbox worker，等待其启动日志；
5. 用 manifest 中锁定的 API 镜像启动一次性的 API 容器，指向临时数据库和只读解包目录，等待 `/readyz`；再用锁定的 Web 镜像通过 `plus-api` network alias 检查 `/healthz`；
6. 对照 manifest 验证归档和材料的普通文件数量；
7. 删除本次创建的临时 Web/API/Worker/数据库容器、internal network 与临时目录。

恢复验证不会执行 `docker compose down --volumes`、`docker volume rm`、源库 reset 或源卷删除。源 Plus 服务和三块源卷在整个过程中保持原状。任何校验或 readiness 失败都应保留日志并修复镜像、备份或部署配置后重新验证，不要用删除源数据来“排障”。

成功输出为：

```text
Plus backup restore verification passed; source services and volumes were not reset.
```

## 与 v1 流程的边界

- `scripts/backup_plus.sh` / `scripts/restore_plus_verify.sh` 只处理 Plus 三块持久数据。
- v1 的 `scripts/backup.sh` / `scripts/restore-verify.sh` 已随 v1 源码移除；v1 不再部署，
  其历史流程仅见 [v1 备份恢复文档](../postgres-backup-restore.md)。
- 这一步是部署数据完整性检查，不创建活动，也不改变正式事实。
