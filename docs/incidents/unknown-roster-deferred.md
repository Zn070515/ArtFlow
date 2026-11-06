# 事故：报名开始前赛制冻结不了（把 UNKNOWN 当成 0）

## 现象

0 人报名时冻结一个 `SELECT top10` 赛制，报 `QUOTA_EXCEEDED`；但 0 不是事实，
只是名单还没确定。

## 触发条件

- `entry_size` 从 APPROVED 报名数推导；
- bound 编译把“暂时无法验证”的 WARN 升级成硬 ERROR；
- 活动处于报名开始前的阶段。

## 根因

系统把“未知”编码成“零”，于是用零去证明一个关于未来名单的约束。这既制造
假错误，也会在真正需要 fail closed 时给出假 PASS。

## v1 修复

- 引入 `entry_roster_final`；名单未定时 `entry_size`/候选取 `None`；
- 编译报告新增 `DEFERRED`，既不是 ERROR 也不是 PASS；
- `prepare_round` / `open_vote_session` 在运行边界重新验证，名单未定直接拒绝；
- 测试覆盖“0 报名可冻结、名单未定不能执行、名单确定后执行通过”。

## 不变量

- LIFE-07：未知≠零；DEFERRED 不是 PASS；
- 执行边界 fail closed，配置阶段允许未完成。

## 门禁

- Golden fixture：`tests/golden/unknown-roster.json`；
- v1 的 `ruleset.test_deferred_roster`。

## Plus 要求

- 领域类型区分 `known` / `unknown`；
- 校验报告有 ERROR / DEFERRED / PASS 三态；
- 执行命令要求名单事实已确定。
