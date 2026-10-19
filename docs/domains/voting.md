# Voting 领域

## 目的

收集观众/现场投票，并把票数按**冻结的成绩组成规则**换算成评分输入。投票是
事实，不是任意实时计数器。

## 实体与值

- `VoteSession`：活动内的一次投票场次；purpose（popularity / score_component）。
- `VoteOption`：候选人（通常来自冻结名单）。
- `Ballot`：一次提交；ticket-backed 或 browser/anonymous。
- `VoteRecord`：选票中的一项。
- `ScoringRule`：票数→分数的规则（例如 ballot share percent）；冻结时快照。
- `LiveState`：给观众页用的投影；不是权威。

## 流程

```text
open session（候选名单 + 规则）
  → 观众/持票人提交 ballot
  → 关闭 session
  → loader 读取原始票数
  → 按冻结规则换算为评分输入
```

## 不变量

- **VOT-01** 需要票据的投票，一张票只能产生一票（或规则允许的多选）。
  唯一性由 ticket/ballot 身份保证，浏览器指纹只能用于无票场景（TICK-04）。
- **VOT-02** 候选名单在 session 打开时冻结；运行中不得改变候选集。
- **VOT-03** 换算规则在赛制冻结时快照；运行时不得现查当前规则（SCOR/RES）。
- **VOT-04** 原始票数与换算分数是两层事实；loader 不得把票数伪造成“评委分”。
- **VOT-05** 关闭的 session 不可再收票；重复提交返回明确错误，不静默覆盖。

## 事件

`VoteSessionOpened`、`BallotSubmitted`、`VoteSessionClosed`、
`VoteScoresComputed`、`LiveStateUpdated`（投影事件）。

## v1 参考

- `voting/models.py`、`voting/services.py`
- `singer_contest/services.py::_source_vote_scores`
- 票据交叉：`docs/domains/tickets.md`

## Plus 要求

- Ballot 唯一性是数据库约束，不只是应用检查。
- 票数→分数是纯函数；分母、舍入、空 session 的语义显式且可测。
- Live 投影允许最终一致，但公开事实必须来自关闭后的权威统计。
- 任何实时通道失效时，投票仍可通过 HTTP 完成（DEPL-05）。

## 待决问题

- 多选票的上限与重复项语义需要在规则层显式声明，而不是由前端约束。
- 无票投票是否仍允许浏览器身份？v1 允许；v2 应默认关闭，除非活动显式启用。
