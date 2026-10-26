# Archive / Retention / Export（capability）

## 目的

把一次活动变成**脱离数据库也能解释**的永久记录；同时定义数据保留、清理与
隐私边界。归档不是“打包当前表”，而是“导出当时的权威事实”。

## 实体与值

- `ArchivePackage`：活动归档包；版本、生成时间、操作者、校验摘要。
- `ArchiveArtifact`：包内文件（workbook、PDF、CSV、媒体清单）。
- `RetentionPolicy`：保留期限与清理动作（PII、上传、审计、票据）。
- `ExportTask` / `GeneratedDocument`：临时导出与生成文档；有各自权限。

## 生命周期

Capability 级：

```text
DRAFT → PACKAGING → SEALED
```

- PACKAGING 可以重试/继续；SEALED 后包不可变。
- Activity 的 ARCHIVED 是粗生命周期，不替代归档包的打包状态。

## 规则

- **ARC-01** 归档只能从终态（结果为已发布/已归档）产生；归档命令与阶段迁移
  分离（LIFE-05）。
- **ARC-02** 归档内容自包含：release 身份、标题、candidate、决策、奖项、
  状态历史；不依赖当前 activity/post 字段（RES-07）。
- **ARC-03** 不导出完整 input fingerprint、authority hash、token、学生隐私；
  导出字段是白名单。
- **ARC-04** 文件清单从数据库引用的每个文件字段推导，恢复演练证明存在/可读/
  哈希一致（DEPL-06）。
- **ARC-05** 解归档是独立 authority；不能通过普通阶段迁移伪造（LIFE-05）。
- **ARC-06** 保留清理只删除可证明过期的数据；测试数据清理与正式数据清理分开
  （AUTH-05/06）。

## 事件

`ArchivePackaged`、`ActivityArchived`、`ActivityUnarchived`、
`RetentionJobRan`、`ExportGenerated`。

## v1 参考

- `archive/models.py`、`archive/services.py`
- `exports/services.py`（archive/execution workbooks）
- `common/management/commands/backup_artflow.py`
- 事故：`docs/incidents/stale-static-assets.md`（部署产物一致性，与归档无关但
  同属“导出必须自证”的家族）

## Plus 要求

- 归档是命令 + 不可变包；包内有一份 schema manifest。
- 文件字段清单由 schema 派生，测试保证没有漏项。
- 归档与在线读模型使用同一 snapshot；不重新计算历史。
- 清理任务有 dry-run、审计与可重放语义。

## 待决问题

- 归档包格式：ZIP + XLSX 继续，还是 JSON/Parquet + 人读报告？建议保留 XLSX
  以便非技术人员查看，同时提供机器可读 JSON。
- 媒体是否进包？v1 只记录路径与清单，不复制大文件；v2 需要明确“包是否自包含
  字节”的边界。

## Plus 实现状态（M7b，2026-10-26）

- `archive` capability 拥有 `archive_package`、archive/unarchive 命令与受控下载；
  包为本地卷 ZIP（JSON + CSV + README），版本不可变，SHA-256 校验。
- 归档闭环：closed、无 running session、轮次 locked、无未完成 correction、票场
  closed、启用 publishing 时至少一条 ACTIVE release。
- ARCHIVED 为终态；unarchive 是独立命令，保留包文件与历史。归档后 rename 返回
  `ACTIVITY_ARCHIVED`。
- 已知缺口：registration/material/vote/score 事实表没有 mode 列，因此不进入包；
  等后续 hardening 再扩展归档内容。媒体字节仍不复制。
- DEPL-06 的恢复演练留给部署 slice；下载只验证当前包的存在/可读/哈希一致。
