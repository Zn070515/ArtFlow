# SCOR — 评分事实、评委组与评分门

**原则**：一个评委对一名选手、在一轮里只能有一个正式 score fact；所有来源
（评委终端、快速录分、工作人员代录、纸面补录）写的是同一个事实。

v1 证据：71 条评委/评分/踢馆类 fix，高频词 `judge 29`、`score 25`。

---

## SCOR-01 一个 score fact 的唯一键是 (round, singer, judge)

**规则**：同一轮、同一选手、同一评委只能存在一条正式分数。任何来源的再次
提交必须被拒绝或走“修改已有事实”的路径，不能新建第二条。

**为什么**：v1 的快速录分与工作人员代录写同一张 `ScoreRecord` 表；代录重复
提交会报 `DUPLICATE_SCORE_FACT`。这不是 bug，是防止同一评委产生矛盾分数。

**必须攻击的形状**：

- 快速录分后再代录同一席位；
- 评委终端已提交后工作人员再代录；
- 不同来源并发提交；
- 修改分数时新建而不是更新。

**Plus 要求**：分数是唯一事实；修改走 edit command（保留历史），新增重复
返回明确的领域错误；UI 直接引导到编辑。

---

## SCOR-02 分数绑定评委看到的上下文

**规则**：每条分数绑定 panel snapshot、seat、performance、context version
和 payload hash；其中任何一项变化都视为陈旧，拒绝写入。

**为什么**：v1 的评委提交比较 `context_version`、panel snapshot、seat 归属
和 performance；工作人员代录也复用同一套绑定。现场切换表演后旧页面提交会被
拒绝为 `STALE_CONTEXT`。

**必须攻击的形状**：

- 切换表演后用旧页面提交；
- panel HOLD/重建后提交；
- 用其他轮的 seat/performance；
- seat 属于其他评委。

**Plus 要求**：评分 token 携带上下文；服务端在锁内验证；错误区分“已切换”
与“无权提交”。

---

## SCOR-03 评分门由 (performance state, panel state, score window) 共同决定

**规则**：只有当前表演处于 PERFORMING/ACCEPTING_SCORE、panel ACTIVE、评分
窗口 OPEN 且 context version 匹配时才接受分数。HOLD 不是“部分可用”。

**为什么**：v1 曾出现 HOLD 时仍能提交、panel 仅在 ACTIVE 时才算当前、评分
窗口关闭后仍可写；后期把这些条件收敛到一个 gate。

**必须攻击的形状**：

- HOLD 中提交；
- 评分窗口关闭后提交；
- 未切换表演时提交；
- panel 已 SUPERSEDED 时提交。

**Plus 要求**：评分门是一个显式状态机；所有写路径查询同一个 gate；UI 的
禁用只是提示，不是授权。

---

## SCOR-04 一轮只有一个权威评委组快照

**规则**：一个轮次在任何时刻只有一个“当前”panel snapshot；历史 snapshot
可以保留，但不能被混用为当前评委名单。

**为什么**：v1 的纠错窗口里，`lock_performance_score` 回退到 superseded
panel，而快速录分回退到可变的 `RoundJudge`，导致两套 roster。修复为
`scoring_panel_snapshot()` 统一读最近一份 panel。

**必须攻击的形状**：

- 纠错后新旧 panel 混用；
- 重复 prepare panel 撞唯一约束；
- 不同读路径取不同 roster；
- 释放/换机后旧终端继续可写。

**Plus 要求**：panel 有唯一 current 指针；所有评分读路径共用同一 selector；
历史 panel 只读。

---

## SCOR-05 锁定/重开以 performance 为单位

**规则**：锁定或重开评分只影响目标 performance；`lock_round` 必须拒绝仍有
OPEN 评分门的轮次，不能出现“轮次已锁、门还开着”。

**为什么**：v1 的 `lock_round` 曾允许存在 OPEN 的 `PerformanceScoreState`，
导致 podium 只能 HOLD 且无法补锁。

**必须攻击的形状**：

- 有 OPEN 门时锁轮次；
- 锁定后继续写该 performance；
- 重开一个已被其他 CONFIRMED 结果消费的 performance；
- 重开后不重新锁定。

**Plus 要求**：performance 是评分生命周期的最小单元；轮次锁定是它们的
聚合断言；状态组合必须可枚举、可测试。

---

## SCOR-06 代录/纸面录入必须可追溯

**规则**：工作人员代录与纸面补录必须提供来源编号和原因，写入审计，并且与
普通评分共享唯一事实约束。

**为什么**：v1 的 `submit_staff_proxy_score` / `submit_paper_score` 要求
`source_reference` 与 `reason`，审计记录 payload hash；否则无法解释现场
分数是谁、凭什么录的。

**必须攻击的形状**：

- 空来源/空原因；
- 同一席位重复代录；
- 代录绕过评分门；
- 审计缺失或包含敏感信息。

**Plus 要求**：代录是显式 command，来源与原因是必填；审计与分数同一事务；
UI 明确区分“代录”和“纸面补录”。

---

## SCOR-07 评分结果的合成与晋级必须可重放

**规则**：从原始分数到平均分、排名、晋级、奖项的每一步都是确定性函数，
输入包含版本/指纹；重算必须得到相同结果，且不能修改已锁定的上游事实。

**为什么**：v1 的 resolver 曾用报名册顺序隐式破同分、把 defer 当 pass、
对旧 frozen 版本跑正式结果；后期收敛到显式 tie_break、fingerprint 与
current frozen gate。

**必须攻击的形状**：

- 同分无显式 tie 决策；
- 用非 current frozen 版本重算；
- 上游已锁定后重算；
- 输入指纹不变但输出变化。

**Plus 要求**：resolver 是纯函数（输入 + 版本 → 输出）；tie 只按显式规则；
同分未决返回 HOLD，不猜；每次发布记录 input fingerprint。
