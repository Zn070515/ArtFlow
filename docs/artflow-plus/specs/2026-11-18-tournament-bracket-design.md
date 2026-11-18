# Tournament：对阵、复合分与 Teams 设计

状态：已接受（2026-11-18）；Slice 1（Teams）已实现

## 1. 目标

补齐 v2 仍开放的赛制缺口：

- **Teams**：把「参赛单位」从自然人扩展到队伍，并冻结队员名单；
- **对阵（head-to-head）**：单败淘汰 bracket，以及 2026 校园十佳使用的
  「初始席位 + 挑战者」赛制；
- **复合分**：用已确认的正式轮次成绩按冻结权重合成结果，覆盖挑战胜负与
  冠亚季军；
- **Tournament Pack**：把上述能力与 competition/grouping/publishing 组合成
  可直接复用的赛制模板。

本设计只定义语义、生命周期和权威边界。实现切片见
[2026-11-18-tournament-bracket-plan.md](../plans/2026-11-18-tournament-bracket-plan.md)。

## 2. 非目标

- 双败淘汰、循环赛、瑞士制、小组积分赛；
- best-of-N 多局赛；
- 自动破平、加赛、评委临时投票、隐藏 ID 排序；
- 观众投票直接决定对阵胜负；
- 跨活动共享队伍或跨活动对阵；
- 实时大屏的逐秒比分推送（沿用现有失效提示 + HTTP 恢复）。

## 3. 术语与权威边界

| 概念 | 权威 | 说明 |
| --- | --- | --- |
| 参赛者（participant） | `registration` | 已通过审核的自然人 |
| 队伍（team） | `teams`（新） | 活动内唯一 key + 冻结名单 |
| 轮次成绩 | `competition` | lock + score fact + ranking snapshot |
| 对阵结构 | `tournament`（新） | bracket/side/match/seat |
| 比赛胜负 | `tournament` | 只消费已锁定成绩，不重算原始分 |
| 复合分 | `tournament` | 只消费已确认的两位小数正式成绩 |
| 公开结果 | `publishing` | tournament 产出候选，publishing 确认发布 |

边界规则：

- `tournament` 不修改 `competition` 的轮次、评委、评分事实或排名；
- `competition` 不知道 bracket 内部评分单元的存在；
- `teams` 不改变报名审核结论，只选择哪些已通过参与者组成队伍；
- 观众投票（`voting`）与 `evaluation` 不进入正式胜负或复合分。

## 4. Teams capability

### 4.1 定义（随 release 冻结）

```ts
interface TeamsDefinition {
  schemaVersion: 1;
  minSize: number;          // 默认 1
  maxSize: number;          // 默认 8
  requireCaptain: boolean;  // 默认 false
  source: "manual" | "grouping";
}
```

- `manual`：在 Ops/Studio 手工建队；
- `grouping`：从已冻结的 grouping stage 导入，组名成为队名，组员成为队员；
  grouping 修正后必须重新导入或手工修正，才能进入 bracket lock。
- compiler 校验：`1 <= minSize <= maxSize <= 64`；`source` 取值合法；
  `source: "grouping"` 要求 composition 中存在 `grouping` capability
  （在 release 冻结期校验，不在单 capability compiler 内跨能力读取）。

### 4.2 运行时模型

`tournament_team`：

- `id`, `activity_id`, `team_key`（`[a-z0-9-]{1,40}`，活动内唯一）
- `name`（1–80，活动内唯一）
- `status`: `draft` | `frozen` | `withdrawn`
- `source`: `manual` | `grouping`
- `source_grouping_stage_id`, `source_revision`（可空）
- `revision`, `created_by`, `created_at`, `updated_at`
- `withdrawn_at`, `withdraw_reason`

`tournament_team_member`（append-only）：

- `team_id`, `participant_id`, `role`: `member` | `captain`
- `added_at`, `removed_at`（null 表示当前有效）
- 活动内 partial unique index：同一 `participant_id` 只能有一条有效记录。

### 4.3 生命周期

```text
draft ──roster.freeze──> frozen ──roster.correct──> frozen (revision+1)
  │                         │
  └────withdraw─────────────┴────withdraw────> withdrawn
```

- `teams.roster.freeze` 是**名册级**操作：一次校验全部 draft 队伍并整体冻结，
  输出 `rosterFingerprint`。任一队伍不满足 minSize/maxSize/唯一性则整体失败，
  不做部分冻结。
- `teams.roster.correct` 仅管理员，必须带原因，生成新的冻结 revision；若已有
  锁定 bracket 消费该 fingerprint，必须先 `tournament.bracket.reopen`。
- `teams.team.withdraw` 可在 draft 或 frozen 后执行，终态；bracket 将其视为
  弃权（见 7.4）。
- frozen 后不允许直接增删队员，只能走 roster correction；这是为了让 bracket
  的 side snapshot 永远可以追溯到唯一一次冻结。

### 4.4 不变量

- 队员必须是同活动、当前 `approved` 的参与者（读取 registration 当前名单与
  revision）。
- 一个参与者在一个活动内最多属于一个有效队伍。
- `requireCaptain` 为真时，每队恰有一名 captain；否则 captain 可零或一。
- 队伍 key 与名称在活动内唯一；withdrawn 队伍不释放 key/名称。
- 冻结名册 fingerprint 纳入 bracket 的 `input_fingerprint`。

### 4.5 与 grouping 的关系

`source: "grouping"` 时：

- 只读取 `grouping.status === "frozen"` 的 stage；
- 导入结果记录源 stage id 与 revision；
- 不在 grouping 内部写 team，也不把 team 反向写回 grouping；
- 两边都保留自己的权威，bracket 只消费 teams 的冻结快照。

## 5. Tournament 定义

### 5.1 通用结构

```ts
type TournamentMode = "elimination" | "challenge";

interface CompositeComponent {
  roundKey: string;
  weightBasisPoints: number; // 整数，合计 10000
}

interface CompositeRule {
  components: readonly CompositeComponent[];
}

interface MatchScoring {
  method: "performance" | "composite";
  judgeCount?: number;
  minimumJudges?: number;
  completion?: "full_matrix" | "minimum_valid";
  composite?: CompositeRule;
}

interface TournamentDefinition {
  schemaVersion: 1;
  mode: TournamentMode;
  sides: "participant" | "team";
  scoring: MatchScoring;
  // elimination
  size?: number;                    // 2..64，2 的幂
  seeding?: "manual" | "advancement" | "registration";
  thirdPlace?: boolean;
  // challenge
  sourceRoundKey?: string;
  seats?: number;
  challengers?: number;
}
```

compiler 校验：

- `size` 为 2 的幂且 2–64；`seeding` 合法；
- `seats` 1–64，`challengers` 0–64；`seats + challengers <= 源轮次参与人数`
  （后者在 bracket create 时用真实排名校验）；
- `method: "performance"` 要求 `judgeCount >= 1`、
  `1 <= minimumJudges <= judgeCount`、`completion` 合法；
- `method: "composite"` 要求至少一个 component，每个权重为正整数，
  **合计恰为 10000**，roundKey 不重复且非空；
- `sides: "team"` 要求 composition 中存在 `teams` capability（release 冻结期
  校验）；
- `mode: "challenge"` 要求 `sourceRoundKey`、`seats`、`challengers` 均存在；
  `mode: "elimination"` 忽略 challenge 字段。

### 5.2 elimination

- 单败淘汰；`size` 是槽位数，实际参赛数 N 满足 `size/2 < N <= size`（避免
  首轮出现 bye 对 bye）。
- `seeding`：
  - `manual`：ops 按显式顺序提交 sideKey；
  - `advancement`：读取源轮次 finalize 后的 advancement 顺序；
  - `registration`：按 approved 名单的报名顺序。
- bye 分配给最高种子；首轮轮空的 side 在 bracket lock 时直接进入下一轮，
  生成 `method: "bye"` 的 decided match。
- `thirdPlace: true` 时增加一场季军赛，由两场半决赛的负者参加；季军赛不
  产生晋级，也不影响冠军路径。

### 5.3 challenge

对应 2026 校园十佳赛制：

- 源轮次必须已锁定且存在 finalize 的 advancement decision；
- 前 `seats` 名进入初始席位（按排名）；
- 接下来的 `challengers` 名进入挑战队列，**排名低者先挑战**（rank 从大到小）；
- 队列顺序在 bracket lock 时冻结，之后不可改写；
- 每个席位最多被挑战一次；挑战者在确认配对前可以 decline，不消耗席位机会；
- 挑战者先演出，守擂者后演出；两边的评分单元互相独立；
- 胜者继承守擂者的席位位置；挑战场比分不进入最终冠亚季军复合分
  （冠亚季军只用配置的轮次权重）。

### 5.4 bracket 状态

```text
draft ──lock──> locked ──first match opened/decided──> running ──final decided──> completed
  │                 │                                     │
  └──cancel─────────┴──cancel─────────────────────────────┴──> cancelled
```

- `draft`：可改 sides、seeding、大小；允许不完整。
- `lock`：校验 source roster、side 唯一性、seeding 完整、release fingerprint；
  写入 side snapshot、bye 结果和固定 match 树；之后结构不可变。
- `running`：任何一场比赛 open 或 decided 后进入。
- `completed`：决赛（及启用时的季军赛）decided 后进入。
- `cancelled`：管理员带原因；所有未 decided 的 match 置 `void`；已 confirmed
  的 tournament result 若消费该 bracket，需先撤销/标记 stale。
- completed 后若 reopen 任一场 match，bracket 自动回到 `running`。

## 6. 对阵模型

### 6.1 表

`tournament_bracket`：

- `id`, `activity_id`, `bracket_key`, `mode`（elimination/challenge）
- `release_version`, `status`, `revision`
- `input_fingerprint`（side snapshot + seeding + 规则）
- `definition_fingerprint`
- `created_by`, `created_at`, `locked_at`, `completed_at`

`tournament_side`：

- `id`, `bracket_id`, `side_key`
- `kind`: `participant` | `team`
- `ref_id`, `display_name`（冻结快照）
- `seed`, `source_round_id`, `source_rank`
- `status`: `active` | `withdrawn`
- `withdrawn_at`, `withdraw_reason`

`tournament_match`：

- `id`, `bracket_id`, `match_key`（活动/规则内唯一）
- `stage`: `r64…r2` | `final` | `third_place` | `challenge`
- `position`（同 stage 内固定序号）
- `side_a_id`, `side_b_id`（bye 时 side_b 为 null）
- `winner_side_id`, `status`, `method`
- `score_a`, `score_b`（两位小数字符串；decided 后不可变）
- `scoring_round_id`（内部 competition round，见 6.2）
- `next_match_id`, `next_slot`（`a` | `b`；决赛/季军赛为空）
- `revision`, `source_fingerprint`
- `opened_at`, `decided_at`, `decided_by`

`tournament_seat`（challenge）：

- `bracket_id`, `seat_no`, `initial_side_id`, `current_side_id`
- `challenged`（bool）、`final_position`

`tournament_challenger`（challenge）：

- `bracket_id`, `order_no`, `side_id`
- `status`: `queued` | `choosing` | `paired` | `declined` | `done`
- `match_id`

`tournament_result`：

- `id`, `activity_id`, `bracket_id`（可空，复合分也可独立）
- `kind`: `bracket_standing` | `composite`
- `status`: `ready` | `hold` | `confirmed`
- `rows`（JSON：名次、sideKey/contestantId、两位小数总分）
- `input_fingerprint`, `source_score_versions`, `rule_fingerprint`
- `revision`, `confirmed_by`, `confirmed_at`

### 6.2 内部评分单元的复用

比赛需要「两边各自被评委打分」，但不应把 15 场首轮塞进一个要求完整矩阵的
普通轮次。实现方式：

- 每场 performance 模式比赛创建一条 `competition_round` 行，`round_key` 使用
  保留前缀 `bracket.<bracketKey>.<matchKey>`，并带 `kind = "bracket"`；
- 该轮次复用现有 panel snapshot、performance、score fact、performance lock 和
  评分核心（Decimal、两位小数、drop_high_low）；
- `competition` 的轮次列表、prepare、ranking、advancement、podium 全部过滤
  `kind = "bracket"`，因此内部轮次不会出现在 Studio 轮次列表，也不会进入
  podium；
- 比赛 lock 不等同于普通 `competition.round.lock`：它只要求本场两侧
  performance 达到 `minimumJudges` 且 score gate locked；命令为
  `tournament.match.lock`；
- `score_fact` 的 `contestant_id` 使用 side id，读面通过 side 映射显示名称。

schema 迁移需要给 `competition_round` 增加 `kind`（默认 `standard`），并更新
现有轮次查询；这是本里程碑唯一一处对 competition 表的扩展，不改变其语义。

### 6.3 side 与 contestantId 的桥

- participant side：`contestant_id = participant_id`；
- team side：`contestant_id = "team:" + team_id`，并在 teams roster freeze 时
  固定；competition 轮次与 ranking 直接使用该字符串。
- bracket 只信任 side snapshot 中的 `display_name`，公开页面不回查报名或队伍
  当前状态，避免历史对阵因后续改名/退出而变化。

## 7. Match 生命周期

### 7.1 状态机

```text
pending ──(两侧就绪)──> ready ──open──> scoring ──lock──> awaiting_decision
   │                      │                                   │
   │                      └────────walkover───────────────────┤
   │                                                          ├──decide──> decided
   │                                                          └──decide_tie──> decided
   │
   └──(bye)──> decided(method=bye)

decided ──reopen──> awaiting_decision   (级联 void 下游)
任意未 decided ──bracket.cancel / rehearsal.reset──> void
```

### 7.2 转移表

| From | Command | To | 守卫 |
| --- | --- | --- | --- |
| pending | （系统派生） | ready | 两侧 side 均已解析且 active |
| pending | `tournament.match.walkover` | decided | 管理员，reason 非空 |
| ready | `tournament.match.open` | scoring | judging session running；两侧 active；performance 评分单元已准备 |
| scoring | `tournament.match.lock` | awaiting_decision | 两侧 score gate 均 locked 且达到最低有效评委数；无缺失成绩 |
| awaiting_decision | `tournament.match.decide` | decided | 两侧正式分不等；或带 tie 原因且显式选择胜者 |
| ready/awaiting_decision | `tournament.match.walkover` | decided | 管理员，reason 非空；对手 active |
| decided | `tournament.match.reopen` | awaiting_decision | 管理员，reason；未被 confirmed tournament result 消费；级联规则见第 9 节 |
| 任意未 decided | bracket cancel / rehearsal reset | void | 终态 |

规则：

- 每个命令携带 `expectedRevision`；冲突返回 `STALE_REVISION`。
- `decide` 的 `score_a/score_b` 必须来自同一次 lock 的正式结果，由服务端写入，
  不接受客户端传入分数。
- decided 后修改比分只能先 reopen，再走评分更正；不存在直接改分命令。
- `void` 只由 bracket 取消或 rehearsal reset 产生；`void` 的 match 不参与晋级，
  也不能再被 decide。

### 7.3 平局

- 正式分相等时 match 停在 `awaiting_decision`，返回 `MATCH_TIED`，并标记
  `tie = true`。
- 只有 `tournament.match.decide_tie` 可以决定胜者，必须带非空 `reason` 和
  `winnerSideId`；记录为 `method: "decision"`。
- 平局不得自动用报名号、ID、时间戳或随机数破平。
- 缺失成绩不是 0：任何一边未达到最低有效评委数时不能 lock，也就不能 decide。

### 7.4 弃权、退赛与 bye

- **bye**：bracket lock 时由轮空产生的 decided match，`method: "bye"`；不产生
  score，不进入评分。
- **walkover**：单场弃权/无法参赛，管理员带原因，直接判对手胜；`score_a/score_b`
  记录为 null，`method: "walkover"`。
- **side withdraw**：`tournament.side.withdraw` 标记 side 为 withdrawn：
  - 已 decided 的历史比赛保持原结果；
  - 该 side 当前未 decided 的比赛判对手 walkover；若对手也已 withdrawn，
    比赛置 `void`；
  - 该 side 已晋级进入的未来比赛，同样判对手 walkover；
  - 决赛中一方退赛时，另一方为冠军，`method: "walkover"`。
- 弃权不制造假的 0 分，也不把弃权者当作「输 0:0」。

### 7.5 修正与级联

`tournament.match.reopen` 的影响：

1. 检查该 match 未被 confirmed `tournament_result` 消费；
2. 找到 `next_match_id` 及其后续路径；
3. 若下游存在 decided match：
   - 默认拒绝，返回 `DOWNSTREAM_DECIDED`；
   - 命令显式带 `cascade: true` 时，从下游末端向前把所有受影响的 decided
     match 置回 `ready` 或 `pending`（取决于另一侧是否仍确定），清空
     winner/score/method，记录每条 void/rollback 的原因；
4. 当前 match 回到 `awaiting_decision`，保留已锁定的评分事实；若需要改分，
   再走 score correction；
5. 一次事务内完成，事件按从下游到上游的顺序写入。

上游轮次更正会改变 composite 输入：受影响的 tournament result 由
`markConsumedResultsStale` 标记 stale，publishing 结果 release 同步 supersede。

## 8. 复合分

### 8.1 计算规则

```text
composite(side) = Σ round(score_round_i(side), 2) × weight_i / 10000
最终结果 = decimalValue(composite, 2, ROUND_HALF_UP)
```

- 输入必须是**已确认的正式轮次成绩**：round 已 locked，且当前 ranking snapshot
  的 `sourceScoreVersion` 与 round 一致；
- 权重用整数 basis points，避免浮点；合计必须为 10000；
- 只使用已量化为两位小数的正式成绩，再做加权和二次量化；
- 缺失成绩返回 `SCORE_MISSING`，不得按 0 计算；
- 同一 side 在不同轮次的 contestant_id 必须一致（team 用 `team:<id>`）。

### 8.2 两种消费方式

1. **challenge 比赛胜负**：`method: "composite"` 的 match 不创建内部评分轮次，
   而是读取冻结的 `CompositeRule`，分别计算两侧复合分，较高者胜；
2. **最终名次**：`tournament.composite.confirm` 读取配置的轮次权重（例如第一轮
   40%、第三轮 60%），生成 `tournament_result(kind="composite")`；挑战场比分
   默认不进入该结果，除非规则显式加入。

### 8.3 确认与陈旧

- 预览命令只读，不落库；
- confirm 必须带 `expectedInputFingerprint`；fingerprint 包含：
  activityId、规则 fingerprint、每个源轮次的 roundId、scoreVersion、ranking
  revision、参与 side 列表；
- confirmed 后，任一源轮次 scoreVersion 或 ranking revision 变化，结果即 stale；
  publishing 读面必须重新校验 fingerprint；
- 重新确认会生成新的 revision，并 `markConsumedResultsStale` 影响已发布结果；
- 平局时 `status = hold`，必须先用 `competition.tie.decide` 处理源轮次并列，
  或由 `tournament.result.decide_tie` 记录显式名次决定；不得自动破平。

### 8.4 与 podium 的关系

- 现有 `podium_candidate` 仍是 competition 的「最后轮次排名」候选；
- tournament composite 是独立的 `tournament_result`，publishing 新增 source
  kind `tournament_result`；
- 一个活动只能选择一种最终结果来源，release 冻结时校验，不允许 podium 与
  tournament composite 同时成为同一 stage 的候选。

## 9. 模式隔离与演练

- `tournament_bracket.mode`：`test` | `rehearsal` | `formal`，创建时取自执行
  会话；
- 所有 match/result 写入按其 bracket mode 分区；读面默认按当前会话 mode；
- 一旦存在 formal bracket/score/result，非 formal 写入返回 `FORMAL_FACTS_EXIST`；
- `tournament.rehearsal.reset` 删除非 formal bracket、side、match、seat、
  challenger、tournament_result 及其内部 bracket 评分轮次；formal 数据不受影响；
- 内部评分轮次的 score fact 按 mode 隔离，复用现有 rehearsal reset 的保护。

## 10. 权限、命令与事件

### 10.1 Teams

- 权限：`teams.manage`
- 命令：`teams.team.create`、`teams.team.update`、
  `teams.team.member.add`、`teams.team.member.remove`、
  `teams.team.withdraw`、`teams.roster.freeze`、`teams.roster.correct`、
  `teams.roster.import_grouping`
- 查询：`teams.read`
- surfaces：`studio`、`ops`；scopes：空（活动级规划事实）
- 事件：`TeamCreated`、`TeamUpdated`、`TeamMemberAdded`、`TeamMemberRemoved`、
  `TeamWithdrawn`、`TeamRosterFrozen`、`TeamRosterCorrected`、
  `TeamRosterImportedFromGrouping`

### 10.2 Tournament

- 权限：`tournament.manage`（结构、锁定、修正）、
  `tournament.score.write`（开赛、锁分、判定）
- 命令：
  - 结构：`tournament.bracket.create`、`tournament.bracket.lock`、
    `tournament.bracket.cancel`
  - 比赛：`tournament.match.open`、`tournament.match.lock`、
    `tournament.match.decide`、`tournament.match.decide_tie`、
    `tournament.match.walkover`、`tournament.match.reopen`
  - 挑战：`tournament.challenge.select`、`tournament.challenge.pair`、
    `tournament.challenge.decline`
  - 退赛：`tournament.side.withdraw`
  - 结果：`tournament.composite.confirm`、`tournament.result.decide_tie`
  - 演练：`tournament.rehearsal.reset`
- 查询：`tournament.read`
- surfaces：`studio`、`ops`、`live`
- scopes：`judging`；`tournament.composite.confirm` 允许 `judging` 与
  `publishing`（与 `competition.podium.recompute` 一致）
- 事件：`BracketCreated`、`BracketLocked`、`BracketCancelled`、
  `MatchOpened`、`MatchScoreLocked`、`MatchDecided`、`MatchTieDecided`、
  `MatchWalkoverDecided`、`MatchReopened`、`ChallengeSeatSelected`、
  `ChallengePaired`、`ChallengeDeclined`、`SideWithdrawn`、
  `BracketCompleted`、`CompositeResultConfirmed`、`TournamentRehearsalReset`

所有命令走单写路径（receipt + audit + fact + outbox），并带 OCC revision。

## 11. 读面与消费者

- **Ops**：赛事卡片
  - bracket 创建/锁定、种子与轮空预览；
  - 每场比赛的「开赛 → 锁分 → 判定」；
  - challenge 队列与席位选择；
  - 修正、退赛、弃权入口收进「更多操作」。
- **Live**：只显示当前场次、两侧名称、状态与下一步动作；不做逐秒比分。
- **Studio**：Tournament 定义编辑器（mode、size/seats、scoring、权重）。
- **Portal/公开页**：只读取已发布的 bracket 快照；未发布不暴露对阵。
- **Publishing**：新增 `tournament_result` 候选来源；consumption 与 stale 逻辑
  复用 `result-consumption`。
- **Screen/打印**：复用现有 `/screen`、`/print` 的公开快照，不新增权威。

## 12. 归档与导出

bracket 完成或取消后：

- 归档包新增 `tournament.json`（bracket、sides、matches、seats、challengers）
  与 `bracket.csv`、`matches.csv`；
- 归档阻塞条件：bracket `running` 或存在 stale 的 confirmed tournament result；
- 归档快照只读，不重新计算胜负；
- 公开导出沿用受控导出路由，不暴露内部评分事实。

## 13. 故障与恢复

- 两名管理员同时 `decide` 同一场：行锁 + revision，只有一个成功；
- 同一 commandId 重放：返回首次结果，不重复写 fact/event；
- 锁分后源成绩更正：match 必须先 reopen，否则 `MATCH_LOCKED`；
- reopen 级联时下游已 confirmed：默认拒绝，显式 cascade 才继续；
- 进程在 bracket lock 事务中崩溃：全部回滚，无半棵树；
- outbox 投递失败：不影响 HTTP 权威，worker 重试或进入死信；
- rehearsal reset 与正式写入竞争：活动行锁 + mode guard。

## 14. Test architecture

- **Contracts / capabilities touched**：新增 `teams` 与 `tournament`；复用
  descriptor / lifecycle / authorization / idempotency / transaction / event /
  recovery 契约；`competition` 只增加 `round.kind` 过滤，不新增契约。
- **Consumers**：Ops 赛事卡、Live 比赛控制、Studio 编辑器、公开 bracket、
  publishing `tournament_result`、归档包；graph 需新增边并保持 0 unresolved。
- **生命周期 / 终态**：teams draft→frozen→withdrawn；bracket
  draft→locked→running→completed/cancelled；match pending→ready→scoring→
  awaiting_decision→decided/void；decided 只读；reopen 只能走修正命令；
  test/rehearsal/formal 分区。
- **Adapter**：
  - 新增 `teams` adapter，跑共享名册生命周期模板；
  - 新增 `tournament` adapter，跑 match 生命周期模板，并声明
    byes/walkover/tie/reopen 的业务约束；
  - 不复制模板，不按命令各写一套。
- **Property / 算法测试**：bracket 生成器（seed 顺序、bye 分配、晋级路径）与
  composite 计算（basis points、两位小数、缺失分）用 fast-check 覆盖
  交换律/边界，不依赖实现内部结构。
- **故障注入**：并发 decide、重复 commandId、锁分后上游更正、reopen 级联、
  退赛中途、outbox 失败、rehearsal reset 竞争；断言故障期间行为与恢复后的
  最终状态。
- **Anti-bloat**：两个 adapter + 一个共享生命周期模板；不新增逐命令测试族，
  不复用 competition 的 UI 测试；公开页只做一条 journey。
- **Focused gates**：domain/runtime/db/api/web/contracts test、双连接并发、
  `schema:check`、`graph:check`、结构门禁、Golden、`check_docs`、`build:prod`、
  Web E2E（Teams + elimination + challenge）。

## 15. 交付切片

1. Teams capability（定义、迁移、服务、API、最小 Ops/Studio、adapter）；
2. elimination bracket core（生成器、lock、内部评分单元、比赛生命周期）；
3. 判定语义（tie、walkover、withdraw、reopen 级联、并发）；
4. composite（规则编译、计算、confirm、stale、publishing 交接）；
5. challenge 模式（席位、队列、配对、继承）；
6. Tournament Pack、公开 bracket、归档/CSV、完整门禁。

详细顺序、出口条件和验证见计划文档。

## 16. 待评审的取舍

- 首发是否只做 elimination，把 challenge 放到第二个里程碑；
- 内部评分轮次是复用 `competition_round`（本设计）还是新建独立评分表；
- 公开 bracket 是活动内页面还是单独 `/bracket/<publicCode>`；
- Tournament Pack 是单一 preset 还是 elimination/challenge 两个 preset。

以上不影响第 4–10 节的权威和生命周期契约，只影响切片顺序与 UI 落点。
