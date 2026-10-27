# 三类活动验证报告（M8e-4）

日期：2026-10-26
证据：`plus/packages/domain/test/registry-packs.test.ts`（pack 编译）+
`plus/apps/api/test/activity-shapes.test.ts`（三条关键旅程）。

## 结论

三个结构不同的活动都由同一套 Activity / Capability 内核承载，差异全部落在
**capability 组合 + 默认 definition**，没有为任何一个形状复制内核代码。

| 形状 | Pack | 能力组合 | 关键旅程 |
| --- | --- | --- | --- |
| 现场歌手赛 | `singer-competition` | competition, registration, questionnaire, materials, publishing, archive | 创建/发布 → 报名/审核/名单 → judging session → prepare → panel → 开表演 → 2 位评委录分 → 锁表演/锁轮 → resolve → ranking |
| 毕晚/节目征集 | `stage-show` | registration, questionnaire, materials, archive | 创建/发布 → 报名 + 问卷 + 作品 metadata → 审核 → 名单 final → close → archive；无 competition/publishing 行 |
| 作品评审赛 | `review-awards` | competition, publishing, archive, registration, questionnaire, materials | 创建/发布 → 报名/名单 → judging session → review 轮 → panel → 作品作为 performance → 录分 → 锁/排名 → publishing session → podium → confirm → release → 公开赛果 |

## 只靠配置就能成立的差异

- **现场表演 vs 作品提交**：两者都是 “round + panel + performance + score fact”；
  作品赛只是把“表演”当作一次作品评审，不需要新表。
- **有无观众投票**：`voting` 是独立 capability，可加在任何 pack 上；票场自带
  mode 与身份策略，不改变比赛形状。
- **有无发布**：`publishing` 依赖 `competition`；舞台类活动不启用 publishing，
  归档只走 registration/materials/archive。
- **评委人数/最低有效数**：round definition 的 judgeCount/minimumJudges 决定
  panel 与 gate，不改内核。

## Pack 默认 definition

`ActivityPack` 现在可以携带 `definitions`，覆盖 capability 的
`emptyDefinition()`。没有默认 round/rubric 的 competition 无法真正开赛，因此：

- singer pack 提供 1 个 final 轮（3 评委 / 最低 2 / average）与三项 rubric；
- review-awards 提供 1 个 review 轮与主题/完成度/表现力 rubric；
- stage-show 提供节目问卷与作品文件槽位。

Guided 创建因此产出可直接编译、发布、运行的 activity；Expert 仍可替换任意
definition。

## 明确缺口（不在本轮伪造）

| 缺口 | 影响 | 后续 |
| --- | --- | --- |
| 舞台类没有“节目单/公开节目页”输出 | 观众看不到节目安排；只有报名/材料/归档 | 新 capability 或扩展 publishing 的非比赛 stage |
| 纯观众投票活动没有发布路径 | publishing 依赖 competition，投票 tally 不能直接公开 | 已解耦并新增投票赛果确认与 Ops 投票卡片（M10/M11）；Live 控制台仍用 SSE |
| bracket / 对阵 / 复合分 | v2 competition 只能表达 round/panel/score | 新 capability，不塞进 competition |
| podium 首次 recompute 需要预先算出 fingerprint | 没有发布 UI；自动旅程通过 `buildPodiumCandidate` 先算 fingerprint 再调用 | 发布/确认 UI 或让 recompute 返回当前 fingerprint |
| 参与者账号迁移/认领 | 导入的 legacy 报名没有登录账号 | 独立 slice（认领链接或账号迁移） |
| 分组/合唱阶段 | v1 的 GroupStage 无 v2 表达 | 已由 `grouping` capability 承载（M9）；组材料文件仍归媒体 slice |

## 复现

```powershell
$env:ARTFLOW_PLUS_DATABASE_URL = "postgresql://artflow:artflow_dev@127.0.0.1:5433/artflow_plus"
pnpm -C plus --filter @artflow-plus/domain test
pnpm -C plus --filter @artflow-plus/api exec vitest run test/activity-shapes.test.ts
```
| 参与者投票页缺失 | v2 只有 ballot 写接口，观众没有投票入口 | 已由 M12 的 `/vote/<sessionId>` 关闭；票据投票仍待后续 slice |
