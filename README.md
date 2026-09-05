# ArtFlow

ArtFlow 是面向学院文艺部的 Django 活动运行平台，覆盖公开门户、报名、材料收集、审核、评分、投票、导出和归档。工程化运行约定见 [开发基线](docs/development-baseline.md)。

核心领域分为两条主线：

- **歌手比赛（`singer_contest` + `ruleset`）**：把赛制表达为受 schema 约束的版本化 JSON 规则图（`ContestRuleset` / `RulesetVersion`），经编译器/验证器检查后可 `FROZEN`，再由 resolver 产生 `HOLD / REVIEW / READY_TO_CONFIRM / CONFIRMED` 结果。2025 院十佳与校十佳屏峰有 Golden 模拟，后台提供 Rapid Score Entry 与 Backstage Result Board 抄卡模式。产品目标与领域设计见 [GOAL.md](GOAL.md)。
- **活动运行（`public_portal` / `files` / `farewell_show` / `voting` / `exports` / `archive` …）**：报名、材料槽、审核、投票、导出、归档与审计，遵守 Activity 作为 mutation 边界的锁定与权限规则。

## Windows 本地启动

以下是唯一的本地 Windows 启动路径；它使用 SQLite，不需要本机 PostgreSQL。

```powershell
Copy-Item .env.example .env
# 在 .env 中替换所有 change-me 占位值，尤其是 DEV_ADMIN_PASSWORD。
uv sync --locked --extra dev
uv run python manage.py migrate --noinput
uv run python manage.py seed_dev_admin
uv run python manage.py seed_demo_data
uv run python manage.py runserver
```

`seed_dev_admin` 从 `DEV_ADMIN_PASSWORD` 读取密码；如果未设置，它会以交互方式要求输入。`seed_demo_data` 是可重复执行的确定性演示数据命令，不是生产初始化步骤。启动后可访问 `http://127.0.0.1:8000/`，并用你在 `.env` 中设置的账户登录。

没有 `uv` 时，先安装它；不要绕过锁文件改用未锁定的依赖安装。`scripts\bootstrap.ps1` 可自动执行依赖同步、迁移和运行诊断，并可通过 `-SeedDemoData` 额外写入演示数据；如需本地管理员，仍运行 `seed_dev_admin`。

本仓库的本地工具基线为 Python 3.12（见 `.python-version`）和 uv 0.11.29；Docker 镜像使用相同的固定 uv 版本。Python 3.13 仍受项目元数据支持并在 CI 中验证。

## Docker PostgreSQL 启动（本地/联调）

`docker-compose.yml` 是**本地/联调 Compose**，不是生产部署文件：它固定 `APP_ENV: development`、`ALLOWED_HOSTS: localhost,127.0.0.1`、一个硬编码的本地数据库口令，并把端口绑定到 `127.0.0.1:8000`。不要把它当作生产 manifest；在它之上套 `.env.production` 也不能让它变成生产配置。生产使用 [`deploy/compose.production.yml`](deploy/compose.production.yml)，事件本机使用 [`deploy/compose.event.yml`](deploy/compose.event.yml)；部署细节见 [生产部署说明](docs/deployment-production.md)。

本地启动：

```powershell
docker compose up --build --wait
Invoke-WebRequest http://127.0.0.1:8000/healthz/
```

容器镜像安装 `production` extra；本地开发安装 `dev` extra。停止服务使用 `docker compose down`。`docker compose down --volumes` 会删除容器数据库、静态文件和上传文件卷，仅可用于明确要丢弃本地容器数据的场景。

对 Compose PostgreSQL 运行完整验收（迁移、诊断、健康检查、演示数据幂等性、显式 reset 安全检查和 Django 全量测试）：

```powershell
pwsh -NoProfile -File scripts\verify_postgres_acceptance.ps1 -StartCompose -VerifyResetSafety
```

该脚本不会停止服务或删除卷；容器只安装 `production` extra，因此测试在容器内使用 Django 的 `manage.py test`，而不是主机 `pytest`。

## 环境变量

从 `.env.example` 创建本地 `.env` 并替换其中的占位值。模板包含 `APP_ENV`、`SECRET_KEY`、`ADMIN_LOGIN_KEY`、`DEV_ADMIN_USERNAME`、`DEV_ADMIN_PASSWORD`、`DEBUG` 和 `DATABASE_ENGINE`；`seed_dev_admin` 使用 `DEV_ADMIN_USERNAME` 和 `DEV_ADMIN_PASSWORD`。只有选择 PostgreSQL 时才需要 `POSTGRES_DB`、`POSTGRES_USER`、`POSTGRES_PASSWORD`、`POSTGRES_HOST` 和 `POSTGRES_PORT`。

生产环境使用 `.env.production.example` 作为字段清单：`APP_ENV=production`、`DEBUG=False`、真实的主机名和 CSRF 来源、PostgreSQL 连接配置都是必需的；`TRUST_X_FORWARDED_FOR` 只在可信反向代理覆盖客户端 `X-Forwarded-For` 时才设为 `true`。示例值仅是占位符；不得提交 `.env`、密钥、密码、数据库、媒体文件或生成的导出文件。生产拓扑见 [生产部署说明](docs/deployment-production.md)。

## 事件本机运行

`deploy/compose.event.yml` 是单机现场运行契约：`web` 只绑定 `127.0.0.1:8000`，PostgreSQL 不发布端口，数据库和媒体使用持久化卷。工作人员在本机用 `http://127.0.0.1:8000/` 操作；如需对外入口，可由现场人员另行配置受控公网 tunnel 或 IPv6 入口，并把入口主机名加入 `EVENT_ALLOWED_HOSTS`、HTTPS 来源加入 `EVENT_CSRF_TRUSTED_ORIGINS`。公网/云入口只是访问路径，不能成为正式 authority；比赛期间始终只有这台主机上的一个主数据库/服务器可写。PowerPoint 播放与控制仍独立于 ArtFlow。

```powershell
docker compose --env-file .env.event -f deploy/compose.event.yml up --build --wait
```

## 常用维护命令

```powershell
uv run python manage.py check
uv run python manage.py makemigrations --check --dry-run
uv run python manage.py test
uv run python manage.py doctor
pwsh -NoProfile -File scripts/check_docs.ps1
pwsh -NoProfile -File scripts/verify_postgres_backup_restore.ps1 -ComposeProjectName artflow -BackupPath backups/artflow-rehearsal.dump
```

`doctor` 只读检查配置、数据库、迁移和运行目录。匿名 `GET /healthz/` 只返回运行状态，不返回配置或业务数据。演示数据可用 `uv run python manage.py seed_demo_data --reset` 清理，但它只会删除该命令拥有且带测试标记的运行数据；仍应先在非重要数据库中验证。

数据库恢复不能用活动资料归档替代。Docker Compose 环境可用上面的备份恢复命令，把源库恢复到隔离临时容器并运行 Django 检查；该演练不会重置源数据库或卷。完整事件日矩阵见 [生产准备演练](docs/production-readiness.md)，备份约束见 [PostgreSQL 备份与恢复演练](docs/postgres-backup-restore.md)。

## 开发与合并流程

在干净且最新的 `main` 上创建短期分支，完成验证后在分支提交；由负责合并的人以非快进方式合入 `main` 并推送。提交前至少运行 Django 检查、迁移检查、测试和文档检查。完整的数据库、Docker、CI、故障排查和安全说明见 [开发基线](docs/development-baseline.md)。
