# Results / Publishing / Correction（capability）

## 目的

把内部计算出的结果变成公众事实。发布前，结果只是候选；发布后，公众看到的
一切来自冻结的 snapshot；修改必须走新的 candidate → 重新核定 → 新 release。

## 实体与值

- `StageResult`：某赛段的候选/已核定结果；candidate revision、输入指纹、
  决策与奖项候选。
- `StageDecision` / `AwardDecision`：候选人级结果。
- `ResultRelease`：post + stage 的 ACTIVE/SUPERSEDED/REVOKED 记录；冻结
  snapshot（身份、标题、decisions、awards）。
- `PublicPost`：编辑性容器；正式结果发布后不再提供正文/封面/媒体作为事实。
- `CorrectionSeam`：解锁 → 修改 → 重新锁定 → 重算 → 重新核定的窄路径。

## 生命周期

Publishing capability：

```text
PRIVATE → READY → RELEASED → REVOKED
```

Result 候选/核定是 Evaluation 的事实；Publishing 只负责把已核定的 release
snapshot 公开。两者不能互相替代：内部 CONFIRMED 不等于公众可见。

## 流程

```text
resolve → candidate (revision N)
  → confirm（绑定 candidate N + fingerprint）
  → release（冻结 snapshot；post 公开）
  → revoke / supersede（旧 URL 失效）
  → unlock（candidate N+1）→ correct → reconfirm → re-release
```

## 不变量

- **RESULT-01** 一个 CONFIRMED 结果只对应一个确定的输入快照（RES-01）。
- **RESULT-02** 公众事实只来自 release snapshot，不读编辑字段（RES-02）。
- **RESULT-03** 一个 post/一个 stage 最多一条 ACTIVE release；历史保留（RES-03）。
- **RESULT-04** 撤销/替代后所有出口立即失效（RES-04）。
- **RESULT-05** editorial 媒体不因 release 变为匿名可读（RES-05）。
- **RESULT-06** 缺 snapshot 的历史保持 legacy/空白，不伪造（RES-06）。
- **RESULT-07** 归档导出冻结身份，不导出完整 fingerprint/hash（RES-07）。
- **RESULT-08** 手卡/PDF/导出与在线结果共用同一 authority（RES-08）。

## 事件

`StageResultCandidateProduced`、`StageResultConfirmed`、
`StageResultUnlocked`、`ResultReleased`、`ResultReleaseRevoked`、
`ResultReleaseSuperseded`、`CorrectionOpened`、`CorrectionRelocked`。

## v1 参考

- `singer_contest/services.py`（confirm/unlock）
- `public_portal/models.py`（PublicPost/ResultRelease）
- `public_portal/services.py`（release/revoke/snapshot/selector）
- 事故：`docs/incidents/revoked-result-media.md`、
  `docs/incidents/archive-public-title-identity.md`

## Plus 要求

- snapshot 是 release 命令的产物，不可变；历史读模型只读它。
- 公开结果 selector 只有一个；所有出口复用。
- 媒体授权与结果状态解耦：子资产不因父对象可见而公开。
- 发布/撤销/解锁/纠错全部是显式命令，带 OCC 与审计。

## 待决问题

- 一个 stage 是否允许同时存在多个“当前发布”（多篇文章）？v1 是 stage 单
  ACTIVE；若 v2 要支持，需要先定义“哪个是正式入口”。
- 结果 PDF 是否需要与 snapshot 绑定的生成版本号？建议需要。

## Plus 实现状态（M7a，2026-10-26）

- `publishing` capability 同时拥有核定与发布；`StageResult`、`ResultPublication`、
  `ResultRelease` 在迁移 `0012_m7_publishing`。
- 公开 selector 唯一实现于 `selectPublicResults`；同一 stage 最多一条 ACTIVE release。
- `unlock` 在同一事务写 `StageResultUnlocked` + `ResultReleaseSuperseded`。
- 投票来源的赛果确认（M10）走 `publishing.vote_result.confirm`，与比赛来源共用
  同一个 release selector。
- 归档见 [`archive.md`](archive.md)（M7b，已完成）。
