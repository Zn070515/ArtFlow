# 单线 v2：main 接管与 v1 兼容层移除

日期：2026-11-06
状态：已批准实施

## 背景

ArtFlow 1.x（含线上 v1.0.2）已完成使命。仓库不再维护两条时代线：
`artflow-plus` 合并进 `main`，之后只在 `main` 上开发 v2。Django 1.x 源码
暂留，等外部审核通过后单独删除；本轮的代码删除只针对 Plus 对 v1 的兼容桥。

## 合并拓扑

- 新提交 `merge: adopt ArtFlow-Plus as the single main line`，双父：
  `main`（v1.0.2）与 `artflow-plus`（M13.3 之后）。
- 结果树 = `artflow-plus` 全量 + `main` 的 v1.0.2 Django 文件
  （25 个修改文件、3 个新增文件、`deploy/Caddyfile`，共 29 个路径）。
- 不采用 `artflow-plus` 的旧 Django 文件，因为 Plus 从 v1.0.0 切出；
  外部审核应看到线上 v1.0.2，而不是回退版本。
- 合并通过后删除 `artflow-plus` 远端与本地分支。

## 兼容层删除范围

### 运行时与领域

- `plus/packages/runtime/src/legacy-bundle.ts`
- `plus/packages/runtime/src/legacy-import-service.ts`
- `plus/packages/domain/src/adoption.ts`
- `plus/packages/runtime/src/participant-claim-service.ts`
- `plus/packages/runtime/src/participant-identity.ts` 中的 legacy link 查询
  （保留 `canActFor` 语义的轻量封装）
- `plus/packages/runtime/test/{legacy-import,legacy-adoption,participant-claim-service}.test.ts`
- `plus/packages/runtime/test/fixtures/legacy-bundle.json`

### 数据与结果来源

- `participant_claim`、`participant_identity_link` 两张表及其 repository、
  types；新增一条 drop migration。
- `publishing` 的 `legacy_import` 结果来源；`result-consumption` 中对应的
  跳过分支。
- 保留 migration 中 `'legacy'` 回填默认值与 voting `version: 1` artifact：
  它们是 v2 自己的旧 schema/回填，不是 v1 兼容。

### API / Web

- `import-legacy`、`seed-legacy` 脚本与 fixture 种子。
- `/api/public/participant-claims/consume`、
  `/api/activities/:id/registrations/:registrationId/account-claim`。
- Web `/claim` 路由、`api/participantClaim.ts`、Ops 报名表中的认领入口。
- `legacy-results` e2e 与种子改为正常发布来源。

### Django 与 golden

- `common/management/commands/export_plus_bundle.py`
- `common/test_plus_bundle.py`
- `tests/golden/v1_adapter.py`、`tests/golden/test_v1_fixtures.py`
- 保留 `tests/golden/*.json` 与 `validate_fixtures.py`；v2 runtime 继续消费。

### 文档 / 部署 / CI

- 删除 cutover、legacy-import 相关 runbook/plan/spec；历史 ADR 标记
  superseded，并新增 ADR-0036。
- README、GOAL、AGENTS、CLAUDE、development-baseline 改为 main 单线。
- `deploy/compose.production.yml` 移除 `ARTFLOW_PLUS_LEGACY_MEDIA_DIR` 与
  v1 媒体只读挂载；v1 部署栈暂留到删 Django 那轮。
- Gates 触发分支改为 `main`，删除 v1 golden adapter 步骤。

## 覆盖审计

更新 `docs/artflow-plus/skeleton-coverage.md` 为 2026-11-06 版本，列出
仍缺功能：舞台节目单公开页、bracket/对阵、XLSX/Word 导出、二维码、
现场大屏、SSO、多实例实时广播；v1 数据导入标记为有意放弃。

## 验证

- `pnpm -C plus run check`
- `REQUIRE_DB=1 pnpm -C plus run test`
- `pnpm -C plus run build:prod`
- `uv run pytest tests/gates -q`
- `uv run python tests/golden/validate_fixtures.py`
- `uv run python manage.py check`
- `pwsh -NoProfile -File scripts/check_docs.ps1`

## 非目标

- 本轮不删除 Django 1.x 源码。
- 本轮不补齐覆盖审计中的功能缺口。
- 本轮不重构 v1 部署栈为 Plus 单栈。
