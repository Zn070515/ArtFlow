# ArtFlow

ArtFlow 是面向学院文艺部的 Django 活动运行平台，覆盖公开门户、报名、材料收集、审核、评分、投票、导出和归档。工程化运行约定见 [开发基线](docs/development-baseline.md)。

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

## Docker PostgreSQL 启动

Docker Compose 使用 PostgreSQL，并将 Web 服务发布到 `127.0.0.1:8000`：

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

生产环境使用 `.env.production.example` 作为字段清单：`APP_ENV=production`、`DEBUG=False`、真实的主机名和 CSRF 来源，以及 PostgreSQL 连接配置都是必需的。示例值仅是占位符；不得提交 `.env`、密钥、密码、数据库、媒体文件或生成的导出文件。

## 常用维护命令

```powershell
uv run python manage.py check
uv run python manage.py makemigrations --check --dry-run
uv run python manage.py test
uv run python manage.py doctor
pwsh -NoProfile -File scripts/check_docs.ps1
```

`doctor` 只读检查配置、数据库、迁移和运行目录。匿名 `GET /healthz/` 只返回运行状态，不返回配置或业务数据。演示数据可用 `uv run python manage.py seed_demo_data --reset` 清理，但它只会删除该命令拥有且带测试标记的运行数据；仍应先在非重要数据库中验证。

## 开发与合并流程

在干净且最新的 `main` 上创建短期分支，完成验证后在分支提交；由负责合并的人以非快进方式合入 `main` 并推送。提交前至少运行 Django 检查、迁移检查、测试和文档检查。完整的数据库、Docker、CI、故障排查和安全说明见 [开发基线](docs/development-baseline.md)。
