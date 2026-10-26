# ArtFlow-Plus M8e-4：三类活动验证与现场彩排

状态：已确认（2026-10-26）
范围：三个 Guided Pack、默认 capability definitions、三类活动的自动关键旅程、
现场彩排 runbook、验证报告。
非目标：新的 capability、bracket/对阵、纯投票发布、节目单公开页、参与者账号迁移。

## 决策

- **三个形状**：
  1. `singer-competition`：现场表演 + 评委评分（现有 pack，补默认定理）。
  2. `stage-show`：节目征集/问卷/材料审核/名单定稿/归档；无 competition/publishing。
  3. `review-awards`：作品提交 + 评委组评审 + 结果发布（competition + publishing）。
- **Pack 携带默认 definitions**：`ActivityPack` 新增可选 `definitions`，覆盖
  capability 的 `emptyDefinition()`。没有默认 round/rubric 的 competition 无法真正
  开赛，Guided 创建必须给出可运行的默认值。
- **Stage show 交付边界**：只验证征集/审核/归档；没有“节目单/公开节目页”输出，
  记录为后续 capability，不在本轮伪造。
- **纯投票活动**：publishing 依赖 competition，纯投票结果没有发布路径；本轮不选
  它作为第三形状，报告里记录该缺口。
- **验收形式**：每个 pack 的 domain 编译测试 + 每个形状一条 runtime/API 关键旅程
  + `docs/artflow-plus/shape-validation.md` 报告；现场彩排另写 runbook。

## Pack 定义

```text
singer-competition (baseline: competition)
  definitions.competition: roster → final(round) → result,
    round final: judgeCount 3 / minimum 2 / average / advance 1,
    rubric 演唱技巧/舞台表现/情感表达 (weight 1, max 100)
  definitions.questionnaire: 姓名/学号/曲目/自我介绍
  definitions.materials: 25MB, audio
  questions: registration/questionnaire/materials/voting/publishing/archive

stage-show (baseline: registration, questionnaire, materials, archive)
  definitions.questionnaire: 姓名/节目名称/节目介绍/work_file (file)
  definitions.materials: 100MB, video/image/document
  questions: audience-voting (voting, default false)

review-awards (baseline: competition, publishing, archive)
  definitions.competition: roster → review(round) → result,
    round review: judgeCount 3 / minimum 2 / minimum_valid / average / advance 1,
    rubric 主题/完成度/表现力
  definitions.questionnaire: 作品名称/作品说明/work_file (file)
  definitions.materials: 100MB, video/image/document
  questions: registration/questionnaire/materials (default true), audience-voting (false)
```

所有调用 `emptyDefinition()` 的编译校验（schemaVersion/payload version）继续生效；
pack 提供的 definition 仍走同一 compiler。

## 自动验证

- Domain：三个 pack 都能 instantiate + compile；stage-show 不含
  competition/publishing；singer/review-awards 的 competition artifact 至少一个
  round 且有 rubric；自定义 definition 覆盖 emptyDefinition。
- Runtime/API 关键旅程：
  - singer：创建/激活/编译/发布 → judging session → prepare round → panel →
    open performance → staff_rapid score → lock → resolve → ranking。
  - stage-show：创建/激活/发布 → 参与者报名 + 问卷 + 材料 metadata → staff 审核 →
    名单 final → archive 成功；无 competition/publishing。
  - review-awards：创建/激活/发布 → 报名/名单 → judging session → review round →
    panel → submission performance → score → lock → resolve → publishing session →
    confirm → release → `selectPublicResults` 返回快照。
- 反例：stage-show 不能 prepare competition round；review-awards 的 public results
  在确认前为空。

## 现场彩排 Runbook

`docs/artflow-plus/rehearsal-runbook.md`：

- 彩排前：cutover 演练通过；staff 账号/评委链接/备用录分；公开码与二维码。
- 开演：启动 judging session、prepare/panel/open；评委连接检查。
- 演出中：评分进度、HOLD/同分、断网退化为轮询/纸面录分。
- 收尾：锁表演/锁轮、resolve、确认/发布、归档。
- 异常：撤销/纠错、会话关闭、回滚边界。
- 彩排记录表：每个检查点的负责人、时间、结果。

## 验证报告

`docs/artflow-plus/shape-validation.md`：三个形状的能力组合、关键旅程、只靠配置
即可的差异、需要新 capability 的缺口（节目单、纯投票发布、bracket、参与者账号）。

## ADR

ADR-0024：Pack 可携带默认 capability definitions；三类形状的边界与缺口。

## 测试与验收

- domain pack 测试 + 三个形状的关键旅程测试。
- 现有 308 tests + E2E 保持通过。
- `pnpm -C plus run check/build:prod`、全量 tests、E2E、`check_docs.ps1`、CI 全绿。
