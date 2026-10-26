# ArtFlow-Plus M7b：Archive 设计

状态：已确认（2026-10-26）
范围：`archive` capability、活动关闭/改名、归档与解归档、本地卷 ZIP 包、
受控下载、`archive-identity` golden 适配。
非目标：保留清理/PII purge、XLSX 生成、媒体字节复制、M8 部署编排。

## 已确认的决策

| 决策 | 结论 |
| --- | --- |
| 范围 | 核心归档 + 独立解归档；保留清理与 PII purge 留给后续 slice |
| 包格式 | 本地卷 ZIP，内含 JSON + CSV + README；不生成 XLSX |
| 正式性边界 | 先修 publishing 为 formal-only；归档只收 publishing 正式事实 + activity/formal session/event 摘要 |
| 归档闭环 | 严格 fail-closed：closed、无 running session、轮次 locked、无未完成 correction、票场 closed、至少一条 ACTIVE release |
| 权限 | `archive.manage` 用于 archive/unarchive/state/download；close/rename 沿用现有 bearer 生命周期权限 |

## 0. M7a 前置修复

- `lockPublishingActivity` 要求 `session.mode === "formal"`；所有 publishing 写命令
  拒绝 test/rehearsal，返回 `FORMAL_MODE_REQUIRED`。
- `StoredResultRelease.snapshot` 改为 `ResultSnapshot | null`，表达 legacy 行。
- `selectPublicResults` 只返回有 snapshot 的 ACTIVE release；没有 snapshot 的 ACTIVE
  行保持不可见，不伪造（RESULT-06）。
- 更新 M7a golden 测试与 selector 测试，证明 legacy ACTIVE 行不会出现在公开出口。

## 1. 领域与生命周期

新增 `archive` capability：

- identity `archive`，version `1`，dependencies `[]`，scopes `[]`；
- permissions `["archive.manage"]`；surfaces `["studio", "ops"]`；
- commands：`archive.activity.archive`、`archive.activity.unarchive`、
  `archive.package.read`；
- queries：`archive.state.read`；
- events：`ArchivePackaged`、`ActivityArchived`、`ActivityUnarchived`；
- definition artifact：`{ version: 1, schemaVersion: 1, format: "zip-json-csv" }`；
  compiler 拒绝其他 format；
- 注册进 `defaults.ts`；Singer Pack 的默认组合第一次完整可用，必须同步更新
  `/api/capabilities` 与 pack 精确列表测试。

Engine 补齐缺失的生命周期命令：

- `activity.close`：active → closed；要求没有 running session；事件 `ActivityClosed`。
- `activity.rename`：draft/active/closed 可改名；archived 返回 `ACTIVITY_ARCHIVED`；
  OCC revision；事件 `ActivityRenamed`。
- `activity.unarchive`（archive capability）：archived → closed；把当前包标为非
  current；事件 `ActivityUnarchived`。

`ARCHIVED` 仍是终态；除 unarchive 外，任何写命令在 archived 上必须拒绝。
archive 命令不要求 running execution session，但要求 `archive` capability 已启用。

## 2. 归档闭环

archive 命令在 Activity 锁内依次检查：

1. activity.status 必须是 `closed`；
2. `listRunningSessions(activityId)` 为空；
3. 启用 `publishing` → 至少一条 ACTIVE release（`ARCHIVE_RESULT_NOT_RELEASED`）；
4. 启用 `competition` → 所有 `competition_round.state === "locked"`
   （`ARCHIVE_ROUND_NOT_LOCKED`），且没有 state 为 `open/revised/closed` 的
   score correction（`ARCHIVE_CORRECTION_OPEN`）；
5. 启用 `voting` → 所有 vote session 为 `closed`（`ARCHIVE_VOTE_SESSION_OPEN`）。

任一失败都不写包、不改状态。

## 3. 包内容

ZIP 条目（UTF-8；CSV 带 BOM）：

- `manifest.json`：schemaVersion、packageId、activityId、version、sealedAt、
  sealedBy、format、artifacts（name/mediaType/size/sha256）、excludedFields、counts；
- `activity.json`：id、publicCode、title、status、enabledCapabilities、
  activeDefinitionVersion、archivedAt、archivedBy；
- `releases.json`：所有 release 的白名单字段（releaseId、stageKey、status、
  snapshotCandidateRevision、releasedAt、revokedAt、supersededAt、snapshot）；
  legacy 的 snapshot 为 `null`；
- `stage-results.json`：stageKey、status、candidateRevision、sourceCandidateRevision、
  decisions、awards、confirmedAt、unlockedAt；
- `sessions.json`：formal execution session 的 id/definitionVersion/scope/mode/status/
  openedAt/closedAt（不含 contentHash）；
- `results.csv`：stage_key、release_status、released_at、rank、contestant_id、score；
- `awards.csv`：stage_key、release_status、award、contestant_id；
- `events-summary.csv`：occurred_at、type、capability、aggregate_type、aggregate_id、
  actor_id、mode、scope（不导出 payload）；
- `README.txt`：包说明与排除项。

白名单之外不导出：`input_fingerprint`、authority hash、token、questionnaire answers、
ballot identity、文件存储路径、staff notes、registration/material/vote 明细
（这些事实表还没有 mode 列，等后续 hardening）。

## 4. 存储与补偿

- `ArchiveStorage` 接口：`put(key, bytes)`、`read(key)`、`remove(key)`；
  本地卷实现从 `ARTFLOW_PLUS_ARCHIVE_DIR` 读根目录，key 为
  `{activityId}/v{version}.zip`。
- key 只允许 `[a-z0-9_-]` 段；resolve 后必须仍在根目录内。
- `put` 写临时文件 → fsync → 删除旧同名文件 → rename；返回 size 与 SHA-256。
- 归档命令在 DB 事务内写文件；命令失败或 commit 失败时删除已写文件（反向补偿）。
  进程在 rename 与 commit 之间崩溃可能留下孤儿文件；下次归档同版本会覆盖它。
- 下载前校验文件存在、size、SHA-256；不一致返回 `ARCHIVE_INTEGRITY_FAILED`，不发送字节。

## 5. 持久化

迁移 `0013_m7_archive`：

```text
archive_package
  id varchar(100) pk
  activity_id varchar(100) not null references activity(id) on delete restrict
  version integer not null
  key varchar(300) not null
  size_bytes integer not null
  sha256 varchar(64) not null
  manifest jsonb not null
  summary jsonb not null
  note text not null
  sealed_at timestamptz not null
  sealed_by varchar(100) not null
  is_current boolean not null default false
  created_at timestamptz not null default now()
  unique(activity_id, version)
  unique index one current per activity: (activity_id) where is_current
```

`summary` 含 `activityPhase`、`activityInfoTitle`、`releaseRows`
（release、snapshotAvailable、snapshotActivityTitle、snapshotPublicTitle）、
`excludedFields`。

新增 repository：

- `archive-repository.ts`：current/version/history 读取、插入、demote current；
- `competition-repository.ts`：`listRoundsForActivity`；
- `score-repository.ts`：`listUnsettledCorrectionsForActivity`；
- `voting-ticket-repository.ts`：`listVoteSessionsForActivity`；
- `publishing-repository.ts`：`listActiveResultReleases`。

## 6. 命令语义

### archive

输入：`expectedRevision`、`note`。锁 Activity → 检查 capability/闭环 → 取
max(version)+1 → 构建 ZIP → 写文件 → 插入 `archive_package`（is_current=true，
旧 current 置 false）→ activity.status=archived → 事件 `ArchivePackaged` +
`ActivityArchived`。返回 `{ package, summary }`。

### unarchive

输入：`expectedRevision`、`note`。锁 Activity → 必须 archived → 当前包
`is_current=false` → status=closed → 事件 `ActivityUnarchived`。文件保留。

### state / download

- state：`archive.manage`；返回 activity phase + 包历史（不含 key/绝对路径）。
- download：`archive.manage`；默认 current，可指定 `?version=`；校验
  size/SHA-256 后返回 ZIP；`content-type: application/zip`、
  `content-disposition: attachment`、`cache-control: no-store`。

## 7. API

| 方法 | 路径 | 权限 |
| --- | --- | --- |
| POST | `/api/activities/:id/close` | 已认证 |
| PATCH | `/api/activities/:id/title` | 已认证 |
| POST | `/api/activities/:id/archive` | `archive.manage` |
| POST | `/api/activities/:id/unarchive` | `archive.manage` |
| GET | `/api/activities/:id/archive` | `archive.manage` |
| GET | `/api/activities/:id/archive/file?version=` | `archive.manage` |

写命令带 `Idempotency-Key`；archive/unarchive 带 `expectedRevision` + `note`。

## 8. 错误码

新增：`ACTIVITY_ARCHIVED`、`FORMAL_MODE_REQUIRED`、`ARCHIVE_RESULT_NOT_RELEASED`、
`ARCHIVE_ROUND_NOT_LOCKED`、`ARCHIVE_CORRECTION_OPEN`、
`ARCHIVE_VOTE_SESSION_OPEN`、`ARCHIVE_INTEGRITY_FAILED`、`ARCHIVE_NOT_FOUND`。

## 9. 测试

- domain：archive compiler、rename/close/unarchive 状态机、错误码；
- db：0013 up/down、archive repository、闭环查询、legacy ACTIVE release 不出现在 selector；
- storage：原子写、路径穿越、read/remove、digest；
- package：ZIP 条目、CSV 转义/BOM、manifest 哈希、legacy null snapshot、白名单；
- runtime：close/rename、五种闭环失败、归档成功（文件+DB+事件+审计）、
  下载完整性失败、unarchive/demote、重归档 v2、双连接并发归档；
- API：close/rename/archive/unarchive/state/download、401/403/409、ZIP 头；
- golden：`archive-identity` 三步（rename → archive → 归档后修改被拒）。

## 10. 文档与部署

- ADR-0015：包格式、本地卷补偿、正式性边界、归档闭环；
- roadmap M7b 完成；README 命令/路由/`ARTFLOW_PLUS_ARCHIVE_DIR`；
- `docs/domains/archive.md` 标注 Plus 实现状态与 mode 缺口；
- `.env.example` 增加 archive dir；`.gitignore`/`.dockerignore` 排除本地归档；
- M8 部署必须把 archive dir 挂成持久卷，并在备份清单中包含它。

## 风险与开放项

- registration/material/vote/score 事实表没有 mode 列；M7b 不把它们放进包。
  这是已知缺口，后续 hardening 或 M8 cutover 前必须解决。
- 归档文件不在 PostgreSQL 事务内；依赖反向补偿与下载时校验。DEPL-06 的恢复演练
  仍未实现，留给部署 slice。
- publish formal-only 会拒绝 test/rehearsal publishing；M7a 的测试与文档需同步。
