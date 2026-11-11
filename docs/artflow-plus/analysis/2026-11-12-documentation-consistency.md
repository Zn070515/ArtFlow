# 文档口径审计（2026-11-12）

范围：仓库内会被当作“当前操作说明”阅读的 Markdown。历史 ADR、按日期的
plans/analysis、`docs/archive/`、`docs/advices/` 与 `docs/superpowers/` 作为证据
保留，不在本轮改写。

## 1. 唯一口径

| 主题 | 当前口径 | 权威位置 |
| --- | --- | --- |
| 产品线 | `main` 只承载 ArtFlow-Plus（v2）；v1 Django 源码在 tag `v1.0.2` | `README.md`、`GOAL.md` |
| 本地数据库 | `artflow-plus-postgres`，`127.0.0.1:5433`，可空 schema 由测试创建 | `docs/development-baseline.md` |
| 测试 schema | 浏览器 E2E 用 `artflow_e2e`，`workers: 1` | `docs/development-baseline.md` |
| 开发服务 | `pnpm --filter @artflow-plus/api start` / `... web dev` | `docs/development-baseline.md` |
| 生产编排 | `deploy/compose.production.yml` + `plus` profile，三镜像按 digest 固定 | `docs/deployment-production.md` |
| Schema 维护 | 迁移 → `schema.snapshot.json` → `src/types.ts` | `docs/development-baseline.md` |
| 契约工具 | `tools/contracts`，仅开发/CI，不进运行时镜像 | `docs/artflow-plus/README.md` |
| 文档门禁 | 链接、禁用内容、权威文档的退役命令 | `scripts/check_docs.ps1` |

## 2. 历史文档处理

以下文档在标题后加入历史横幅，指向当前基线：

- `docs/deployment-event.md`（v1 事件 Compose）
- `docs/production-readiness.md`（保留 M2 彩排记录）
- `docs/production-rehearsal-runbook.md`（已退役）
- `docs/local-load-simulation-plan.md`（已执行记录）
- `docs/private-test-data-runbook.md`（v1 私测）
- `docs/postgres-backup-restore.md`（v1 Compose 演练；当前备份见
  [`backup-restore.md`](../backup-restore.md)）
- `docs/singer-questionnaire-workflow.md`（v1 问卷）
- `docs/audit-2026-10.md`、`docs/artflow_feature_research.md`、
  `docs/artflow-v1-v2-comparative-analysis-2026-10.md`
- `docs/realtime-collaboration.md`（1.x Channels；已有 1.x 说明）

保留原文但不加横幅：`docs/architecture/adr/**`、`docs/artflow-plus/plans/**`、
`docs/artflow-plus/analysis/**`、`docs/archive/**`、`docs/incidents/**`。这些文件
按日期记录当时的决定，改写会破坏证据链。

## 3. 新增门禁

`scripts/check_docs.ps1` 在原有链接检查与禁用内容检查之外，对以下权威文档
额外禁止退役命令：

`README.md`、`AGENTS.md`、`CLAUDE.md`、`GOAL.md`、
`docs/development-baseline.md`、`docs/deployment-production.md`、
`docs/artflow-plus/README.md`、`docs/artflow-plus/roadmap.md`。

禁止：`manage.py`、`Gunicorn`、`artflow-web`、`/register/admin/`、
`ADMIN_ACCESS_KEY`、`scripts/deploy.sh`。

这样历史文档可以继续保留证据，而“当前怎么运行”的文档不会再滑回 v1。

## 4. 剩余已知差异

- `docs/artflow_feature_research.md` 与 v1 对比分析仍大量出现 Django 术语；
  它们是研究材料，已标记历史。
- 部分 2026-10 的 plans 使用当时的 `manage.py` 命令；它们是执行记录，不改写。
- `docs/artflow-plus/README.md` 的里程碑编号（M15.3 与 M16）来自不同阶段的
  命名；编号本身不构成操作口径，未在本轮重排。
