<div align="center">

<h1>ArtFlow</h1>

<p><strong>学院文艺活动全生命周期运行平台</strong> · <strong>Activity operations platform for university arts departments</strong></p>

<p>
  <a href="https://github.com/Zn070515/ArtFlow/actions/workflows/gates.yml"><img src="https://img.shields.io/github/actions/workflow/status/Zn070515/ArtFlow/gates.yml?branch=main&label=Gates" alt="Gates status"></a>
  <a href="https://github.com/Zn070515/ArtFlow/actions/workflows/ci.yml"><img src="https://img.shields.io/github/actions/workflow/status/Zn070515/ArtFlow/ci.yml?branch=main&label=CI" alt="CI status"></a>
  <a href="https://github.com/Zn070515/ArtFlow/actions/workflows/security.yml"><img src="https://img.shields.io/github/actions/workflow/status/Zn070515/ArtFlow/security.yml?branch=main&label=Security" alt="Security"></a>
  <a href="LICENSE.md"><img src="https://img.shields.io/badge/License-PolyForm%20Dual-6f42c1?style=flat" alt="PolyForm dual license"></a>
</p>

<p>
  <img src="https://img.shields.io/badge/Node-24-339933?logo=node.js&logoColor=white" alt="Node 24">
  <img src="https://img.shields.io/badge/TypeScript-7-3178C6?logo=typescript&logoColor=white" alt="TypeScript 7">
  <img src="https://img.shields.io/badge/Fastify-5-000000?logo=fastify&logoColor=white" alt="Fastify 5">
  <img src="https://img.shields.io/badge/React-19-61DAFB?logo=react&logoColor=white" alt="React 19">
  <img src="https://img.shields.io/badge/PostgreSQL-18-336791?logo=postgresql&logoColor=white" alt="PostgreSQL 18">
  <img src="https://img.shields.io/badge/pnpm-12-F69220?logo=pnpm&logoColor=white" alt="pnpm 12">
</p>

<p>
  <img src="docs/assets/brand/artflow-logo.png" alt="ArtFlow 标志 · ArtFlow logo" height="108" width="122">
  &nbsp;&nbsp;
  <img src="docs/assets/brand/xinxu-studio-logo.png" alt="昕序软件科技标志 · XINXU SOFTWARE logo" height="108" width="131">
</p>

<p>
  <a href="#项目现状">项目现状</a> ·
  <a href="#artflow-plus">ArtFlow-Plus</a> ·
  <a href="#先读这些--read-these-first">文档索引</a> ·
  <a href="#工程原则--engineering-rules">工程原则</a> ·
  <a href="#开发与合并流程">开发流程</a>
</p>

</div>

ArtFlow 是面向学院文艺部的 **EventOps 活动运行平台**：把原本散落在微信群、Excel、Word、问卷星、网盘附件、纸质评分表与主持手卡里的活动工作，收束成一套报名、材料收集、审核、评分、投票、公示、导出与归档都可追溯的在线流程。

第一个生产验证场景是学院十佳歌手大赛与毕业晚会，但 ArtFlow 的目标不是「十佳算分器」，而是一套可长期运行、可复用到多类学院文艺活动的运行平台。产品目标与领域边界见 [GOAL.md](GOAL.md)。

> **项目状态：** `main` 是唯一的开发主线，承载 ArtFlow-Plus（v2）。1.x 的 Django 实现已完成历史使命，源码暂留作外部审核对照，审核通过后删除；仓库不再维护双线，也不再提供 v1 数据导入与 cutover 兼容。验证入口以[开发基线](docs/development-baseline.md)为准。

## 项目现状

| 项目 | 说明 |
|---|---|
| 开发主线 | `main`，Node 24 / Fastify 5 / TypeBox / Kysely / React 19 / PostgreSQL 18 |
| 状态 | M0–M13.3 与后续能力已完成；v2 是唯一在开发与部署的产品线 |
| 1.x 代码 | Django app 暂留在根目录，仅作外部审核对照；不再接新功能，审核后删除 |
| v1 兼容 | 已移除：不再支持 legacy bundle 导入、运营接管、参与者认领或 v1 媒体桥 |

## ArtFlow-Plus（v2）

v2 把 v1 的「按 app 与页面切分」重写成 **薄 Activity + capability 组合 + 不可变 release + 事件日志投影**：

| 层 | 目录 | 职责 |
|---|---|---|
| API | [`plus/apps/api`](plus/apps/api) | Fastify 5 + TypeBox OpenAPI；command 路由、公开读、Cookie 会话与 CSRF、单一 WebSocket 端点 `/api/realtime` |
| Web | [`plus/apps/web`](plus/apps/web) | React 19 + Vite + TanStack Router/Query；Studio / Ops / Live / Portal，以及观众投票页 `/vote/<sessionId>` |
| Worker | [`plus/apps/worker`](plus/apps/worker) | 事务 outbox → 投影 relay（进程内 250ms 循环 + pg-boss 分钟级兜底） |
| Domain | [`plus/packages/domain`](plus/packages/domain) | 纯领域：Activity、capability registry、compiler、Pack、command/event 模型 |
| Runtime | [`plus/packages/runtime`](plus/packages/runtime) | command handler、投影、competition/voting/publishing/archive/grouping |
| DB | [`plus/packages/db`](plus/packages/db) | Kysely schema、module-owned migrations、repository |
| Contracts | [`plus/packages/contracts`](plus/packages/contracts) | 服务端与浏览器共享的 TypeBox schema |
| Realtime | [`plus/packages/realtime`](plus/packages/realtime) | 受保护的 WebSocket 核心（`/protocol`、`/server`、`/client`），契约见 [CORE.md](plus/packages/realtime/CORE.md) |

**capability**：`registration`、`questionnaire`、`materials`、`competition`、`voting`、`ticketing`、`publishing`、`archive`、`grouping`、`tasks`。**Pack**：`singer-competition`、`stage-show`、`review-awards`、`vote-poll`。三种结构的活动加纯投票活动已在同一内核上验证；新增形状只改组合与默认 definition。

**里程碑**：M0 Legacy Extraction → M1 Engine Kernel → M2 Capability Composition → M3 Execution Runtime → M4 Registration → M5 Competition/Evaluation → M6 Voting/Ticketing → M7 Publishing/Archive → M8 Product Surfaces → M9 Grouping → M10 投票结果发布 → M11 实时核心与投票 UI → M12 参与者投票页 → M13 Live 迁移到实时核心 → M13.1–M13.3 运营、语义与材料收口。逐项出口见 [roadmap](docs/artflow-plus/roadmap.md)。

**关键不变量**：单写路径（receipt + audit + fact + outbox 同事务）、release 不可变、事件/投影按 mode 分区、公开结果唯一 selector、实时通道只做失效提示（HTTP 是恢复权威）。规则全集见 [不变量索引](docs/invariants/README.md)，结构门禁见 [门禁索引](docs/gates/README.md)。

### 快速开始

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

环境变量：`ARTFLOW_PLUS_DATABASE_URL`（必填）、`ARTFLOW_PLUS_DB_SCHEMA`、`PORT` / `HOST`、`ARTFLOW_PLUS_CREDENTIAL_SECRET`、`ARTFLOW_PLUS_ARCHIVE_DIR`、`ARTFLOW_PLUS_MEDIA_DIR`、`ARTFLOW_PLUS_INLINE_RELAY=1`（单进程/E2E 时在 API 内跑 relay）、`VITE_API_TARGET`。浏览器 E2E 使用独立 schema `artflow_e2e`。

### 文档入口

| 文档 | 内容 |
|---|---|
| [`docs/artflow-plus/README.md`](docs/artflow-plus/README.md) | v2 开发主线、分支纪律与部署拓扑 |
| [`docs/artflow-plus/roadmap.md`](docs/artflow-plus/roadmap.md) | 里程碑与出口证据 |
| [`docs/artflow-plus/shape-validation.md`](docs/artflow-plus/shape-validation.md) | 三类活动验证与明确缺口 |
| [`docs/artflow-plus/skeleton-coverage.md`](docs/artflow-plus/skeleton-coverage.md) | v1 → v2 功能覆盖审计与待办缺口 |
| [`docs/artflow-plus/frontend-design-direction.md`](docs/artflow-plus/frontend-design-direction.md) | Portal / Console 双壳视觉方向与桌面布局规格 |
| [`docs/architecture/adr/`](docs/architecture/adr/README.md) | v2 架构决策（ADR-0001…0037） |
| [`docs/invariants/`](docs/invariants/README.md) | 领域不变量（AUTH/LIFE/CONC/SCOR/RES/TICK/GRP/RT/DEPL） |
| [`docs/domains/`](docs/domains/README.md) | capability 领域模型与实时核心（含 grouping / realtime） |
| [`docs/gates/`](docs/gates/README.md) | 结构/golden/架构门禁 |
| [`docs/artflow-plus/specs/`](docs/artflow-plus/specs/) · [`plans/`](docs/artflow-plus/plans/) | 每个 slice 的设计与实现计划 |

### 部署

v2 使用 `deploy/compose.production.yml` 的 `plus` profile：独立 PostgreSQL 库/卷/凭证，Caddy 将主域名指向 plus-web。三个镜像由同一个 `v*` tag 构建，生产镜像必须填写 workflow 输出的 `@sha256:...` digest。备份恢复见 [backup-restore](docs/artflow-plus/backup-restore.md)。

## 先读这些 · Read these first

| 文档 | 它约束什么 |
|---|---|
| [`GOAL.md`](GOAL.md) | 产品目标、领域边界与工程原则基线。 |
| [`CLAUDE.md`](CLAUDE.md) | 编码代理的运行约定与仓库红线。 |
| [`AGENTS.md`](AGENTS.md) | 模块划分、目录职责与贡献准则。 |
| [`docs/development-baseline.md`](docs/development-baseline.md) | 已验证的开发、运行与验收基线。 |
| [`docs/artflow-plus/roadmap.md`](docs/artflow-plus/roadmap.md) | 里程碑与出口证据。 |
| [`docs/artflow-plus/skeleton-coverage.md`](docs/artflow-plus/skeleton-coverage.md) | v1 → v2 覆盖审计；删除 1.x 代码前必须先收敛这里的缺口。 |
| [`CHANGELOG.md`](CHANGELOG.md) | 1.x 历史变更记录（只读归档）。 |
| [`docs/`](docs/) | 部署、演练、备份恢复与现场运行手册。 |

## 工程原则 · Engineering rules

> ArtFlow 的底线是：**没有无授权的写入，没有绕开受控视图的文件访问，没有静默改写的结果。**

| 规则 | 要求 |
|---|---|
| 权限先于 mutation | 每个写路径进入前先判权限；模板不是授权边界。 |
| Activity 是变更权威 | 写操作先取 Activity 行锁，再服从活动、轮次与投票的锁定状态。 |
| 结果一经核定不可变 | 已确认的赛段结果与公示不再改写；修正走新版本。 |
| 受控文件访问 | 内部文件走受控访问视图，私有媒体不挂静态路由。 |
| 测试数据保护 | 彩排数据与正式数据共存但隔离，离开测试模式前先清零运行时残留。 |
| 操作可追责 | 敏感操作、导出与解锁全部留痕，审计可回答「谁在什么时候改了什么」。 |
| 不提交运行时产物 | `.env`、密钥、SQLite 数据库、上传文件、导出、归档与生成媒体都不入库。 |
| 文档门禁 | 面向用户的文档改动后运行 `pwsh -NoProfile -File scripts/check_docs.ps1`。 |
| 单写路径 | receipt、audit、事实与 outbox 在同一事务提交；同 command id 重试先 replay。 |
| release 不可变 | Release 冻结 capability 版本、declared scopes 与冲突策略。 |
| 模式隔离 | 事实、选票、排名、事件与投影按 mode 分区；测试/彩排不污染正式结果。 |
| capability 边界 | capability 不跨表读写；`GATE-PLUS-BOUNDARY-01` 强制。 |
| 实时核心 | 只有 `packages/realtime` 拥有 WebSocket 传输；HTTP 是恢复权威；`GATE-REALTIME-CORE-01` 强制。 |

## 开发与合并流程

从干净的 `main` 切短期分支（`feat/*`、`fix/*`、`docs/*`），验证后以非快进方式合入 `main` 并推送；不重写或强推共享历史。`v*` tag 只从 `main` 打。

提交前至少运行 `pnpm -C plus run check`、`REQUIRE_DB=1 pnpm -C plus run test`、`uv run pytest tests/gates -q` 与 `pwsh -NoProfile -File scripts/check_docs.ps1`。完整的数据库、Docker、CI、故障排查和安全说明见[开发基线](docs/development-baseline.md)。

1.x 的 Django 源码在删除前仍可用 `uv sync --locked --extra dev` 与 `uv run python manage.py check` 做只读核对，但不再是交付路径，也不再接受新功能。

## 许可与商业授权 · License

ArtFlow 的项目级授权见 [LICENSE.md](LICENSE.md)，两份 PolyForm 标准正文位于 [`licenses/`](licenses/)。商业发行、收费托管、转售或超出适用免费许可范围的商业部署，请先阅读[商业授权说明](COMMERCIAL-LICENSE.md)并取得单独的书面授权；第三方依赖仍受其自身许可证约束。

## 开发与维护 · Built by

<div align="center">

<p>由 <strong>衢州市柯城区昕序软件开发工作室</strong> 设计与开发。</p>

<p><sub>Designed and developed by <strong>XINXU Software Studio</strong>.</sub></p>

</div>
