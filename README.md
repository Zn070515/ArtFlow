<div align="center">

<h1>ArtFlow</h1>

<p><strong>学院文艺活动全生命周期运行平台</strong> · <strong>Activity operations platform for university arts departments</strong></p>

<p>
  <a href="https://github.com/Zn070515/ArtFlow/actions/workflows/ci.yml"><img src="https://img.shields.io/github/actions/workflow/status/Zn070515/ArtFlow/ci.yml?branch=main&label=CI" alt="CI status"></a>
  <a href="https://github.com/Zn070515/ArtFlow/actions/workflows/integration.yml"><img src="https://img.shields.io/github/actions/workflow/status/Zn070515/ArtFlow/integration.yml?branch=main&label=PostgreSQL%20integration" alt="PostgreSQL integration"></a>
  <a href="https://github.com/Zn070515/ArtFlow/actions/workflows/security.yml"><img src="https://img.shields.io/github/actions/workflow/status/Zn070515/ArtFlow/security.yml?branch=main&label=Security" alt="Security"></a>
</p>

<p>
  <img src="https://img.shields.io/badge/Python-3.12-3776AB?logo=python&logoColor=white" alt="Python 3.12">
  <img src="https://img.shields.io/badge/Django-6.0-092E20?logo=django&logoColor=white" alt="Django 6.0">
  <img src="https://img.shields.io/badge/uv-0.11.29-DE5FE9?logo=astral&logoColor=white" alt="uv 0.11.29">
  <img src="https://img.shields.io/badge/SQLite%20%7C%20PostgreSQL-336791?logo=postgresql&logoColor=white" alt="SQLite or PostgreSQL">
  <img src="https://img.shields.io/badge/Docker-Compose-2496ED?logo=docker&logoColor=white" alt="Docker Compose">
</p>

<p>
  <img src="docs/assets/brand/artflow-logo.png" alt="ArtFlow 标志 · ArtFlow logo" height="108" width="122">
  &nbsp;&nbsp;
  <img src="docs/assets/brand/xinxu-studio-logo.png" alt="昕序软件科技标志 · XINXU SOFTWARE logo" height="108" width="131">
</p>

<p>
  <a href="#模块与流程--modules--flows">模块与流程 · Modules &amp; flows</a> ·
  <a href="#角色手册--role-handbooks">角色手册 · Role handbooks</a> ·
  <a href="#快速开始--setup">快速开始 · Get started</a> ·
  <a href="#先读这些--read-these-first">文档索引 · Docs</a> ·
  <a href="#部署--deployment">部署 · Deployment</a> ·
  <a href="#工程原则--engineering-rules">工程原则 · Engineering rules</a>
</p>

</div>

ArtFlow 是面向学院文艺部的 **EventOps 活动运行平台**：把原本散落在微信群、Excel、Word、问卷星、网盘附件、纸质评分表与主持手卡里的活动工作，收束成一套报名、材料收集、审核、评分、投票、公示、导出与归档都可追溯的在线流程。

第一个生产验证场景是学院十佳歌手大赛与毕业晚会，但 ArtFlow 的目标不是「十佳算分器」，而是一套可长期运行、可复用到多类学院文艺活动的运行平台。产品目标与领域边界见 [GOAL.md](GOAL.md)。

> **项目状态：** 开发基线、验证入口与人工验收范围以 [开发基线](docs/development-baseline.md) 为准。本文档不复述具体的测试数量、commit 或 CI 运行结果，避免它们与代码漂移。

## 先读这些 · Read these first

| 文档 | 它约束什么 |
|---|---|
| [`GOAL.md`](GOAL.md) | 产品目标、领域边界与工程原则基线。 |
| [`CLAUDE.md`](CLAUDE.md) | 编码代理的运行约定与仓库红线。 |
| [`AGENTS.md`](AGENTS.md) | 模块划分、目录职责与贡献准则。 |
| [`docs/development-baseline.md`](docs/development-baseline.md) | 已验证的开发与运行基线。 |
| [`CHANGELOG.md`](CHANGELOG.md) | 按批次记录的权威收敛与行为变更。 |
| [`docs/`](docs/) | 部署、演练、备份恢复与现场运行手册。 |

## 产品方向 · Product direction

| 层次 | 职责 |
|---|---|
| 公开门户 | 公告、往届风采、结果公示与活动入口。 |
| 报名与材料 | 报名表、材料槽、提交文件与材料核查。 |
| 赛制与结果 | 版本化规则图、编译器 / 验证器、resolver 与结果板。 |
| 现场运行 | 快速录分、观众投票、检票入场与手卡抄录。 |
| 导出与归档 | Excel / Word 导出、活动归档与审计留痕。 |

## 核心领域 · Core domains

核心领域分为两条主线：

| 主线 | 覆盖范围 |
|---|---|
| **歌手比赛（`singer_contest` + `ruleset`）** | 把赛制表达为受 schema 约束的版本化 JSON 规则图（`ContestRuleset` / `RulesetVersion`），经编译器 / 验证器检查后可 `FROZEN`，再由 resolver 产生 `HOLD / REVIEW / READY_TO_CONFIRM / CONFIRMED` 结果。2025 院十佳（历史模板 `golden_schidui`）与校十佳屏峰有 Golden 模拟，后台提供 Rapid Score Entry 与 Backstage Result Board 抄卡模式。当年决赛的操作流程见[院十佳决赛生产流程](docs/singer-final-production-flow.md)。 |
| **活动运行（`public_portal` / `files` / `farewell_show` / `voting` / `exports` / `archive` …）** | 报名、材料槽、审核、投票、导出、归档与审计，遵守 Activity 作为 mutation 边界的锁定与权限规则。 |

## 模块与流程 · Modules & flows

下面的图由 [archify](https://github.com/tt-a1i/archify) v3.0.1 依据仓库源码生成，**每个节点都锚定到具体的文件与函数**，并在仓库里留下可核对的图源。图源与再生成方式见[流程图目录](docs/diagrams/README.md)。

### 前后端模块 · Frontend & backend modules

**前端**是一组 TypeScript 入口，编译到 `static/dist/`，每个入口只服务一个现场页面：观众端的直播页、票据验证与投票页；选手与评委端的问卷材料、评委终端与在线协作；工作人员端的手机检票、快速录分与活动字段协作。它们共用一套构建，`npm run check:client` 守住编译产物与源码一致。

**后端**按领域切成 Django app，浏览器不直连数据层，所有写入都从视图进入领域服务：

| 域 | app | 职责 |
|---|---|---|
| 账号与活动 | `accounts`、`core`、`common` | 自定义用户与角色、Activity 与阶段/锁定状态、审计与 authority 授权、业务规则守卫、测试数据与保留期维护。 |
| 赛制与问卷 | `ruleset`、`questionnaire` | 版本化规则图、编译器与 resolver；问卷 DSL、编译计划、报名草稿与提交、后台设计器。 |
| 比赛与材料 | `singer_contest`、`files` | 报名、轮次、评委席位与评分、奖项；提交文件、材料槽与材料核查。 |
| 观众侧 | `tickets`、`voting`、`entry_access` | 票券与检票会话；投票会话、选项与选票；入场通行证与临时入场会话。 |
| 运营与产物 | `staff_panel`、`exports`、`archive`、`incidents`、`realtime`、`public_portal`、`farewell_show` | 运营后台、导出、归档、异常登记、在线协作广播、公开门户与毕晚节目单。 |

横切边界只有三条：私有文件走受控媒体视图按所有权判读权；写操作先取 Activity 行锁、再按域显式授权；敏感操作、导出、解锁与事故登记全部留痕。

<div align="center">

<img src="docs/diagrams/12-module-map.svg" alt="前后端模块全景" width="100%">

</div>

### 端到端流程 · End-to-end flows

<div align="center">

<img src="docs/diagrams/01-activity-lifecycle.svg" alt="活动生命周期" width="100%">

</div>

一场活动从**测试活动**起步：赛制先绑定真实事实并冻结，之后每一次阶段推进都由服务端状态机与冻结规则共同约束；HOLD 优先于公示。阶段是单向闸门，规则先冻结再运行。

<div align="center">

<img src="docs/diagrams/02-ruleset-questionnaire-registration.svg" alt="规则集、问卷与报名" width="100%">

</div>

规则集是问卷的唯一输入：问卷计划由规则集编译得出，选手增量填写（草稿与提交分离，草稿同时落在浏览器本地），提交后进入审核与**补交窗口**——补交只放行被退回的题目，不等于重新报名。

<div align="center">

<img src="docs/diagrams/03-live-contest-operations.svg" alt="现场比赛运行" width="100%">

</div>

现场由工作人员推进状态，评委、选手与观众各自持一条**受控凭证**完成操作：评委扫码认领席位、选手按轮次上台、观众凭有效票据换入场会话再投票。四路输入并行，但写入统一受 Activity 行锁与锁定状态约束；故障时降级到代录与纸面，HOLD 不改变任何人的身份。

<div align="center">

<img src="docs/diagrams/04-result-authority-release.svg" alt="结果权威与发布" width="100%">

</div>

原始事实先被 resolver 解析成**候选**，经过 `READY_TO_CONFIRM` 与管理员确认才成为对外结果。候选与权威严格分离：输入过期（stale）必须拒绝，解锁只产生新版本、不改写历史。

<div align="center">

<img src="docs/diagrams/05-deployment-and-fallback.svg" alt="部署与降级" width="100%">

</div>

部署拓扑只有一条硬约束：反向代理是唯一入口，PostgreSQL 是权威。Realtime 与 Redis 是**增强层**——它们失效时退回 HTTP 轮询与人工 DR，而不是让流程停下。

<div align="center">

<img src="docs/diagrams/06-role-handbook.svg" alt="角色使用手册总览" width="100%">

</div>

六类角色的分工总览，公开端只作为结果输出端。下面按角色展开。

## 角色手册 · Role handbooks

每个角色一张图：左边是你实际要做的事，右边是平台为这一步承担的责任。

<div align="center">

<img src="docs/diagrams/07-role-participant.svg" alt="选手使用手册" width="100%">

</div>

**选手**：扫码进入活动 → 报名 → 按题填报 → 逐题上传材料 → 提交 → （被退回时）补交 → 现场候场 → 查看结果。断网也不丢：草稿实时写入浏览器本地存储，重开页面会恢复并重试；同一题被队友改过时先提示，不静默覆盖。分组合唱由外部抽签产生，本组材料共享，任一当前成员都可提交。

<div align="center">

<img src="docs/diagrams/08-role-staff.svg" alt="工作人员使用手册" width="100%">

</div>

**工作人员**：登录 → 审核报名与材料 → 准备轮次 → 录分 → 现场推进 → 结果与收尾。每一步都在服务端再判一次权限与锁定状态。异常先 HOLD；评分终端不可用时走代录或纸面评分（来源与原因必填）；重复提交是安全的，同一命令只产生一条评分事实。工作人员不能核定正式结果、不能解锁、不能替评委决定给谁打分。

<div align="center">

<img src="docs/diagrams/09-role-admin.svg" alt="管理员使用手册" width="100%">

</div>

**管理员**：登录 → 活动与阶段 → 冻结赛制版本 → 彩排与清残留 → 核定赛段结果 → 归档与权限。管理员是唯一能推进阶段、冻结规则、核定结果、解锁与改角色的角色，敏感动作要过二次密钥。彩排与正式不能混：离开测试模式前必须先清空运行时残留，有残留就不许转正式。

<div align="center">

<img src="docs/diagrams/10-role-judge.svg" alt="评委使用手册" width="100%">

</div>

**评委**：扫一次共享二维码，整晚在同一台手机上评分——认领空闲席位 → 看当前选手 → 输入并提交 → 等待切换。评分对象由服务器决定，评委不能自己挑人；现场暂停（HOLD）保留评委会话，恢复后原设备继续，只有释放席位、换组、丢设备或正式结束才需要重新扫码。

<div align="center">

<img src="docs/diagrams/11-role-audience.svg" alt="观众使用手册" width="100%">

</div>

**观众**：拿到入场票（印刷或电子）→ 扫码验证票据 → 由工作人员检票（成功 / 此前已检票 / 无效）→ 换取入场会话 → 在开放窗口投票。唯一性落在**票据加场次**上，不含设备与浏览器：一张有效票据只能换一条有效会话、投一份有效选票，票据作废或重发时旧会话与旧选票一并失效。

## 快速开始 · Setup

### Windows 本地启动

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

### 首次管理员 provisioning

商业 / 事件部署直接使用角色注册页面：管理员访问 `/register/admin/` 并填写
`ADMIN_ACCESS_KEY`，工作人员访问 `/register/staff/` 并填写 `STAFF_ACCESS_KEY`，选手访问
`/register/`。技术人员也可以使用一次性 provisioning 命令，不使用 `seed_dev_admin`：

```powershell
docker compose --env-file .env.event -f deploy/compose.event.yml exec web python manage.py provision_first_admin --username event-admin
```

命令会在容器内隐藏式读取密码，只能成功一次，不提供 reset/force 选项，也不会创建
Django superuser。自动化 launcher 可改用 `--password-stdin`，但密码不能放在命令行参数、
镜像、审计或日志中。`seed_dev_admin` 仍只用于本地开发。

## 部署 · Deployment

| 场景 | 编排文件 | 说明 |
|---|---|---|
| 本地 / 联调 | [`docker-compose.yml`](docker-compose.yml) | 固定 `APP_ENV: development`、`ALLOWED_HOSTS: localhost,127.0.0.1`、一个硬编码的本地数据库口令，端口绑定 `127.0.0.1:8000`。 |
| 生产 | [`deploy/compose.production.yml`](deploy/compose.production.yml) | 唯一的生产 manifest，细节见[生产部署说明](docs/deployment-production.md)。 |
| 事件本机 | [`deploy/compose.event.yml`](deploy/compose.event.yml) | 单机现场运行契约，细节见[现场事件部署说明](docs/deployment-event.md)。 |

`docker-compose.yml` **不是**生产部署文件。不要把它当作生产 manifest；在它之上套 `.env.production` 也不能让它变成生产配置。

### Docker PostgreSQL 启动（本地 / 联调）

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

### 事件本机运行

`deploy/compose.event.yml` 是单机现场运行契约：默认只绑定 `127.0.0.1:8000`，PostgreSQL 不发布端口，数据库和媒体使用持久化卷。购买者应使用 [现场事件部署说明](docs/deployment-event.md) 中的启动壳；只有明确传入 `-Lan` 时，手机才能通过同一私人网络访问。该 manifest 不提供公网入口。比赛期间始终只有这台主机上的一个主数据库/服务器可写。PowerPoint 播放与控制仍独立于 ArtFlow。

```powershell
Copy-Item .env.event.example .env.event
pwsh -NoProfile -File scripts\start-event.ps1
```

## 环境变量

从 `.env.example` 创建本地 `.env` 并替换其中的占位值。模板包含 `APP_ENV`、`SECRET_KEY`、`STAFF_ACCESS_KEY`、`ADMIN_ACCESS_KEY`、`DEV_ADMIN_USERNAME`、`DEV_ADMIN_PASSWORD`、`DEBUG` 和 `DATABASE_ENGINE`；`seed_dev_admin` 使用 `DEV_ADMIN_USERNAME` 和 `DEV_ADMIN_PASSWORD`。模板同时记录了一组**带安全默认值的可选运行参数**，不设置时按默认值运行：媒体交付后端 `ARTFLOW_DELIVERY_BACKEND`（当前仅实现 `local`，其它取值会在启动时报错而不是静默回落）、报名上传配额与保留版本数 `ARTFLOW_UPLOAD_QUOTA_MB` / `ARTFLOW_UPLOAD_MAX_VERSIONS`、媒体卷低水位 `ARTFLOW_UPLOAD_MIN_FREE_MB`、上传限流 `ARTFLOW_UPLOAD_RATE_LIMIT` / `ARTFLOW_UPLOAD_RATE_WINDOW_SECONDS`、个人信息保留天数 `ARTFLOW_PII_RETENTION_DAYS`、现场状态缓存 TTL `LIVE_STATE_CACHE_SECONDS`。管理员和工作人员的浏览器注册/登录分别使用对应密钥；管理员密码应使用浏览器密码字段、隐藏式交互输入或 stdin，不要保存到 tracked 文件。只有选择 PostgreSQL 时才需要 `POSTGRES_DB`、`POSTGRES_USER`、`POSTGRES_PASSWORD`、`POSTGRES_HOST` 和 `POSTGRES_PORT`。

生产环境使用 `.env.production.example` 作为字段清单：`APP_ENV=production`、`DEBUG=False`、真实的主机名和 CSRF 来源、PostgreSQL 连接配置都是必需的；`TRUST_X_FORWARDED_FOR` 只在可信反向代理覆盖客户端 `X-Forwarded-For` 时才设为 `true`。示例值仅是占位符；不得提交 `.env`、密钥、密码、数据库、媒体文件或生成的导出文件。生产拓扑见[生产部署说明](docs/deployment-production.md)。

## 验证与维护 · Verify

```powershell
uv run python manage.py check
uv run python manage.py makemigrations --check --dry-run
uv run python manage.py test
uv run python manage.py doctor
pwsh -NoProfile -File scripts/check_docs.ps1
pwsh -NoProfile -File scripts/verify_postgres_backup_restore.ps1 -ComposeProjectName artflow -BackupPath backups/artflow-rehearsal.dump
```

### 手机布局门禁

现场页面以**手机**为一等终端，所以布局本身也是门禁：七个手机宽度（320 / 360 / 375 / 390 / 393 / 412 / 430，覆盖初代 iPhone SE 到 Pro Max 与主流安卓）各是一个 Playwright project，iPhone 跑 WebKit（iOS Safari 与微信 iOS 的真实内核），安卓跑 Chromium。断言的是**页面不允许整体横向滚动**——表格在 `overflow-x-auto` 内部滚动是允许的（Django admin 的 changelist 也是这么做的）。需要先启动服务：

```powershell
uv run python manage.py migrate --noinput
uv run python manage.py prepare_layout_e2e --output-file test-results\layout-e2e.json
$env:PLAYWRIGHT_LAYOUT_FIXTURE_PATH = "test-results\layout-e2e.json"
uv run python manage.py runserver
# 另一个终端：
npx playwright install chromium webkit
npm run test:e2e
```

不带该 fixture 时 staff 页面会被跳过，公共页面仍会测量。

`doctor` 只读检查配置、数据库、迁移、运行目录和首个管理员 provisioning 状态。匿名探针只返回运行状态，不返回配置或业务数据：`GET /livez/` 表示进程存活（不查数据库），`GET /readyz/` 执行轻量 `SELECT 1` 验证数据库可用，`GET /healthz/` 是 readiness 的历史别名，容器/Caddy/CI 探针继续沿用。演示数据可用 `uv run python manage.py seed_demo_data --reset` 清理，但它只会删除该命令拥有且带测试标记的运行数据；仍应先在非重要数据库中验证。

数据库恢复不能用活动资料归档替代。Docker Compose 环境可用上面的备份恢复命令，把源库恢复到隔离临时容器并运行 Django 检查；该演练不会重置源数据库或卷。完整事件日矩阵见[生产准备演练](docs/production-readiness.md)，备份约束见 [PostgreSQL 备份与恢复演练](docs/postgres-backup-restore.md)。

## 目录结构 · Layout

```
config/              Django 设置、顶层路由与 WSGI/ASGI 入口。
accounts/            自定义 User 模型、角色与登录/注册流。
entry_access/        入场通行证与临时入场会话。
tickets/             票券与检票会话。
core/                Activity 模型与活动阶段、锁定状态。
ruleset/             赛制模板、ContestRuleset、版本化 RulesetVersion 与 resolver。
questionnaire/       问卷 DSL、编译计划、报名草稿与提交、后台设计器。
common/              审计、权限权威、业务规则守卫与生命周期助手。
public_portal/       公开首页、公告、风采与结果公示。
files/               提交文件、材料槽与材料核查。
singer_contest/      歌手报名、轮次、评委、评分与奖项。
farewell_show/       毕晚节目提交与节目单。
voting/              观众投票会话、选项与投票记录。
staff_panel/         工作人员与管理员后台视图。
exports/ archive/ incidents/  导出、归档与异常事件记录。
frontend/            浏览器端 TypeScript 入口（评分、投票、检票等）。
deploy/              生产与现场事件 Compose 契约。
docs/                开发基线、部署、演练与现场运行手册。
docs/diagrams/       流程图产物与图源定义（archify 生成，可持续再生成）。
scripts/             引导、校验、备份恢复与启动脚本。
```

## 工程原则 · Engineering rules

> ArtFlow 的底线是：**没有无授权的写入，没有绕开受控视图的文件访问，没有静默改写的结果。**

| 规则 | 要求 |
|---|---|
| 权限先于 mutation | 每个写路径进入前先判权限；模板不是授权边界。 |
| Activity 是变更权威 | 写操作先取 Activity 行锁，再服从活动、轮次与投票的锁定状态。 |
| 结果一经核定不可变 | 已 `CONFIRMED` 的赛段结果与公示不再改写；修正走新版本。 |
| 受控文件访问 | 内部文件走受控访问视图，私有媒体不挂静态路由。 |
| 测试数据保护 | 彩排数据与正式数据共存但隔离，离开测试模式前先清零运行时残留。 |
| 操作可追责 | 敏感操作、导出与解锁全部留痕，审计可回答「谁在什么时候改了什么」。 |
| 用户模型 | 使用 `settings.AUTH_USER_MODEL` 或 `get_user_model()`，不要直接引用 `auth.User`。 |
| 不提交运行时产物 | `.env`、密钥、SQLite 数据库、上传文件、导出、归档与生成媒体都不入库。 |
| 文档门禁 | 面向用户的文档改动后运行 `pwsh -NoProfile -File scripts/check_docs.ps1`。 |

## 开发与合并流程

在干净且最新的 `main` 上创建短期分支，完成验证后在分支提交；由负责合并的人以非快进方式合入 `main` 并推送。提交前至少运行 Django 检查、迁移检查、测试和文档检查。完整的数据库、Docker、CI、故障排查和安全说明见 [开发基线](docs/development-baseline.md)。

## 开发与维护 · Built by

<div align="center">

<p>由 <strong>衢州市柯城区昕序软件开发工作室</strong> 设计与开发。</p>

<p><sub>Designed and developed by <strong>XINXU Software Studio</strong>.</sub></p>

</div>

