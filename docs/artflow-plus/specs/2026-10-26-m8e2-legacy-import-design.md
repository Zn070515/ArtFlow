# ArtFlow-Plus M8e-2：v1 导入与对账

状态：已确认（2026-10-26）
范围：v1 Django 导出 bundle、v2 单事务导入命令、对账报告、当前活动 + 一个历史
活动的验证、导入后的历史赛果公开页。
非目标：媒体字节迁移、v1 归档包迁移、分组/合唱阶段的 v2 表达、入口切换/回滚
（M8e-3）、三类活动验证（M8e-4）。

## 决策

- **两段式**：v1 `export_plus_bundle` 产出带版本号的 JSON bundle；v2
  `activity.legacy.import` 消费 bundle。Node 不直连 v1 数据库；bundle 可归档、
  可 dry-run、可作为测试 fixture。
- **导入事实，不翻译规则**：v2 release 的 competition artifact 从 v1 的轮次与
  rubric 构造；无法表示的结构（GroupStage/分组、复合分、bracket）只记录在
  `unsupported`，不猜测。历史结果直接导入 v1 已发布快照，不重算排名。
- **测试行跳过**：`is_test_data` / `is_test_mode` 的行不写入 v2；bundle 的
  `excluded` 记录每表跳过数，对账报告核对。
- **媒体只迁元数据**：创建 v2 `material` 行，`storage_key = legacy:<v1 id>`；
  不复制字节。后续媒体 gateway slice 可据此回填。
- **确定性 id**：所有导入行使用 `legacy-` 前缀加 v1 主键；重复导入由 bundle
  hash + command receipt 幂等，不产生第二份数据。
- **匿名票**：历史 ballot 统一 `identity_type=anonymous`，保留选项计数，不导入
  ticket/browser 身份或 IP。

## Bundle 格式 v1

```json
{
  "format": "artflow-plus-legacy-bundle",
  "version": 1,
  "exportedAt": "2026-10-26T00:00:00Z",
  "source": { "publicCode": "ABC123", "activityId": 123, "v1Version": "1.0.2" },
  "activity": { "publicCode", "title", "subtitle", "activityType", "phase", "createdAt" },
  "questionnaire": { "version": "legacy-v1", "questions": [ { "key", "label", "type", "required" } ] },
  "ruleset": { "present": true, "raw": { "...": "opaque" } },
  "rubric": { "criteria": [ { "key", "weight", "maximum", "minimum" } ], "tiePolicy": "review" },
  "rounds": [ { "legacyId", "key", "sequence", "judgeCount", "minimumJudges", "completion", "scoringMethod", "advanceCount", "state" } ],
  "registrations": [ { "legacyId", "participantKey", "status", "answers", "reviewNote", "reviewedBy", "createdAt", "liveStatus" } ],
  "roster": { "status": "final|unknown", "approvedCount", "finalizedAt" },
  "materials": [ { "legacyId", "registrationLegacyId", "questionKey", "originalName", "contentType", "byteLength", "status", "reviewNote", "createdAt" } ],
  "competition": { "panels": [], "seats": [], "performances": [], "scores": [], "rankings": [] },
  "voting": { "sessions": [], "ballots": [] },
  "results": { "stageResults": [], "releases": [] },
  "counts": { "registrations": 0, "approvedRegistrations": 0, "materials": 0,
              "rounds": 0, "scores": 0, "ballots": 0, "releases": 0 },
  "excluded": { "testRegistrations": 0, "testScores": 0, "testBallots": 0, "testMaterials": 0 },
  "unsupported": [ { "kind": "group_stage", "legacyId": 1, "reason": "v2 has no group-chorus capability" } ]
}
```

- `participantKey` 使用 `legacy-user:<v1 user id>`；姓名等 PII 只放在 `answers`，
  不进入 id。
- `scores[].criteria` 优先来自 v1 `CriterionScore`；缺失时用
  `{ "总分": <score> }`，并在 `unsupported` 记录 `criterion_breakdown_missing`。
- `releases[].snapshot` 原样携带 v1 `ResultRelease.result_snapshot`。

## v1 导出命令

`common/management/commands/export_plus_bundle.py`
（参数：`--activity <public_code>`、`--output <path>`）：

- 只读正式行：`SingerRegistration.is_test_data=False`、`ScoreRecord`、
  `VoteSession`/`VoteBallot`、`StageResult` 的 test 标记全部过滤；过滤计数写入
  `excluded`。
- 导出注册字段到 `answers`：姓名、学号、学院、班级、手机、微信、曲目、是否原创、
  自我介绍/备注。
- 导出手续：rounds、panel snapshots/members/seats、performances、score records、
  criterion scores、score summaries/rankings（如存在）。
- 导出票：vote sessions、options、ballots（只保留 option ids 与时间）。
- 导出结果：confirmed StageResult 的 decisions/awards + 每个 active/superseded
  ResultRelease 的 snapshot 元数据。
- 不导出原始 token、密码摘要、ticket digest、IP、session key；bundle 中不允许
  出现上述字段（测试锁定）。
- 任何无法表示的结构（GroupStage、RulesetVersion 的复杂 stage）写入
  `unsupported`，不影响其余导出。

## v2 导入命令

`plus/packages/runtime/src/legacy-import-service.ts` 提供
`importLegacyBundle(db, deps, { commandId, bundle, dryRun })`；CLI
`plus/apps/api/scripts/import-legacy.ts` 读取 JSON 并调用。

- 单事务；command type `activity.legacy.import`，payload 含 bundle hash 与
  activity public code；同一 bundle 重复执行 replay，不重复写行。
- 目标 activity id = `legacy-act-<publicCode>`；public code 保留 v1 值。
- 构造 release v1：
  - `questionnaire` artifact：`{ schemaVersion:1, version, schemaHash, questions, fileSlots }`；
  - `competition` artifact：rounds（key/sequence/judgeCount/minimumJudges/
    completion/advanceCount/scoringMethod）、rubric（来自 v1 criteria；缺失时单一
    `总分`）、tiePolicy `review`；
  - `registration`/`materials` artifact：最小合法形状；
  - `capabilityVersions` 与 registry 的 "1" 对齐。
- activity 状态：有已发布结果 → `closed`；否则 `active`。
- 注册：状态原样映射 `draft/submitted/need_supplement/approved/rejected/withdrawn`。
  roster 只在 bundle 声明 final 时写入 final，且 `approvedCount` 必须等于导入的
  approved 注册数；不一致直接 `LEGACY_RECONCILIATION_FAILED`，避免之后
  `openPerformance` 的名单守卫失效。
- 材料：metadata-only，`storage_key=legacy:<legacyId>`。
- 比赛：rounds/panels/seats/performances（locked, contextVersion 1）/score facts
  （mode=formal, current=true, source 映射：direct_judge/staff_proxy/paper_dr/
  staff_rapid）/rankings（来自 bundle；缺失则用导入事实计算一次）。
  v1 缺少 panel/seat/performance 行时，导入器按 round+judge 合成 current panel、
  assigned seat 与 locked performance（sequence 取 RoundEntry 顺序或注册顺序），
  并在报告中标记 `synthesized`。
- 投票：vote_session（status closed, mode formal）+ options + 匿名 ballots。
- 结果：stage_result（confirmed）+ result_publication + result_release（active），
  snapshot 原样写入；`input_fingerprint` 使用 bundle hash 的稳定派生。
- 写一条 `LegacyBundleImported` 事件，payload 带 counts、bundle hash、public code。
- 对账：写入后按 v2 查询重算每实体行数、approved 名单、按轮/评委的分数计数、
  票数与选项计数、发布快照 hash；与 bundle 声明比较。任何 mismatch 抛
  `LEGACY_RECONCILIATION_FAILED` 并回滚。`dryRun` 不写库：校验 bundle 形状与
  引用完整性，返回 planned counts 与 declared-vs-planned 检查，不执行 v2 侧对账。
- 已存在同 public code 的 activity → `LEGACY_ACTIVITY_EXISTS`，无副作用。

## 报告

`LegacyImportReport`：

```json
{
  "publicCode": "ABC123",
  "activityId": "legacy-act-ABC123",
  "bundleHash": "sha256",
  "imported": { "registrations": 15, "approvedRegistrations": 15, "materials": 3,
                "rounds": 2, "scores": 120, "ballots": 300, "releases": 1 },
  "excluded": { "testRegistrations": 4, "testScores": 12, "testBallots": 0, "testMaterials": 0 },
  "unsupported": [ { "kind": "group_stage", "reason": "..." } ],
  "checks": [ { "name": "scores.byRound", "ok": true }, { "name": "releases.snapshotHash", "ok": true } ]
}
```

CLI 输出 JSON；`--report <path>` 写文件。

## 测试与验收

- Django exporter 测试：构造含正式/测试行、分数、票、已发布结果的活动；断言
  counts、excluded、无 token/IP/密码字段、unsupported 记录。
- v2 导入测试：golden bundle → 空 schema 导入；断言注册/名单/材料/分数/票/结果
  与公开页；对账报告全 ok；tampered bundle → `LEGACY_RECONCILIATION_FAILED` 且
  零残留；重复导入 replay。
- API/E2E：导入的历史活动 `/results/<publicCode>` 显示 v1 快照。
- 全量 gate + CI。

## 边界

- 分组/合唱阶段、复合分、bracket 不在 v2 表达，记录在 `unsupported`。
- 不导入测试行、媒体字节、原始凭证/身份。
- 周赛/混合赛制若无法构造 competition artifact，导入该活动时 fail closed 并给出
  明确报告，不写入半成品。
- 入口切换、回滚、三活动验证属于 M8e-3/4。
