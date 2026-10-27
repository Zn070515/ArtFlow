# 现场彩排 Runbook（M8e-4）

适用：judged singer competition 的完整彩排；同一天也可用 stage-show /
review-awards 的简化版（无现场表演/无发布）。

## 0. 彩排目标

- 验证 staff/评委/公开页在真实网络与设备上的路径；
- 验证评分、锁表演/锁轮、resolve、发布/归档；
- 验证异常路径：断网、评委迟到、同分、录分错误；
- 不写正式结果：彩排使用 `rehearsal` session；正式 session 在彩排后按 M8e-1
  的重置/或活动副本处理。

## 1. 彩排前（T-60 min）

| 检查 | 命令/位置 | 负责人 | 结果 |
| --- | --- | --- | --- |
| cutover 演练已通过 | `docs/artflow-plus/cutover-runbook.md` §7 | | |
| staff 账号可登录 | `cutover-smoke.mjs` staff 段 | | |
| 活动/名单已导入或创建 | Ops → 活动 → 报名/名单 | | |
| 回合已 prepare、评委组已激活 | Live 控制台 | | |
| 评委链接可打开 | `/judge/<code>?capability=...` | | |
| 备用录分人/纸面表格 | 2 台设备 + 纸质表 | | |
| 大屏/公开结果页可访问 | `/results/<code>` | | |

## 2. 开演（T-10 min）

1. Live 启动 `judging` + `rehearsal` session。
2. 确认回合 `scoring`、评委组 expected/minimum 正确。
3. 每位评委用自己的链接认领座位；确认 `judge/context` 显示当前选手。
4. 打开第一位选手的表演；确认评委页出现 rubric。

## 3. 演出中

- 每表演结束：评委提交 → Live 的 `scoreCount/expectedJudges` 增长。
- 评分进度不足时不锁表演；HOLD/同分按评审规则处理。
- 网络异常：
  - 评委页轮询失败 → 刷新；仍失败 → staff 用 `staff_rapid` 代录；
  - Live 实时通道断开 → 页面自动 5s 轮询，不阻塞操作。
- 录分错误：锁表演前直接改；锁后走 `correction`，必须填原因。

## 4. 收尾

1. 全部表演锁表演 → 锁轮。
2. `生成排名`；检查 status READY/HOLD 与同分。
3. 正式赛才进入 publishing：podium → confirm → release；彩排不发布。
4. 关闭 session；如需归档，先 close activity 再 archive。
5. 记录彩排结果与偏差。

## 5. 异常与回滚

- 彩排期间禁止切正式入口；彩排不产生正式结果。
- 若在正式活动中发现问题：
  - 先冻结写入并记录时间；
  - 未产生正式 v2 写入 → 可按 cutover runbook 回滚；
  - 已产生正式写入 → 只前进：修正、撤销/重发结果，或按事件记录人工重建。
- 评委链接泄漏：重签 capability（旧链接立即失效），不要关闭整个入口。

## 6. 彩排记录表

| 时间 | 检查/操作 | 执行人 | 结果 | 偏差/跟进 |
| --- | --- | --- | --- | --- |
| | | | | |

彩排结束后把偏差分为：配置/操作问题、已知缺口（见
`shape-validation.md`）、需要新 slice 的问题。
