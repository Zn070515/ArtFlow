# ADR-0036: main 单线承载 v2，删除 v1 兼容层

- **Status**: accepted
- **Date**: 2026-11-06
- **Supersedes**: ADR-0006, ADR-0021, ADR-0023, ADR-0031, ADR-0032, ADR-0033, ADR-0035

## 背景

ArtFlow 1.x（含线上 v1.0.2）已完成使命。仓库此前维护 `main`（1.x）与
`artflow-plus`（v2）两条时代线，并保留一整套 v1 → v2 的兼容桥：legacy bundle
导入、运营接管、参与者账号认领、v1 媒体只读桥、v1 golden adapter 与 cutover
拓扑。双线结构与兼容桥持续产生额外测试面与文档分歧，而 v1 不再接收新活动。

## 决策

1. `main` 成为唯一开发主线，承载 ArtFlow-Plus（v2）。`artflow-plus` 分支合并后删除。
2. 合并提交保留 v1.0.2 的 Django 文件（25 个修改、3 个新增、`deploy/Caddyfile`），
   让外部审核看到线上版本，而不是 Plus 切出时的 v1.0.0。
3. 删除全部 v1 兼容桥：
   - `legacy-bundle`、`legacy-import-service`、`domain/adoption`；
   - `participant-claim-service`、`participant_claim` /
     `participant_identity_link` 表与 repository；
   - `legacy-file:` 媒体桥与 `ARTFLOW_PLUS_LEGACY_MEDIA_DIR`；
   - `legacy_import` 结果来源；
   - Django `export_plus_bundle`、`tests/golden/v1_adapter.py`；
   - cutover / legacy-import 文档与 Web `/claim` 页面。
4. 保留 Django 源码本身，等待外部审核与
   [v1 → v2 覆盖审计](../../artflow-plus/skeleton-coverage.md) 关闭后删除。
5. 保留 migration 中的 `'legacy'` 回填默认值与 voting `version: 1` artifact。
   它们是 v2 自己的旧 schema/回填，不是 v1 兼容。

## 被替代的方案

- **直接让 `main` 采用 `artflow-plus` 的树**：会把 Django 回退到 v1.0.0，外部审核
  看到的不是线上版本。拒绝。
- **保留 legacy 导入以支持未来一次性数据迁移**：v1 的数据随源码归档，不再迁入 v2；
  保留桥接会让每一次 capability 变更都背上旧 schema。拒绝。
- **保留 `/claim` 供 v2 原生参与者使用**：认领只接受 `legacy-user:*` 身份，对 v2
  本地账号没有意义。拒绝。

## 后果

- 仓库只剩一个交付路径与一套 CI 门禁；Gates 在 `main` 上运行。
- 参与者改用 v2 本地账号；不再有跨代身份链接。
- 外部审核通过前，Django 源码仍是只读对照物；删除时需要同步清理
  `pyproject.toml`、`pyrightconfig.json`、Tailwind、Docker 与 Dependabot 条目。
