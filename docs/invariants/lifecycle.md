# LIFE — 状态机、冻结、恢复与归档

**原则**：状态只能沿显式的边迁移；进入“权威状态”时冻结公众事实；恢复是窄
seam，不是重置全部。

v1 证据：74 条生命周期类 fix，高频词 `round 28`、`state 16`、`cleanup 12`、
`roster 12`、`restore 14`。

---

## LIFE-01 状态机是显式数据，只有一个迁移入口

**规则**：每个聚合的状态集合和允许的边是显式定义；任何状态变化都通过一个
transition command，并按当前状态拒绝非法边。不能通过 `save(status=...)` 或
通用更新跳转。

**为什么**：v1 的 Activity、RulesetVersion、ContestRound、StageResult、
PublicPost/ResultRelease 都曾出现“任意 ORM 写就能改状态”，随后逐个加守卫。

**必须攻击的形状**：

- 直接更新状态字段；
- 跳过中间状态（draft → live）；
- 对归档/锁定对象执行迁移；
- 同一状态重复迁移产生重复副作用。

**Plus 要求**：状态机是领域模型的一等对象；迁移返回领域事件；重复迁移幂等。

---

## LIFE-02 进入权威状态时冻结公众事实

**规则**：FROZEN / CONFIRMED / PUBLISHED / ARCHIVED 这些状态必须携带一个
自包含 snapshot，冻结当时公众可见的字段（标题、候选、排序、奖项、版本、
指纹、身份）。

**为什么**：v1 的 `ResultRelease.result_snapshot` 冻结 decisions/awards/
`activity_title`/`public_title`/`candidate_revision`；此前活动改名会改写已发布
结果的标题，候选重算会改写历史 release 描述的内容。

**必须攻击的形状**：

- 冻结后修改活动标题、文章标题、正文、封面、候选；
- 重算得到新候选 revision 后旧 release 仍指向新内容；
- 归档时使用当前活动名而不是冻结标题；
- 旧记录缺 snapshot 时用当前值伪造历史。

**Plus 要求**：冻结命令产出不可变 snapshot；历史读模型只读 snapshot；无法
重建的旧数据显式标 `legacy`，best-effort 字段必须标注。

---

## LIFE-03 解锁只打开这次结果拥有、且允许重写的事实

**规则**：unlock 不是 reset。它只能解锁当前结果消费的、允许重算的输入；被
更早的正式 authority（例如挑战赛 source、已核定的上游赛段）钉住的事实必须
保持锁定。

**为什么**：v1 的赛段解锁曾把 challenge source 的 R1 改回 SCORING，绕过了
普通 `unlock_round` 的 guard；修复为 `round_is_live_challenge_history()` 保持
锁定，并要求通过专门的 per-performance 纠错窗口。

**必须攻击的形状**：

- 解锁已锁定/已核定的上游事实；
- 解锁一个被其他 CONFIRMED 结果消费的轮次；
- 解锁后不重算、不重新核定就发布；
- 对已发布的 StageResult 直接改分。

**Plus 要求**：每个结果声明它消费的输入集合；unlock 计算“可写闭包”，并
保留其他 authority；解锁产生新的 candidate revision。

---

## LIFE-04 纠错是窄的、可审计的 seam，并且能在 UI 走完

**规则**：纠错命令只打开目标 performance/slot 的评分门，要求原因、操作者、
预期的 candidate revision；改完后必须重新锁定、重算、重新核定。UI 必须把
整条链串起来，不能只在 service 层可用。

**为什么**：v1 的 `reopen_performance_score_for_correction` 要求轮次已解锁、
无其他 CONFIRMED 消费者、保留 panel/seat provenance，并 bump context version；
此前恢复链在 UI 中断（缺 relock 入口、prepare panel 撞唯一约束成 500）。

**必须攻击的形状**：

- 对未解锁/仍被消费的 performance 开门；
- 开门后修改其他 performance；
- 不 relock 就 lock_round；
- 重复开门/重复锁定；
- 从 UI 无法完成整条恢复链。

**Plus 要求**：纠错命令是显式 saga（开门 → 改 → 锁 → 重算 → 核定），每一步
幂等、可审计、可在同一界面完成。

---

## LIFE-05 归档是终态；解归档是独立 authority

**规则**：进入 ARCHIVED 只能通过归档命令（带完整包与审计）；普通迁移不能
进入或离开 ARCHIVED。解归档是独立的、已审计的命令，并且不能伪造一个从未
发生过的阶段。

**为什么**：v1 允许通用 phase migration 进入归档，后来收紧；解归档固定回到
RESULTS_PUBLISHED 并 demote 当前归档包。

**必须攻击的形状**：

- 用普通 phase 更新进入/离开 ARCHIVED；
- 归档一个未 CONFIRMED/未公示的活动；
- 解归档一个未归档活动；
- 归档后继续写评分/结果/票据。

**Plus 要求**：终态在读模型与写命令两层都不可写；归档包是发布产物的一部分；
解归档是显式恢复命令，不改变历史包。

---

## LIFE-06 清理顺序由事实依赖决定，不由表名决定

**规则**：测试数据清理必须按“事实被谁消费”的顺序删除；带 `PROTECT` 的
运行时对象（会话、比赛、席位、评分回执）必须显式处理，不能依赖级联。

**为什么**：v1 新增 ChallengeSession/Seat/Turn/Match 后，清理清单没跟上，
删除报名时 `ProtectedError` 回滚整场彩排；运行时生成的评分轮不在删除清单里。

**必须攻击的形状**：

- 完整 TEST 彩排后执行清理并断言计数归零；
- 评分/投票/票据仍被引用时删除报名；
- 动态生成的轮次/会话/席位残留；
- 清理中途失败后的回滚。

**Plus 要求**：每个聚合声明“被谁引用”；清理命令按依赖图排序；清理是一个
可重放的命令，失败不会留下半清理状态。

---

## LIFE-07 “名单未定”不是“零人”；deferred 不是 pass

**规则**：报名名单、投票候选、分组容量等事实在名单确定前是 UNKNOWN；执行
边界必须 fail closed。编译/校验可以把它们标为 DEFERRED，但 DEFERRED 既不是
ERROR 也不是 PASS。

**为什么**：v1 在 0 报名时把 `entry_size` 当 0，导致 `QUOTA_EXCEEDED` 假错误；
引入 `entry_roster_final` 和 `Severity.DEFERRED` 后，赛制可以在报名前冻结，
但运行时（prepare_round/open_vote_session）会重新验证。

**必须攻击的形状**：

- 名单未定时开始评分/投票；
- 名单变化后继续使用旧的候选快照；
- 把 deferred 报告当作通过；
- 名单确定后仍保留旧的容量假设。

**Plus 要求**：事实有 `known/unknown` 状态；执行命令要求事实已确定；校验
报告区分 ERROR / DEFERRED / PASS，并在运行边界重新求值。

---

## LIFE-08 每个阶段迁移都留下审计，并且可以回答“为什么是现在”

**规则**：所有权威状态变化（冻结、核定、解锁、发布、撤销、归档、解归档）
必须写审计：谁、何时、从什么到什么、原因、关联的 revision/snapshot。

**为什么**：v1 的现场纠错、结果发布、清理都依赖审计复盘；没有审计的迁移无法
解释历史，也无法在事故后定位。

**必须攻击的形状**：

- 迁移成功但审计缺失或字段不全；
- 重试产生重复审计；
- 审计包含密钥、token、学生隐私；
- 事后修改审计。

**Plus 要求**：审计是 domain event 的一部分，与状态变化同一事务；审计字段
是白名单；审计不可原地修改。
