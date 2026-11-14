# ArtFlow-Plus v2 已完成里程碑归档

这里保存 v2（M0–M15.5）已完成工作的过程性文档：实施计划、设计记录、审计、评审，
以及 skill 运行产生的计划与设计稿。归档的目的是让 `docs/artflow-plus/` 只保留
**仍在生效的运行、架构与工程规则**，同时不丢失历史推理与验证证据。

## 归档范围

| 目录 | 内容 | 文件数 |
| --- | --- | --- |
| [`plans/`](plans/) | 里程碑实施计划：步骤、命令、验证记录 | 21 |
| [`specs/`](specs/) | 已完成里程碑的设计记录 | 26 |
| [`analysis/`](analysis/) | 一次性审计、加固分析与缺口调查 | 9 |
| [`reviews/`](reviews/) | 代码与测试体系的评审记录 | 3 |
| [`superpowers/plans/`](superpowers/plans/) · [`superpowers/specs/`](superpowers/specs/) | skill 运行产生的计划与设计稿 | 69 |

## 使用规则

1. **归档是历史证据，不是现行规格。** 与当前实现冲突时，以代码、[ADR](../../architecture/adr/README.md)、
   [领域不变量](../../invariants/README.md) 和 [roadmap](../../artflow-plus/roadmap.md) 为准。
2. **文件不再改写。** 修正当前行为时更新现行文档与测试，不回填归档。
3. **新文档不写在这里。** 新的 spec 与 plan 仍写到 `docs/artflow-plus/specs/` 与
   `docs/artflow-plus/plans/`；里程碑完成后再整体归档。
4. **移动归档文件必须同步修链接。** `scripts/check_docs.ps1` 覆盖本目录，链接失效会阻塞门禁。

## 检索入口

- 里程碑出口与证据：[roadmap.md](../../artflow-plus/roadmap.md)
- 架构决策：[docs/architecture/adr](../../architecture/adr/README.md)
- 当前契约测试与测试体系设计仍留在
  [`docs/artflow-plus/specs/`](../../artflow-plus/specs/)。
- 文件名以 `日期-里程碑` 命名，可直接按日期或里程碑检索。
