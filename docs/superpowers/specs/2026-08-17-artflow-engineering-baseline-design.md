# ArtFlow 工程化开发基线设计

> 状态：待实施
>
> 参考标准：`C:\Users\16275\Desktop\OfficeForClaude`（offipy）仓库的 uv、CI、分支、质量门禁和安全实践。

## 目标

把 ArtFlow 从“能在旧电脑上开发过的 Django 仓库”提升为“任何新电脑都能按同一套命令启动、验证、造演示数据和运行 PostgreSQL 集成测试”的工程化服务基线。

基线完成后，后续业务功能必须在统一的质量门禁下开发；现有业务模型、权限、锁定、审计、受控媒体访问和测试数据隔离继续作为不可回退的约束。

## 成功标准

1. 新机器具备 Git、Python 3.12、uv 和 Docker，即可创建环境并启动本地 Django + PostgreSQL。
2. `uv.lock` 是依赖解析的冻结依据，`pyproject.toml` 是项目和工具配置的单一来源。
3. `scripts/bootstrap.ps1` 可以完成依赖同步、配置文件准备、迁移、配置检查和健康检查；只有显式传入 `-SeedDemoData` 才初始化演示数据，默认不写业务数据。
4. CI 同时覆盖 Linux SQLite、Linux PostgreSQL 和 Windows Python 3.12/3.13。
5. 任何提交都必须通过格式、静态检查、类型检查、迁移检查、Django 检查和测试。
6. 生产配置缺少密钥、主机、数据库或安全开关时，启动检查明确失败，而不是静默使用开发默认值。
7. baseline 不引入业务功能，不重写 `staff_panel`，不改变既有 URL 和数据模型语义。

## 参考 offipy 后采用的原则

- 使用 `uv` 管理虚拟环境和锁定依赖，所有 Python 命令优先使用 `uv run`。
- `pyproject.toml` 统一承载项目元数据、依赖组、pytest、Ruff、mypy 和 coverage 配置。
- CI 使用固定版本的 GitHub Actions，并增加 workflow lint，防止 YAML 错误造成无日志失败。
- 质量门禁拆成纯模块、数据库集成、安全和文档四类，避免把所有检查塞进一个不可诊断的 job。
- 所有开发从短期分支开始，验证后使用 `--no-ff` 合并回 `main`；本项目不使用 linked worktree。
- 行为变化必须同步代码、测试和文档；安全敏感行为必须有回归测试。
- 以稳定机器键、明确退出码和可读日志作为脚本与 CI 的接口，不依赖“看起来成功”的输出。

## 目标目录与职责

```text
ArtFlow/
├── .github/
│   ├── dependabot.yml
│   └── workflows/
│       ├── ci.yml              # lint/type/test/migration/Django checks
│       ├── integration.yml     # PostgreSQL + Docker smoke
│       ├── security.yml        # CodeQL、pip-audit、secret scan
│       └── workflow-lint.yml   # actionlint
├── config/
│   ├── settings.py             # 唯一 Django 配置入口，按环境加载并校验
│   └── health.py               # 健康检查实现
├── common/
│   ├── models.py                # 现有审计模型 + SeedRecord
│   └── migrations/              # baseline 新增 SeedRecord 迁移
├── scripts/
│   ├── bootstrap.ps1           # Windows 开发机初始化
│   ├── verify.ps1              # 本地完整门禁
│   ├── docker-entrypoint.sh    # Linux 容器迁移与启动
│   ├── wait-for-postgres.sh    # 容器数据库就绪等待
│   ├── export-requirements.ps1 # 从 uv lock 生成兼容 requirements.txt
│   └── check_docs.ps1          # 文档命令、链接和过时统计检查
├── docs/
│   ├── development-baseline.md # 开发、验证、数据库和故障排查手册
│   └── superpowers/specs/      # 设计规格
├── docker-compose.yml          # 本地 PostgreSQL、Web、媒体和数据库卷
├── Dockerfile                  # 可重复构建的 Django 镜像
├── CHANGELOG.md                 # baseline 和后续行为变更记录
├── pyproject.toml              # 依赖与质量工具单一来源
└── uv.lock                     # 冻结依赖解析结果
```

`requirements.txt` 不再作为手工依赖来源；保留它作为兼容产物，由 `uv export --frozen --no-dev --no-emit-project` 生成，并由 CI 检查生成结果没有漂移。`gunicorn` 只属于 production/container 依赖组，不进入 Windows 通用开发依赖。

## 配置与环境

`config.settings` 继续保持单一入口，但改为明确区分 `development`、`test` 和 `production` 三种环境语义：

- 开发默认使用 SQLite，方便第一次启动；Docker Compose 使用 PostgreSQL。
- 测试默认使用 SQLite 内存/临时数据库，PostgreSQL 集成 job 通过环境变量切换。
- 生产必须显式提供 `SECRET_KEY`、`ADMIN_LOGIN_KEY`、`ALLOWED_HOSTS`、数据库连接和 `CSRF_TRUSTED_ORIGINS`。
- `.env.example` 改为本地安全示例；新增 `.env.production.example`，不包含真实密钥。
- `.env` 通过明确的 dotenv 依赖加载；环境变量优先级高于文件内容。
- `.env.production.example` 必须通过 `.gitignore` 的显式例外纳入版本控制；真实 `.env` 文件仍保持忽略。
- 开发配置不再要求本机提前安装 PostgreSQL；生产配置不允许回退 SQLite。
- `STATIC_ROOT`、媒体目录、上传大小、代理 SSL、Secure/HttpOnly/SameSite Cookie 和 HSTS 均有明确配置。

增加 `python manage.py doctor`，输出脱敏后的运行环境摘要并执行配置、数据库、迁移、静态目录和媒体目录检查。命令不能输出密钥、密码或完整数据库 URL。

增加 `/healthz/`：检查 Django 配置和数据库连接，成功返回 200，失败返回非 200；不暴露业务数据、不要求登录。

增加 `APP_ENV` 语义校验：`development`、`test`、`production` 是唯一允许值。生产环境缺少必需配置或仍使用开发默认值时，`django.setup()`/`doctor` 必须失败；验证脚本通过进程环境变量 `APP_ENV=production` 选择生产语义，再执行 `check --deploy --fail-level WARNING`。`doctor` 只读取并报告已加载的环境，不通过命令参数切换 Django settings。

## 数据初始化

新增 `python manage.py seed_demo_data`，要求：

- 幂等执行，同一数据库重复运行不会重复创建核心演示对象。
- 支持 `is_test_data`/`is_test` 的运行数据全部显式标记为测试数据，覆盖公开门户、歌手比赛、毕晚、评分、投票、导出模板和审计场景。
- 没有测试标记字段的活动配置、公开文章和模板使用 `common.SeedRecord` 持久化固定 seed key、模型类型和对象 ID 做幂等更新；它们不由 `--reset` 删除，只能由显式人工删除流程处理。
- 默认不删除任何数据。
- `--reset` 只能删除由该命令创建且带有 `is_test_data=True` 或 `is_test=True` 的运行数据；没有测试标记的 seed 配置只更新不删除，正式数据必须保持不变。
- 管理员密码只能从 `DEV_ADMIN_PASSWORD` 或隐藏式交互输入读取，不接受命令行明文密码，不提供仓库内默认密码。
- 现有 `seed_dev_admin` 保留为最小管理员初始化命令，文档不再引用不存在的 `seed_data`。

`SeedRecord` 只允许由管理命令按内置 seed key 使用，不接受用户通过命令行传入任意模型或对象 ID；它不向公开页面暴露，也不参与业务权限判断。演示数据产生的审计日志默认保留，避免 reset 破坏操作追踪。

`SeedRecord` 的最小字段契约为：唯一 `key`、`content_type` 外键、正整数 `object_id` 和创建时间；不得保存密码、文件内容或可执行代码。

命令必须有 Django `TestCase`，覆盖首次执行、重复执行、重置测试数据和保留正式数据四种行为。

## 质量门禁

本地标准命令统一为：

```powershell
uv sync --locked --extra dev
uv run ruff check .
uv run ruff format --check .
uv run mypy
uv run python manage.py check
uv run python manage.py makemigrations --check --dry-run
uv run pytest -q
```

`scripts/verify.ps1` 另外以 `APP_ENV=production` 语义执行 `manage.py check --deploy --fail-level WARNING`，使用临时的非真实密钥和主机配置，不把生产默认值写入仓库。pytest 通过 `pytest-django` 收集现有 `tests.py`，显式设置 `DJANGO_SETTINGS_MODULE=config.settings` 和 `python_files = ["tests.py", "test_*.py", "*_tests.py"]`，启用严格 marker 和 warnings-as-errors；初始覆盖率门槛以基线实测值为准，并设为只能上调的门槛。Ruff 先覆盖项目源代码、配置、脚本和测试，排除生成迁移文件中的机械格式噪音；排除项必须写入配置并说明原因。

mypy 采用渐进式强类型门禁：`pyproject.toml` 的 `files` 只包含基础设施模块（`config`、`common`、`accounts/management`、`public_portal/management`）并使用 strict；既有未类型化业务视图先启用 `check_untyped_defs`，不得借机大规模改写业务。每个被修改的模块都必须逐步移入 strict 范围，配置不能通过全局 `ignore_errors` 逃避检查。

## Docker 与集成验证

`docker-compose.yml` 提供：

- `db`：PostgreSQL，带健康检查和命名数据卷。
- `web`：ArtFlow 镜像，等待数据库就绪后执行迁移和 `collectstatic --noinput`，再以非 root 用户启动 gunicorn；Dockerfile 安装 `postgresql-client`，供 `pg_isready` 等待脚本使用。
- `media`、`static`：独立命名卷；宿主机不把真实上传文件写入 Git 工作区。
- 健康检查调用 `/healthz/`，容器异常时返回非零状态。
- PostgreSQL 默认只加入 Compose 内部网络；如需宿主机连接，端口只能绑定到 `127.0.0.1`，不得默认暴露到所有网卡。

容器启动脚本必须使用 `exec` 传递最终进程，迁移或静态文件收集失败时立即退出，不能在错误状态下启动 Web 服务。生产镜像不包含测试数据、开发密钥、源码控制目录或 `.env` 文件；`gunicorn` 只进入 production/container 依赖组，Windows 开发环境不安装它，开发机仍可使用 Django `runserver`。

## CI 分层

### CI

Linux job 使用 uv lock，在 SQLite 上运行 Ruff、mypy、Django checks、迁移检查和 pytest，并上传 coverage。Windows job 运行 Python 3.12 和 3.13，验证 Windows 路径、上传文件和模板渲染行为。所有 job 设有超时、最小权限和 concurrency 取消旧运行。Action 版本固定到 commit SHA，并由 workflow lint 校验。

### Integration

使用 PostgreSQL service 或 Docker Compose 执行迁移、`doctor`、`healthz` 和完整测试，并验证 `seed_demo_data` 幂等性。集成 job 不使用生产凭据；数据库 service 不向公网暴露。

### Security

- `pip-audit` 审计 `uv export` 的生产依赖。
- CodeQL 扫描 Python。
- gitleaks 扫描完整 Git 历史。
- Django `check --deploy` 作为配置安全门禁；开发环境允许的 warning 必须通过明确配置隔离。

### Workflow lint

使用 actionlint 校验全部 workflow，Actions 使用固定 commit SHA 并保留版本注释。每个 workflow 的 job 都有明确的失败输出和超时。

## 安全边界

- 继续禁止直接静态暴露 `media/`，所有私有文件经过 `controlled_media`。
- 不把 PostgreSQL 密码、管理员密码、Django 密钥、真实上传文件、数据库文件和导出产物提交到 Git。
- 所有写操作继续执行权限、活动锁定/轮次锁定/投票锁定和审计检查。
- `doctor`、`healthz`、CI 日志和容器日志不得泄露敏感配置。
- 生产环境必须显式配置反向代理信任、HTTPS Cookie、CSRF 来源和允许主机。

## 非目标

- 不在 baseline 阶段新增签到、任务看板、数据驾驶舱、通知中心或人才库。
- 不把 `staff_panel/views.py` 一次性拆分重构。
- 不引入 Celery、Redis、对象存储或前端构建系统。
- 不提供自动生产部署、域名、证书或云厂商绑定；只提供可验证的容器和运行契约。
- 不把 offipy 的 PyPI 发布、Office 真机 runner 或 COM 进程纪律复制到 ArtFlow。

## 验收顺序

1. 裸机使用 Python 3.12 + uv 创建环境并通过 SQLite 门禁。
2. Docker Compose 启动 PostgreSQL，迁移和 `/healthz/` 通过。
3. `seed_demo_data` 连续执行两次，数据数量稳定；`--reset` 不删除正式数据。
4. Linux CI 通过全部纯模块检查；Windows CI 通过矩阵检查。
5. 安全扫描和 workflow lint 通过。
6. 更新 README、CLAUDE、AGENTS、开发手册、变更记录和 requirements 生成说明，删除所有 `seed_data`、不存在的 Docker 命令和过时的模型统计。
7. 所有改动在 `build/engineering-baseline` 完成验证后，以原子提交合并到 `main` 并推送远程。
