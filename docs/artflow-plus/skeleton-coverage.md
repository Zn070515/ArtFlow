# v1 骨架功能在 Plus 新架构中的落点

状态：执行基线（2026-10-19）。本文回答一个问题：**ArtFlow-Plus 不是 v1 的移植，那它凭什么
能完成 v1 的骨架功能？** v1 的 Django app 只作为业务证据；每个能力在 Plus 中都是独立的
capability（命令、事件、投影、定义语言），由 Registry/Pack 组合，而不是按表或页面切分。

## 覆盖映射

| v1 骨架功能 | v1 参考（证据） | Plus capability | 里程碑 | 架构落点 |
| --- | --- | --- | --- | --- |
| 活动创建/生命周期/锁定 | `core/`、`common/business_rules` | Engine（thin Activity） | M1/M3（已完成） | durable command + OCC + outbox |
| 报名 DRAFT→OPEN→REVIEW→FINAL | `singer_contest/` 报名 | Registration | M4 | 自有聚合 + 事件 + 投影 |
| 问卷版本与文件槽位 | `questionnaire/` | Questionnaire | M4 | 自有定义语言 + compiler |
| 材料上传/审核 | `files/` | Materials | M4 | 材料 metadata/所有权/审核事实；字节存储与网关后置 |
| 名单 FINAL/UNKNOWN | `singer_contest` roster | Registration | M4 | UNKNOWN ≠ 零；执行边界 fail closed |
| 赛制/轮次/席位 | `ruleset/`、`singer_contest` | Competition | M5 | capability DSL（不是通用 DAG） |
| 评委评分/快速录分/代录/纠错 | `singer_contest`、`judge_*` | Competition（含 Evaluation 领域） | M5 | score fact 唯一键 + command receipt |
| 观众投票 | `voting/` | Voting | M6 | ballot 唯一性 + ticket 凭证 |
| 票据/入场/签到 | `tickets/`、`entry_access/` | Ticketing / Check-in | M6 | capability token、受控入口 |
| 结果候选/核定/发布/撤销 | `public_portal/services.py` | Publishing / Results | M7 | snapshot + release selector |
| 归档包 | `archive/` | Archive | M7 | 冻结身份 + 文件清单 |
| Live 状态/断线恢复 | `realtime/`、`public_portal/live_state.py` | Engine + capability projections + realtime core | M3 / M11 / M13 | outbox/投影 + `activity:<id>` 失效主题 + HTTP 恢复 |
| 测试/正式隔离 | `core/lifecycle.py` | Engine + 各 capability | M3 | mode 来自 session；事件/投影按 mode 分区 |
| 活动 Pack / 引导配置 | v1 无对应（新增能力） | Registry + Pack | M2 | 组合而不是 Activity 子类 |
| 分组合唱赛段 | `singer_contest.GroupStage` | Grouping | M9 | 四态生命周期 + append-only 成员 + 来源指纹 |
| 投票结果公示 | v1 投票结果导出 | Publishing（vote source） | M10 | 关闭场次 tally 冻结为 stage result |
| 观众投票入口 | v1 投票页/二维码 | Voting + Portal | M12 | `/vote/<sessionId>` 公开读 + browser 身份 |
| 实时通道 | v1 Channels | Realtime core | M11 / M13 | 单一 WebSocket 核心；通知-only；SSE 退役 |

## M3 已经证明的部分

- 一个 Pack 生成的空定义可编译、可发布，且没有为未实现 capability 注册占位。
- 多个 scope 可并行；scope 冲突策略由 capability 组合提供并在真实 PostgreSQL 并发下生效。
- 正式/彩排/测试投影与事件流完全分区；测试事实不会进入正式投影。
- 重启后从持久化 release/session 读取一致状态；投影可从事件日志重建。
- 断线后客户端用 `after` 游标恢复，SSE 只是增强。

## M4 已经证明的部分

- 默认 Registry 已注册 `registration`、`questionnaire`、`materials`；问卷和文件槽位
  从 active Definition Release 读取，报名行冻结版本与 schema hash。
- 报名提交、审核、名单最终化、材料上传/审核都经过 receipt → Activity lock →
  projection → event/outbox → audit 的统一 command 事务。
- local session 通过 bearer token 派生 `ActorContext`；参与者只能操作自己的报名和材料，
  Staff 权限才可审核/读取他人材料。
- `unknown-roster` golden 已接入 Plus runtime：UNKNOWN 不等于零，`prepare_round` 在
  名单最终化前返回 `ROSTER_UNKNOWN`，且 rejected command 不产生事件。

## M5 已经证明的部分

- Competition release 编译并冻结 round、rubric、judge count、completion mode、
  advancement quota 与 tie policy；round/panel/performance/score fact projection
  通过 module-owned migrations 持久化。
- direct judge、staff rapid、staff proxy、paper recovery 共享 `(round, contestant,
  judge)` 唯一 score fact；编辑写入 immutable revision，locked performance 的纠错
  要求 correction base version 与 input fingerprint。
- `duplicate-score-fact.json` 已由 `golden-duplicate-score-fact.test.ts` 通过真实
  runtime commands 消费；重复代录无事件副作用，编辑不新增 current row，陈旧 context
  被拒绝。
- PostgreSQL 双连接测试证明 panel activation 与 score fact submission 各自只产生一个
  winner；ranking 的 tie HOLD、explicit tie decision、advancement 和 podium candidate
  都以 frozen input fingerprint 驱动。

## M6–M13 已经证明的部分

- Voting/Ticketing：场次、ballot 唯一性、票据换访问会话、tally 百分比与 mode 隔离。
- Publishing/Archive：候选 → 核定 → release snapshot → 撤销/替代；归档包白名单与
  受控下载；投票来源也可发布（M10）。
- 现场旅程：报名 → 评审 → 投票 → 发布 → 归档；观众可从 `/vote/<sessionId>` 投票
  （M12），Live 控制台通过单一实时核心失效提示（M13）。
- 第三个结构不同的活动（review-awards）与 stage-show、vote-poll 都在不改内核的情况下
  运行；Pack 携带默认 definition。
- 两个实时主题（`voting:<activityId>`、`activity:<activityId>`）共用一个受保护的
  WebSocket 核心与客户端；SSE 已退役。

## 仍然开放

- 票据场次的投票入口（页面明确阻断）。
- 参与者账号认领/迁移（legacy 报名没有登录账号）。
- 舞台类节目单公开页、bracket/对阵、XLSX 导出、现场大屏。
- SSO provider；当前使用本地会话，不伪造身份。
- 多实例实时广播（Redis）与权限实时撤销。

## 约束

1. 任何 capability 不得读写其他 capability 的表；只能通过命令/查询/事件/稳定 ID/binding。
2. 产品面（Studio/Ops/Live/Portal）只组合公开 contract，不自行解释权威事实。
3. 新增 capability 只需注册 manifest + compiler + handlers，不修改 Engine；M4 的
   registration/material 当前状态表仍由 capability-owned repository 管理。
4. 结构门禁 `GATE-PLUS-BOUNDARY-01` 检查 capability 边界，`GATE-REALTIME-CORE-01`
   检查实时传输独占；`REQUIRE_DB=1` 保证数据库测试不会静默跳过。
