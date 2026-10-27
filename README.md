<div align="center">

<h1>ArtFlow</h1>

<p><strong>学院文艺活动全生命周期运行平台</strong> · <strong>Activity operations platform for university arts departments</strong></p>

<p>
  <a href="https://github.com/Zn070515/ArtFlow/actions/workflows/ci.yml"><img src="https://img.shields.io/github/actions/workflow/status/Zn070515/ArtFlow/ci.yml?branch=main&label=CI" alt="CI status"></a>
  <a href="https://github.com/Zn070515/ArtFlow/actions/workflows/integration.yml"><img src="https://img.shields.io/github/actions/workflow/status/Zn070515/ArtFlow/integration.yml?branch=main&label=PostgreSQL%20integration" alt="PostgreSQL integration"></a>
  <a href="https://github.com/Zn070515/ArtFlow/actions/workflows/security.yml"><img src="https://img.shields.io/github/actions/workflow/status/Zn070515/ArtFlow/security.yml?branch=main&label=Security" alt="Security"></a>
  <a href="LICENSE.md"><img src="https://img.shields.io/badge/License-PolyForm%20Dual-6f42c1?style=flat" alt="PolyForm dual license"></a>
</p>

<p>
  <img src="https://img.shields.io/badge/Python-3.12-3776AB?logo=python&logoColor=white" alt="Python 3.12">
  <img src="https://img.shields.io/badge/Django-6.0-092E20?logo=django&logoColor=white" alt="Django 6.0">
  <img src="https://img.shields.io/badge/uv-0.11.29-DE5FE9?logo=astral&logoColor=white" alt="uv 0.11.29">
  <img src="https://img.shields.io/badge/SQLite%20%7C%20PostgreSQL-336791?logo=postgresql&logoColor=white" alt="SQLite or PostgreSQL">
  <img src="https://img.shields.io/badge/Docker-Compose-2496ED?logo=docker&logoColor=white" alt="Docker Compose">
</p>

<p>
  <strong>ArtFlow-Plus (v2)</strong>
</p>

<p>
  <img src="https://img.shields.io/badge/Node-24-339933?logo=node.js&logoColor=white" alt="Node 24">
  <img src="https://img.shields.io/badge/TypeScript-7-3178C6?logo=typescript&logoColor=white" alt="TypeScript 7">
  <img src="https://img.shields.io/badge/Fastify-5-000000?logo=fastify&logoColor=white" alt="Fastify 5">
  <img src="https://img.shields.io/badge/React-19-61DAFB?logo=react&logoColor=white" alt="React 19">
  <img src="https://img.shields.io/badge/PostgreSQL-18-336791?logo=postgresql&logoColor=white" alt="PostgreSQL 18">
  <img src="https://img.shields.io/badge/pnpm-12-F69220?logo=pnpm&logoColor=white" alt="pnpm 12">
  <a href="https://github.com/Zn070515/ArtFlow/actions/workflows/gates.yml"><img src="https://img.shields.io/github/actions/workflow/status/Zn070515/ArtFlow/gates.yml?branch=artflow-plus&label=Gates" alt="Plus gates status"></a>
</p>

<p>
  <img src="docs/assets/brand/artflow-logo.png" alt="ArtFlow 标志 · ArtFlow logo" height="108" width="122">
  &nbsp;&nbsp;
  <img src="docs/assets/brand/xinxu-studio-logo.png" alt="昕序软件科技标志 · XINXU SOFTWARE logo" height="108" width="131">
</p>

<p>
  <a href="#两条时代线--two-era-lines">两条时代线</a> ·
  <a href="#artflow-plusv2">ArtFlow-Plus（v2）</a> ·
  <a href="#1x-生产线--1x-production-line">1.x 生产线</a> ·
  <a href="#先读这些--read-these-first">文档索引</a> ·
  <a href="#工程原则--engineering-rules">工程原则</a> ·
  <a href="#开发与合并流程">开发流程</a>
</p>

</div>

ArtFlow 是面向学院文艺部的 **EventOps 活动运行平台**：把原本散落在微信群、Excel、Word、问卷星、网盘附件、纸质评分表与主持手卡里的活动工作，收束成一套报名、材料收集、审核、评分、投票、公示、导出与归档都可追溯的在线流程。

第一个生产验证场景是学院十佳歌手大赛与毕业晚会，但 ArtFlow 的目标不是「十佳算分器」，而是一套可长期运行、可复用到多类学院文艺活动的运行平台。产品目标与领域边界见 [GOAL.md](GOAL.md)。

> **项目状态：** 仓库里有两条时代线。`main` 是 **1.x 生产维护线**（Django，线上 v1.0.x）；`artflow-plus` 是 **v2 开发主线 ArtFlow-Plus**，M0–M13.3 已完成，cutover 代码与手册已就绪但**尚未切换生产**。验证入口以[开发基线](docs/development-baseline.md)为准；本文不复述测试数量、commit 或 CI 结果，避免与代码漂移。

## 两条时代线 · Two era lines

| 分支 | 角色 | 技术栈 | 状态 |
|---|---|---|---|
| [`main`](https://github.com/Zn070515/ArtFlow/tree/main) | ArtFlow 1.x 生产维护线 | Django 6 / SQLite·PostgreSQL / TypeScript 前端入口 | 线上 v1.0.x；只接受现场与部署的最小修复 |
| [`artflow-plus`](https://github.com/Zn070515/ArtFlow/tree/artflow-plus) | ArtFlow-Plus（v2）开发主线 | Node 24 / Fastify 5 / TypeBox / Kysely / React 19 / PostgreSQL 18 | M0–M13.3 完成；cutover 待执行 |

- **不机械合并。** v1 的局部实现 bug 只修 `main`；业务不变量提炼成 v2 的 domain spec / golden / contract，用 v2 自己的实现重新满足；部署事故提炼成部署不变量。
- **版本 tag 只从 `main` 打。** `v*` tag 是发布权威；普通 push 不构建镜像。
- **生产只在一条线上写。** cutover 是主域名整体替换，回滚边界是「首次 v2 正式写入前」（ADR-0023）。

## ArtFlow-Plus（v2）

v2 把 v1 的「按 app 与页面切分」重写成 **薄 Activity + capability 组合 + 不可变 release + 事件日志投影**：

| 层 | 目录 | 职责 |
|---|---|---|
| API | [`plus/apps/api`](plus/apps/api) | Fastify 5 + TypeBox OpenAPI；command 路由、公开读、Cookie 会话与 CSRF、单一 WebSocket 端点 `/api/realtime` |
| Web | [`plus/apps/web`](plus/apps/web) | React 19 + Vite + TanStack Router/Query；Studio / Ops / Live / Portal，以及观众投票页 `/vote/<sessionId>` |
| Worker | [`plus/apps/worker`](plus/apps/worker) | 事务 outbox → 投影 relay（进程内 250ms 循环 + pg-boss 分钟级兜底） |
| Domain | [`plus/packages/domain`](plus/packages/domain) | 纯领域：Activity、capability registry、compiler、Pack、command/event 模型 |
| Runtime | [`plus/packages/runtime`](plus/packages/runtime) | command handler、投影、competition/voting/publishing/archive/grouping/legacy import |
| DB | [`plus/packages/db`](plus/packages/db) | Kysely schema、module-owned migrations、repository |
| Contracts | [`plus/packages/contracts`](plus/packages/contracts) | 服务端与浏览器共享的 TypeBox schema |
| Realtime | [`plus/packages/realtime`](plus/packages/realtime) | 受保护的 WebSocket 核心（`/protocol`、`/server`、`/client`），契约见 [CORE.md](plus/packages/realtime/CORE.md) |

**capability**：`registration`、`questionnaire`、`materials`、`competition`、`voting`、`ticketing`、`publishing`、`archive`、`grouping`。**Pack**：`singer-competition`、`stage-show`、`review-awards`、`vote-poll`。三种结构的活动加纯投票活动已在同一内核上验证；新增形状只改组合与默认 definition。

**里程碑**：M0 Legacy Extraction → M1 Engine Kernel → M2 Capability Composition → M3 Execution Runtime → M4 Registration → M5 Competition/Evaluation → M6 Voting/Ticketing → M7 Publishing/Archive → M8 Product Surfaces 与 Cutover → M9 Grouping → M10 投票结果发布 → M11 实时核心与投票 UI → M12 参与者投票页 → M13 Live 迁移到实时核心 → M13.1 运营接管与来源级消费 → M13.3 参与者与材料接管收口。逐项出口见 [roadmap](docs/artflow-plus/roadmap.md)。

**关键不变量**：单写路径（receipt + audit + fact + outbox 同事务）、release 不可变、事件/投影按 mode 分区、公开结果唯一 selector、实时通道只做失效提示（HTTP 是恢复权威）。规则全集见 [不变量索引](docs/invariants/README.md)，结构门禁见 [门禁索引](docs/gates/README.md)。

### v2 快速开始

v2 使用 PostgreSQL 18 与 pnpm 12；本地开发库容器为 `artflow-plus-postgres`（`127.0.0.1:5433`，库 `artflow_plus`，用户 `artflow`，开发口令 `artflow_dev`）：

```powershell
docker start artflow-plus-postgres

Set-Location plus
pnpm install
pnpm run check

$env:ARTFLOW_PLUS_DATABASE_URL = "postgresql://artflow:artflow_dev@127.0.0.1:5433/artflow_plus"
$env:REQUIRE_DB = "1"
pnpm run test

pnpm --filter @artflow-plus/api start   # 启动时自动 migrate，默认 127.0.0.1:3000
pnpm --filter @artflow-plus/web dev     # Vite 代理 /api 到 API
```

环境变量：`ARTFLOW_PLUS_DATABASE_URL`（必填）、`ARTFLOW_PLUS_DB_SCHEMA`、`PORT` / `HOST`、`ARTFLOW_PLUS_CREDENTIAL_SECRET`、`ARTFLOW_PLUS_ARCHIVE_DIR`、`ARTFLOW_PLUS_MEDIA_DIR`、`ARTFLOW_PLUS_LEGACY_MEDIA_DIR`（接管时只读挂载 v1 媒体卷）、`ARTFLOW_PLUS_INLINE_RELAY=1`（单进程/E2E 时在 API 内跑 relay）、`VITE_API_TARGET`。浏览器 E2E 使用独立 schema `artflow_e2e`。

### v2 文档入口

| 文档 | 内容 |
|---|---|
| [`docs/artflow-plus/README.md`](docs/artflow-plus/README.md) | v2 开发主线、两条时代线与分支纪律 |
| [`docs/artflow-plus/roadmap.md`](docs/artflow-plus/roadmap.md) | M0–M13.3 里程碑与出口证据 |
| [`docs/artflow-plus/shape-validation.md`](docs/artflow-plus/shape-validation.md) | 三类活动验证与明确缺口 |
| [`docs/artflow-plus/frontend-design-direction.md`](docs/artflow-plus/frontend-design-direction.md) | Portal / Console 双壳视觉方向与桌面布局规格 |
| [`docs/architecture/adr/`](docs/architecture/adr/README.md) | v2 架构决策（ADR-0001…0034） |
| [`docs/invariants/`](docs/invariants/README.md) | 领域不变量（AUTH/LIFE/CONC/SCOR/RES/TICK/GRP/RT/DEPL） |
| [`docs/domains/`](docs/domains/README.md) | capability 领域模型与实时核心（含 grouping / realtime） |
| [`docs/gates/`](docs/gates/README.md) | 结构/golden/架构门禁 |
| [`docs/artflow-plus/specs/`](docs/artflow-plus/specs/) · [`plans/`](docs/artflow-plus/plans/) | 每个 slice 的设计与实现计划 |
| [`docs/artflow-plus/cutover-runbook.md`](docs/artflow-plus/cutover-runbook.md) · [`rehearsal-runbook.md`](docs/artflow-plus/rehearsal-runbook.md) | 生产切换与现场彩排 |

### v2 部署与 cutover

v2 以 compose `plus` profile 与 v1 同主机并行运行，使用独立的 PostgreSQL 库/卷/凭证；主域名通过 Caddy site profile **整体替换**，不按活动或路径混跑。回滚边界是首次 v2 正式写入前；切换后 v1 只读一个完整活动周期。具体预检、导入、smoke 与回滚步骤见 [cutover runbook](docs/artflow-plus/cutover-runbook.md)，拓扑决策见 ADR-0023。

## 先读这些 · Read these first

| 文档 | 它约束什么 |
|---|---|
| [`GOAL.md`](GOAL.md) | 产品目标、领域边界与工程原则基线（v2 身份权威）。 |
| [`CLAUDE.md`](CLAUDE.md) | 编码代理的运行约定与仓库红线。 |
| [`AGENTS.md`](AGENTS.md) | 两条线的模块划分、目录职责与贡献准则。 |
| [`docs/development-baseline.md`](docs/development-baseline.md) | v1 与 v2 已验证的开发、运行与验收基线。 |
| [`docs/artflow-plus/roadmap.md`](docs/artflow-plus/roadmap.md) | v2 里程碑 M0–M13.3 与出口证据。 |
| [`docs/artflow-plus/shape-validation.md`](docs/artflow-plus/shape-validation.md) | 三类活动验证与明确缺口。 |
| [`CHANGELOG.md`](CHANGELOG.md) | v1 按批次记录的权威收敛与行为变更；v2 见 roadmap 与 ADR。 |
| [`docs/`](docs/) | 部署、演练、备份恢复与现场运行手册。 |

## 1.x 生产线 · 1.x production line

以下描述 `main` 上的 Django 生产实现。v2 的对应能力见上文与 roadmap；部署拓扑见[生产部署说明](docs/deployment-production.md)，开发与验收细节见[开发基线](docs/development-baseline.md)。

### 产品方向 · Product direction

| 层次 | 职责 |
|---|---|
| 公开门户 | 公告、往届风采、结果公示与活动入口。 |
| 报名与材料 | 报名表、材料槽、提交文件与材料核查。 |
| 赛制与结果 | 版本化规则图、编译器 / 验证器、resolver 与结果板。 |
| 现场运行 | 快速录分、观众投票、检票入场与手卡抄录。 |
| 导出与归档 | Excel / Word 导出、活动归档与审计留痕。 |

### 核心领域 · Core domains

- **歌手比赛**（`singer_contest` + `ruleset`）：把赛制表达为受 schema 约束的版本化 JSON 规则图，经编译器 / 验证器检查后冻结，再由 resolver 产生 `HOLD / REVIEW / READY_TO_CONFIRM / CONFIRMED` 结果。当年决赛流程见[院十佳决赛生产流程](docs/singer-final-production-flow.md)。
- **活动运行**（`public_portal` / `files` / `farewell_show` / `voting` / `exports` / `archive` …）：报名、材料槽、审核、投票、导出、归档与审计，遵守 Activity 作为 mutation 边界的锁定与权限规则。

### 模块与流程 · Modules & flows

v1 后端按领域切成 Django app（账号与活动、赛制与问卷、比赛与材料、观众侧、运营与产物），浏览器不直连数据层。横切边界只有三条：私有文件走受控媒体视图按所有权判读权；写操作先取 Activity 行锁、再按域显式授权；敏感操作、导出与解锁全部留痕。

模块全景、活动生命周期、现场运行、结果发布与部署降级的渲染产物和图源都在[流程图目录](docs/diagrams/README.md)；每个节点都锚定到具体源码，可逐条核对。

### 角色手册 · Role handbooks

| 角色 | 关键流程 | 手册 |
|---|---|---|
| 选手 | 扫码报名 → 填报 → 上传材料 → 补交 → 候场 → 查看结果；草稿本地保存 | [07](docs/diagrams/07-role-participant.svg) |
| 工作人员 | 审核报名与材料 → 准备轮次 → 录分 → 现场推进 → 收尾；异常先 HOLD | [08](docs/diagrams/08-role-staff.svg) |
| 管理员 | 推进阶段 → 冻结赛制 → 彩排清残留 → 核定结果 → 归档与权限 | [09](docs/diagrams/09-role-admin.svg) |
| 评委 | 扫共享二维码认领席位 → 看当前选手 → 评分 → 等待切换 | [10](docs/diagrams/10-role-judge.svg) |
| 观众 | 票据验证 → 换取入场会话 → 在开放窗口投票；唯一性落在票据加场次 | [11](docs/diagrams/11-role-audience.svg) |

### 快速开始（1.x）

本地路径使用 SQLite，不需要本机 PostgreSQL：

```powershell
Copy-Item .env.example .env
# 替换所有 change-me 占位值，尤其是 DEV_ADMIN_PASSWORD
uv sync --locked --extra dev
uv run python manage.py migrate --noinput
uv run python manage.py seed_dev_admin
uv run python manage.py seed_demo_data
uv run python manage.py runserver
```

启动后访问 `http://127.0.0.1:8000/`。`seed_demo_data` 可重复执行，不是生产初始化；`--reset` 只删命令自有且带测试标记的数据。`scripts\bootstrap.ps1` 可自动完成依赖同步、迁移与诊断（`-SeedDemoData` 额外写演示数据）。首次管理员 provisioning、Docker/PostgreSQL 与事件本机运行见[开发基线](docs/development-baseline.md)与[现场事件部署](docs/deployment-event.md)。

### 部署 · Deployment

| 场景 | 编排文件 | 说明 |
|---|---|---|
| 本地 / 联调 | [`docker-compose.yml`](docker-compose.yml) | 固定 `APP_ENV: development`、`ALLOWED_HOSTS: localhost,127.0.0.1`，端口只绑 `127.0.0.1:8000`。 |
| 生产 | [`deploy/compose.production.yml`](deploy/compose.production.yml) | 唯一的生产 manifest，细节见[生产部署说明](docs/deployment-production.md)。 |
| 事件本机 | [`deploy/compose.event.yml`](deploy/compose.event.yml) | 单机现场运行契约，细节见[现场事件部署说明](docs/deployment-event.md)。 |

`docker-compose.yml` **不是**生产部署文件；在它之上套 `.env.production` 也不能让它变成生产配置。

### 验证与维护 · Verify

```powershell
uv run python manage.py check
uv run python manage.py makemigrations --check --dry-run
uv run python manage.py test
uv run python manage.py doctor
pwsh -NoProfile -File scripts/check_docs.ps1
```

`doctor` 只读检查配置、数据库、迁移、运行目录与管理员 provisioning 状态。`/livez/`、`/readyz/`、`/healthz/` 的含义，手机布局门禁、PostgreSQL 验收、备份恢复演练与故障排查见[开发基线](docs/development-baseline.md)。

### 目录结构 · Layout

```
config/              Django 设置、顶层路由与 WSGI/ASGI 入口。
accounts/ core/ ruleset/ questionnaire/ files/ singer_contest/ voting/
tickets/ entry_access/ public_portal/ farewell_show/ staff_panel/
exports/ archive/ incidents/ common/     1.x 领域 app（职责见 AGENTS.md）。
frontend/            1.x 浏览器端 TypeScript 入口。
plus/                ArtFlow-Plus（v2）workspace。
deploy/              v1 与 v2 的 Compose/Caddy 契约；deploy/plus 为 v2 镜像。
docs/                基线、部署、演练、领域/ADR/不变量/v2 文档与流程图。
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
| v2 单写路径 | receipt、audit、事实与 outbox 在同一事务提交；同 command id 重试先 replay。 |
| v2 release 不可变 | Release 冻结 capability 版本、declared scopes 与冲突策略。 |
| v2 模式隔离 | 事实、选票、排名、事件与投影按 mode 分区；测试/彩排不污染正式结果。 |
| v2 capability 边界 | capability 不跨表读写；`GATE-PLUS-BOUNDARY-01` 强制。 |
| v2 实时核心 | 只有 `packages/realtime` 拥有 WebSocket 传输；HTTP 是恢复权威；`GATE-REALTIME-CORE-01` 强制。 |

## 开发与合并流程

两条线各有自己的集成目标，**不要跨国合并**：

- **1.x 修复**：从干净的 `main` 切短期分支（`hotfix/*`），验证后以非快进方式合入 `main` 并推送；`v*` tag 只从 `main` 打。
- **v2 开发**：从干净的 `artflow-plus` 切短期分支（`feat/*`、`fix/*`、`docs/*`），验证后合入 `artflow-plus` 并推送。v1 的实现 bug 不 cherry-pick 进 v2；业务不变量转译成 v2 的 domain spec / golden。
- **cutover**：主域名整体切换，不做长期双写；步骤见 [cutover runbook](docs/artflow-plus/cutover-runbook.md)。

v1 提交前至少运行 Django 检查、迁移检查、测试和文档检查；v2 提交前运行 `pnpm -C plus run check`、`pnpm -C plus run test`（`REQUIRE_DB=1`）、`uv run pytest tests/gates -q` 与 `scripts/check_docs.ps1`。完整的数据库、Docker、CI、故障排查和安全说明见[开发基线](docs/development-baseline.md)。

## 许可与商业授权 · License

ArtFlow 的项目级授权见 [LICENSE.md](LICENSE.md)，两份 PolyForm 标准正文位于 [`licenses/`](licenses/)。商业发行、收费托管、转售或超出适用免费许可范围的商业部署，请先阅读[商业授权说明](COMMERCIAL-LICENSE.md)并取得单独的书面授权；第三方依赖仍受其自身许可证约束。

## 开发与维护 · Built by

<div align="center">

<p>由 <strong>衢州市柯城区昕序软件开发工作室</strong> 设计与开发。</p>

<p><sub>Designed and developed by <strong>XINXU Software Studio</strong>.</sub></p>

</div>
