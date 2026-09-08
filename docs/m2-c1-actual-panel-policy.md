# M2-C1 Actual Panel Policy

状态：批准进入实现

## 目标

把评委组从“当前活动评委列表”收敛为可审计的三层事实：

1. `RoundJudge` 是轮次准备时冻结的预备评委名单（expected roster）。
2. `RoundPanelSnapshot.members` 是开赛时实际到场并获准评分的评委面板（actual panel）。
3. `ContestRound.minimum_judge_count` 是草稿阶段配置的最低有效到场人数；未配置时按预备名单人数 fail-safe，不能按计分算法猜测。

评分矩阵、缺分检查、重算、锁定校验、后台评分网格和评分表导入必须使用同一个正式面板快照。没有正式面板快照时，兼容既有轮次使用 `RoundJudge`；一旦快照存在，不得回退到活动评委或临时查询结果。

## 权威性与不变量

- 预备名单人数为 `expected_judge_count`；实际面板人数为快照中 `is_active=True` 的成员数。
- 到场评委只能来自该轮次的 `RoundJudge`，不接受活动外评委、临时新增评委或仅凭姓名匹配的评委。
- `minimum_judge_count` 只能在 `DRAFT` 修改；轮次准备后、面板快照建立后均不可直接 ORM 修改。
- 未配置最低人数时，有效最低人数等于预备名单人数。这是 fail-safe，避免把平均分错误地放宽为 1 人。
- `DROP_HIGH_LOW` 使用固定去最高和最低各 1 个的规则；最低人数必须大于 2，否则拒绝准备。
- 实到人数低于最低人数时，准备操作以 `INSUFFICIENT_JUDGES` 拒绝并保持无可评分的正式面板；不得创建 `ACTIVE` 快照、性能运行状态或评分单元格。
- 实到人数达到最低人数时，创建不可静默改写的 `RoundPanelSnapshot`，其 `expected_judge_count`、`minimum_judge_count`、成员列表和 roster digest 一起审计。
- 现有 `HOLD` / `SUPERSEDED` 快照不再作为当前评分面板；唯一可用于评分的快照是最新 `ACTIVE` 快照。已有正式快照时，所有评分读取必须沿用该快照的成员，即使 `Judge.is_active` 后续变化。
- 评分记录属于轮次且评委必须属于当前权威面板；面板外的分数不能进入缺分、重算或锁定结果。

## 服务契约

`prepare_judge_panel(round_id, *, operator, attending_judge_ids=None)`：

- `attending_judge_ids=None` 仅为历史调用兼容，表示全部预备评委到场；新控制面板必须显式传入现场核验后的 ID 集合。
- 返回已存在的 `ACTIVE` 快照时保持幂等，不重新解释当前活动评委。
- 传入重复 ID、非整数 ID、预备名单外 ID 或空集合时失败；最低人数不足时使用错误码语义 `INSUFFICIENT_JUDGES`。
- 到场快照的成员按预备名单顺序生成固定 `seat-N`，审计记录包含 expected、actual、minimum、digest 和 attending IDs。

## 验收场景

| 场景 | 预备 | 最低 | 实到 | 结果 |
| --- | ---: | ---: | ---: | --- |
| 平均分，配置最低人数 | 5 | 4 | 4 | ACTIVE，矩阵为 4 名到场评委 |
| 平均分，未配置最低人数 | 5 | 5 | 4 | `INSUFFICIENT_JUDGES`，不得评分 |
| 去最高最低 | 5 | 3 | 3 | ACTIVE，重算去 1 高 1 低 |
| 去最高最低，最低配置为 2 | 5 | 2 | 5 | 拒绝非法政策，不能绕过统计规则 |
| 快照建立后活动新增/停用评委 | 既有快照 | — | — | 矩阵与锁定仍只使用快照成员 |
| 快照建立后直接 ORM 修改最低人数 | — | — | — | 被 authority guard 拒绝 |

## 范围边界

本阶段只闭合政策、快照和评分矩阵的权威来源；现场签到 UI、评委端展示和学校身份接入留给后续 M2-C2/C3。不会借本阶段重新设计评分算法、奖项物化或学校 SSO。
