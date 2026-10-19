# Voting（capability）

## 目的

收集观众/现场投票，并把票数按**冻结的成绩组成规则**换算成评分输入。投票是
事实，不是任意实时计数器。

## 实体与值

- `VoteSession`：活动内的一次投票场次；purpose（popularity / score_component）与
  冻结的 `identityPolicy`（`ticket` / `browser` / `anonymous`）。
- `VoteOption`：候选人（通常来自冻结名单）。
- `Ballot`：一次提交；身份必须与 session 的 `identityPolicy` 完全一致，客户端不能
  把 ticket/browser 降级成 anonymous。
- `VoteRecord`：选票中的一项。
- `ScoringRule`：票数→分数的规则（例如 ballot share percent）；冻结时快照。
- `LiveState`：给观众页用的投影；不是权威。

## 生命周期

```text
DRAFT → OPEN → CLOSED
```

一个 Activity 可以有多个投票场次；每个场次是一个 execution scope，是否与其他
scope 冲突由 capability 组合声明。

## 流程

```text
open session（候选名单 + 规则）
  → 观众/持票人提交 ballot
  → 关闭 session
  → loader 只读取仍然有效的 ballot（ticket 必须仍为 redeemed）
  → 按冻结规则换算为评分输入
```

## 不变量

- **VOT-01** 每个 session 必须显式选择一种身份策略；ticket/browser 由数据库唯一键
  保证一票一次，anonymous 只有在规则显式选择时才允许，且不伪造匿名唯一性。
- **VOT-02** 候选名单在 session 打开时冻结；运行中不得改变候选集。
- **VOT-03** 换算规则在赛制冻结时快照；运行时不得现查当前规则（SCOR/RES）。
- **VOT-04** 原始票数与换算分数是两层事实；loader 不得把票数伪造成“评委分”。
- **VOT-05** 关闭的 session 不可再收票；重复提交返回明确错误，不静默覆盖。
- **VOT-06** 被撤销、过期或失效 ticket 产生的历史 ballot 保留作审计，但不进入正式计票。
- **VOT-07** 没有有效 ballot 时，`score_component` 结果为 `HOLD/NO_VALID_BALLOTS`，
  不能把无数据解释成 0 分。

## 事件

`VoteSessionOpened`、`BallotSubmitted`、`VoteSessionClosed`、
`VoteScoresComputed`、`LiveStateUpdated`（投影事件）。

## v1 参考

- `voting/models.py`、`voting/services.py`
- `singer_contest/services.py::_source_vote_scores`
- 票据交叉：`docs/domains/tickets.md`

## Plus 要求

- Ballot 唯一性是数据库约束，不只是应用检查。
- 票数→分数是纯函数；分母、`ROUND_HALF_UP` 舍入、空 session 的语义显式且可测。
- Live 投影允许最终一致，但公开事实必须来自关闭后的权威统计。
- 任何实时通道失效时，投票仍可通过 HTTP 完成（DEPL-05）。

多选票的上限与重复项语义必须在规则层显式声明，而不是由前端约束。Voting
capability 不再静态依赖 ticketing；只有 `identityPolicy = ticket` 的组合才要求
ticketing capability。
