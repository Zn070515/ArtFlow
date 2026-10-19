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
| 材料上传/审核 | `files/` | Materials | M4 | 受控媒体 + 自有事实 |
| 名单 FINAL/UNKNOWN | `singer_contest` roster | Registration | M4 | UNKNOWN ≠ 零；执行边界 fail closed |
| 赛制/轮次/席位 | `ruleset/`、`singer_contest` | Competition | M5 | capability DSL（不是通用 DAG） |
| 评委评分/快速录分/代录/纠错 | `singer_contest`、`judge_*` | Evaluation | M5 | score fact 唯一键 + command receipt |
| 观众投票 | `voting/` | Voting | M6 | ballot 唯一性 + ticket 凭证 |
| 票据/入场/签到 | `tickets/`、`entry_access/` | Ticketing / Check-in | M6 | capability token、受控入口 |
| 结果候选/核定/发布/撤销 | `public_portal/services.py` | Publishing / Results | M7 | snapshot + release selector |
| 归档包 | `archive/` | Archive | M7 | 冻结身份 + 文件清单 |
| Live 状态/断线恢复 | `realtime/`、`public_portal/live_state.py` | Engine + capability projections | M3（引擎部分已完成） | outbox/投影 + SSE + HTTP 游标 |
| 测试/正式隔离 | `core/lifecycle.py` | Engine + 各 capability | M3（分区已完成） | mode 来自 session；事件/投影按 mode 分区 |
| 活动 Pack / 引导配置 | v1 无对应（新增能力） | Registry + Pack | M2（已完成） | 组合而不是 Activity 子类 |

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

## 仍由后续里程碑证明的部分

- M5-M7 的真实 capability 命令、投影与 golden fixtures。
- 现场旅程（报名→评审→投票→发布→归档）的端到端验证。
- 第三个结构不同的活动在不改内核的情况下运行。
- SSO provider 与现场旅程（报名→评审→投票→发布→归档）的端到端验证；M4 当前使用
  本地会话，SSO 仍在 M8；不伪造身份。

## 约束

1. 任何 capability 不得读写其他 capability 的表；只能通过命令/查询/事件/稳定 ID/binding。
2. 产品面（Studio/Ops/Live/Portal）只组合公开 contract，不自行解释权威事实。
3. 新增 capability 只需注册 manifest + compiler + handlers，不修改 Engine；M4 的
   registration/material 当前状态表仍由 capability-owned repository 管理。
4. 结构门禁 GATE-PLUS-BOUNDARY-01 检查上述边界；`REQUIRE_DB=1` 保证数据库测试不会静默跳过。
