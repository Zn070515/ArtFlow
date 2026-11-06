# ArtFlow-Plus M8e-1：执行模式加固（mode hardening）

状态：已确认（2026-10-26）
范围：score fact / vote session / ranking snapshot 的 mode 归属、正式读路径过滤、
非 formal 生命周期守卫、排练数据重置。
非目标：v1 导入/对账、入口切换、回滚、三类活动验证（M8e-2/3/4）；按 mode 复制
round/panel/performance；报名/材料 mode；投票 UI。

## 决策

- 隔离范围是**分数与选票**。报名与材料始终是活动正式数据；测试报名用独立测试
  活动，v1 `is_test_data` 的导入策略在 M8e-2 决定。
- 事实绑定方式是**mode 字段 + 复合唯一键**，不是 execution_session_id。
- test/rehearsal/formal 都可以 resolve；排名按 mode 分开保存。podium candidate、
  advancement、tie decision、确认与发布仍只接受 formal。
- 正式事实出现前，可以在同一活动排练（含锁表演/锁轮）；排练结束后用
  `reset-rehearsal` 清除非 formal 数据并把回合还原。正式之后不得在同活动排练，
  改用活动副本。

## 数据模型（迁移 0015_mode_isolation）

| 表 | 变更 |
| --- | --- |
| `score_fact` | 新增 `mode`（test/rehearsal/formal，非空，默认 formal）；partial unique index 改为 `(round_id, contestant_id, judge_id, mode) where current` |
| `vote_session` | 新增 `mode`（同上，非空，默认 formal） |
| `ranking_snapshot` | 新增 `mode`（同上，非空，默认 formal）；新增 `(round_id, mode, revision desc)` 索引 |

- 现有行由默认值回填为 `formal`。
- 新 score fact 的 id 派生加入 mode：
  `score:<roundId>|<contestantId>|<judgeId>:<contextVersion>:<mode>`，避免同一
  context 下排练与正式 id 冲突。旧 id 保留，不重写。
- `score_revision` 与 `score_correction` 不新增 mode，它们通过所属 fact 归属。

## 写入

- `submit*Score`：`loadScoreContext` 已读取运行中的 session，把 `session.mode`
  写入 fact；`mode` 进入 command payload（幂等/receipt 的一部分）。
- 重复检查、`getScoreFactForUpdate`、gate 计数、`listCurrentScoreFacts` 全部带
  mode；排练分不再触发正式分的 `DUPLICATE_SCORE_FACT`。
- 改分与纠错：加载 fact 后要求 `fact.mode === session.mode`，否则 `FORBIDDEN`；
  纠错 revision 继承 fact 的 mode 语义。
- `openVoteSession`：把运行中 session 的 mode 写入 vote_session；ballot 通过
  vote_session 继承，不加列。
- 报名/材料不新增 mode。

## 读取与解析

- `getLiveState`：mode = 运行中 session.mode，否则 formal；排名按该 mode 取最新，
  表演的 `scoreCount` 只统计该 mode。
- `getJudgeContext`：解析运行中的 judging session 的 mode（无 session 用 formal）；
  `existingScore` 只返回该 mode 的事实。
- `resolveRound`：事实与 ranking 都用 `session.mode`；三种 mode 都可生成排名。
- `recomputePodiumCandidate`、`finalizeAdvancement`、`recordTieDecision`：要求
  `session.mode === "formal"`，否则 `FORMAL_MODE_REQUIRED`；podium 只读 formal 排名。
- `GET /api/activities/:id/competition/rounds/:roundKey/ranking`：新增可选
  `mode`（test/rehearsal/formal），默认 formal；现有调用不变。写入命令不接受
  mode 参数，一律从运行中的 session 派生。
- `StoredVoteSession` 暴露 `mode`；已关闭票场的 tally 继续按 vote_session 读取。
  后续正式成绩组合只能消费 `mode=formal` 的票场。

## 生命周期守卫

新错误 `FORMAL_FACTS_EXIST`（409）：当目标回合存在任何 `mode=formal` 的
score fact（current 或 retired），非 formal session 的以下命令被拒绝且无副作用：

- `openPerformance`
- `lockPerformance`
- `lockRound`
- `resolveRound`
- （`advancePerformance` 内部路径同样检查）

formal session 不受影响；排练发生在正式之前时照常走完整生命周期。

## 排练重置

`POST /api/activities/:id/competition/rounds/:roundKey/reset-rehearsal`
（`competition.manage`，body `{ scope, mode }`，mode 为 test/rehearsal）：

1. 锁 Activity → round；若该回合存在任何 formal score fact，返回
   `FORMAL_FACTS_EXIST`。`mode` 只用于事件与审计，删除范围是该回合的**所有**
   非 formal 事实（test 与 rehearsal 一起清）。
2. 删除该回合所有非 formal 的 score corrections、score revisions、score facts；
   删除该回合所有非 formal ranking snapshot。
3. 删除该回合的 performance_score_state 与 performance（此时没有 formal 事实引用）。
4. 当前 panel 置为 `superseded`/`current=false`；round 置为 `prepared`，
   `revision+1`、`scoreVersion=0`、`currentPanelId=null`、`lockedAt=null`。
5. 不主动回收 judge entry seats：保留 claim，下一次激活 panel 时按既有 seat key
   逻辑撤销旧 session 并 reopen，避免跨回合误伤。
6. 写 `RehearsalRoundReset` 事件，payload 带删除计数、scope、mode。

重置后正式流程：激活新 panel → 开表演 → 评分 → 锁表演/锁轮 → resolve。

## 测试

- Runtime：排练分不阻塞正式分；正式 resolve 忽略排练事实；排练 ranking 独立；
  `FORMAL_FACTS_EXIST` 守卫（四种命令）；改分 mode 不匹配被拒；
  vote_session mode 标记；reset 清除非 formal 数据并把回合还原到 prepared；
  reset 在有 formal 事实时拒绝且无副作用。
- API：Live 在 rehearsal 下显示该 mode 的计数/排名；judge context 不返回正式分；
  ranking endpoint 的 mode 过滤；reset 路由权限与错误码。
- E2E：现有正式链路保持通过；新增同活动“排练 → reset → 正式”链路。
- 现有测试夹具补齐 mode 默认值；全量 tests 与 E2E 通过，`check_docs.ps1` 通过。

## 边界

- 正式之后的排练必须用活动副本；本 slice 不提供复制命令。
- 不做按 mode 的 round/panel/performance 状态复制。
- 不做报名/材料 mode；测试报名是独立测试活动。
- advancement/tie/publishing 只有 formal；排练只产排名，不产晋级/发布事实。
- 内存限流器、SSE、导出与归档不在本 slice。
