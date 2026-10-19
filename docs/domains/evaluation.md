# Competition / Evaluation / Scoring / Podium（capability）

## 目的

把“评委对表演打分”变成可重放的权威事实，再由此产生轮次排名、晋级与最终
冠亚季军。所有计算必须是确定性的，且每个正式事实都有唯一身份。

## 实体与值

- `Round`：活动内的一轮；评分方式、最低有效评委数、晋级人数、来源名单。
- `PanelSnapshot`：某一轮某一刻的评委组名单；ACTIVE/HOLD/SUPERSEDED。
- `Seat` / `JudgeSession`：评委席位与一次终端会话；席位可被释放/换机。
- `Performance`：本轮的一次表演（个人或组合）；评分门 OPEN/LOCKED。
- `ScoreFact`：`(round, singer, judge)` 唯一；值、来源、命令回执、上下文版本。
- `Rubric`/`Criterion`：分项评分标准；发布后不可静默改。
- `Ranking`/`Advancement`：由 resolver 从事实计算；tie 必须有显式决策。
- `Podium`：最终名次/奖项候选；来源必须是 CONFIRMED 的 StageResult。

## 生命周期

Capability 级（Competition）：

```text
PREPARING → READY → RUNNING → CLOSED
```

- Evaluation 可以在一个 Competition 内有多个 execution sessions/rounds；每个
  session 绑定自己的 scope 与 mode。
- Activity 的粗生命周期不替代这里的 RUNNING/CLOSED；比赛可以在 Activity
  ACTIVE 期间多次准备、运行、关闭。

## 流程

```text
prepare round（名单+评委+分组快照）
  → open performance（context version）
  → judges/proxy submit score facts
  → lock performance
  → resolver 计算平均/排名/晋级
  → confirm stage result（绑定 candidate revision）
```

## 不变量

- **EVA-01** 一个评委对一名选手一轮只能有一条 score fact；修改是 edit，不是新增
  （SCOR-01）。
- **EVA-02** 分数绑定 panel snapshot、seat、performance、context version；任一
  不匹配即陈旧（SCOR-02/03）。
- **EVA-03** 一轮只有一个权威 panel snapshot；纠错不能混用历史名单（SCOR-04）。
- **EVA-04** 锁定/重开以 performance 为单位；`lock_round` 拒绝仍 OPEN 的门
  （SCOR-05）。
- **EVA-05** 同分只按显式 tie 规则处理；没有决策就 HOLD，不按名单序猜。
- **EVA-06** 计算必须可重放：输入事实 + 版本 → 相同输出；输入指纹被记录。

## 事件

`RoundPrepared`、`PanelSnapshotActivated`、`PerformanceAdvanced`、
`ScoreFactRecorded`、`ScoreFactRevised`、`PerformanceLocked`、
`RoundLocked`、`RankingComputed`、`AdvancementFinalized`、
`StageResultCandidateProduced`。

## v1 参考

- `singer_contest/services.py`（resolver、round、panel）
- `singer_contest/judge_authority.py`（score facts、reopen seam）
- `singer_contest/podium_services.py`
- 事故：`docs/incidents/duplicate-score-fact.md`

## Plus 要求

- Score fact 的唯一键由数据库约束 + command 双重保证。
- Resolver 是纯函数/纯服务，输入是显式快照；不得读“当前值”。
- 纠错是显式 saga（开门 → 改 → 锁 → 重算 → 重核），每步幂等。
- 评分读路径只能有一个 panel roster selector。

## 待决问题

- v2 是否需要支持多评委组并行（多轮同时评分）？若支持，panel/current 的选择
  规则必须先定义，否则会重演“多个 panel 组”事故。
- 纸面评分是否需要独立的导入批次身份？v1 用来源编号+原因，已足够审计。
