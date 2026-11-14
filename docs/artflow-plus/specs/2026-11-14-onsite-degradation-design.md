# 现场降级设计（直接沿用 v1）

- **Status**: proposed
- **Date**: 2026-11-14
- **Scope**: v2 现场执行（签到、评分、投票、结果）在设备/网络/服务故障下的降级与恢复
- **v1 依据**: 源码与运行手册保存在 tag `v1.0.2`；本文只引用，不重新发明

## 1. 目标

v1 已经用真实十佳决赛验证过一套降级模型：**服务端始终是权威；实时通道只是增强；
现场故障时人继续用纸面/手工流程，恢复后带来源、原因和操作员补录。** v2 直接采用
这套模型，不引入浏览器离线写队列、客户端数据库或冲突合并协议。

验收目标：出现可预期的局部故障时，活动可以继续或明确 HOLD，正式事实不被污染，
事后能从审计还原“谁在什么时候用什么来源补了什么”。

## 2. v1 已经证明的做法

| 场景 | v1 做法 | 证据（tag `v1.0.2`） |
| --- | --- | --- |
| 实时通道失效 | Redis/WebSocket 只做通知；回退 HTTP/polling，权威流程仍可完成 | `docs/diagrams/05-deployment-and-fallback.workflow.json`；`docs/production-rehearsal-runbook.md` 第 17 项 |
| 检票扫码不可用 | 三级降级：HTTPS 实时摄像头 → 拍照后前端解码 → 手工输入票据码或完整链接 | `docs/deployment-event.md` §LAN HTTP 下的检票 |
| 重复扫码 | 返回 `already_checked_in`，门口显示“成功 / 已检票 / 无效”三态，不把第二次扫码说成新的成功 | `tickets/services.py::check_in_ticket_outcome` |
| 手工码异常 | 非 ASCII 手工码返回明确拒绝，不是 500 | `tickets/tests.py` 手工码用例 |
| 评委评分降级 | `direct_judge` / `staff_rapid` / `staff_proxy` / `paper_dr` 四种来源；纸面条目必须带 `paper_reference` 与原因，审计动作 `JUDGE_SCORE_PAPER`，客户端不能自选来源 | `singer_contest/judge_authority.py::submit_paper_score`；`singer_contest/models.py::ScoreSource` |
| 观众票降级 | 人工核验成绩作为独立来源（`paper_tally` / `manual_other`），必须记录来源备注 | `singer_contest/models.py::AudienceScore` |
| 签到窗口 | `CHECK_IN` / `MANAGE_TICKETS` 由中心 phase policy 决定，不在页面各判一次 | `core/policies.py` |
| 恢复 | 只有 Admin 批准；先保全证据，恢复后跑迁移/检查/健康检查/事实计数比对，再由业务负责人放行；禁止 `down --volumes` 或 reset 源库 | `docs/incident-response.md`；`docs/production-rehearsal-runbook.md` |

v2 已具备对应基础：`competition` 的 `ScoreSourceSchema` 已包含 `paper_dr` 与
`sourceReference`；`attendance.checkin` 已对重复签到返回 `ALREADY_CHECKED_IN`；
实时通道仍只做失效提示，HTTP 是恢复权威。

## 3. 决策

1. **v2 不实现离线写队列。** 现场断网时不在浏览器里累积“待同步命令”，因为这会引入
   来源不明、时钟偏差、重复事实和冲突合并，且违反 v2 的单一写路径与 mode 隔离。
2. **降级 = 纸面/手工继续，恢复后补录。** 补录必须经过正式命令，带来源、来源引用、
   原因和操作员；系统按来源区分事实，不让纸面数据冒充 direct judge。
3. **降级矩阵按 capability 声明，不由页面临时决定。** 每个能力说明：正常路径、可降级
   动作、HOLD 条件、补录来源。
4. **恢复是显式操作。** 只有 `account.manage` / 结果管理权限的负责人能批准恢复；
   恢复前后必须做事实计数与审计抽样比对。

## 4. 降级矩阵

| 能力 | 正常路径 | 可降级路径 | 必须 HOLD / 禁止 | 恢复补录 |
| --- | --- | --- | --- | --- |
| 检票 / 签到 | 实时扫码或 Ops 手工码 | HTTPS 摄像头 → 拍照解码 → 手工票据码；服务不可用时纸质名单记录批次/序号、签到点、时间、操作员 | 无法确认票据状态时不得口头放行并标记“已检” | 重新上线后逐条 `attendance.checkin`，备注纸面引用；重复签到显示 `ALREADY_CHECKED_IN` |
| 评委评分 | `direct_judge` | `staff_proxy`（代录）→ `paper_dr`（纸面评分表） | 没有纸面编号/原因/复核人的条目不得入库；不得补 0 | `paper_dr` + `sourceReference` + 原因；重复或错轮次转人工复核 |
| 观众投票 | 服务端 VoteSession | 无离线投票 | 服务不可用时关闭/暂停场次，不伪造选票 | 不补录选票；如需人工统计，必须作为独立来源并明确标注，不能回填成观众原始票 |
| 结果发布 | 服务端候选与核定 | 无纸面结果 | 事实未恢复、计数未比对前不得确认/发布 | 先恢复事实与排名，再重新 resolve/确认；不复用旧候选 |
| 排期 / 任务 / 事故 | Ops 页面 | 纸质节目单、纸质事故记录 | 不得用截图代替事故记录 | 恢复后按正式命令补录，保留纸面编号与操作员 |

## 5. v2 待实现的最小改动

设计本身不要求新子系统；以下是为落实矩阵需要的最小代码改动：

1. **签到补录字段**：`attendance.checkin` 增加可选 `source`（`direct` / `manual_paper`）
   与 `sourceReference`（纸面编号/批次），或明确以 `note` 承载并限制格式。首选显式
   字段，避免“备注里找引用”。
2. **门口三态**：Ops/Live 签到结果明确区分“成功 / 已检票 / 无效”；`ALREADY_CHECKED_IN`
   必须显示首次签到时间，而不是笼统报错。
3. **纸面评分入口**：确认 Live 的 `paper_dr` 表单强制要求 `sourceReference` 与原因，
   并在读面显示来源徽标。
4. **恢复检查单**：在 `docs/artflow-plus/rehearsal-runbook.md` 增加“故障后恢复”章节，
   列出计数比对、审计抽样、放行人。
5. **不做**：离线队列、浏览器本地事实、自动冲突合并、客户端时钟作为权威。

## 6. 恢复授权与证据

- 批准人：`account.manage` 或结果管理负责人；恢复动作写审计。
- 恢复前：停止受影响的评分/投票/发布窗口；保全数据库、媒体、纸面记录；
  记录 commit、环境、活动、时间线。
- 恢复后：迁移检查、健康检查、事实计数（签到/评分/选票/发布）与纸面记录比对，
  审计抽样，再由业务负责人放行。
- 禁止：`down --volumes`、drop/reset 源库、用“重启即修复”代替根因处理。

## 7. 演练与故障注入

按 v1 的 18 项验收清单裁剪为 8 个可复现场景：

| ID | 场景 | 断言 |
| --- | --- | --- |
| DEG-01 | 停止实时通道，继续 HTTP 评分/签到 | 权威流程完成；只有通知缺失；恢复后投影追平 |
| DEG-02 | 手机摄像头不可用，改拍照解码 | 同一票据只产生一次签到；重复扫码显示已检 |
| DEG-03 | 完全断网，纸面签到 10 条，恢复后补录 | 10 条事实带来源/引用；无重复；计数与纸面一致 |
| DEG-04 | 评委纸面评分后补录 | `paper_dr` + `sourceReference` 必填；重复/错轮次被拒 |
| DEG-05 | 服务重启中提交签到/评分 | 客户端得到明确失败；重试同 `commandId` 只产生一份事实 |
| DEG-06 | 两设备同时扫同一张票 | 一次成功、一次已检；不产生两条 checkin 事实 |
| DEG-07 | 投票服务不可用 | 场次进入 HOLD/关闭；无伪造选票；恢复后不自动补票 |
| DEG-08 | 恢复后继续用旧页面/旧 revision | stale 拒绝；必须刷新后重新操作 |

## Test architecture

- **Contracts / capabilities**：复用 `attendance`、`competition`、`voting`、`publishing`
  现有契约；只扩展签到来源字段与读模型，不新增 capability。来源字段进入共享
  `packages/contracts`，不在路由里另造形状。
- **Consumers / read models**：受影响的是 Ops 签到卡、Live 评分面板、结果发布读面与
  `consumer-graph` 中的 `AttendanceCheckedIn` / `JudgeScoreSubmitted` 边；任何新的
  降级读模型必须可发现或显式声明。
- **Lifecycle edges**：签到只有 `not_checked_in → present → undone`；重复签到返回
  `ALREADY_CHECKED_IN`，不得写第二条事实；纸面补录与直接录入共用同一命令与终态。
- **Adapters**：契约测试复用现有 attendance/competition adapter；补录来源作为
  descriptor 字段加入，不复制生命周期模板。
- **Fault injection**：DEG-01…DEG-08 通过依赖注入/时钟/故障 seam 控制，不引入
  sleep；每个用例断言故障期间行为与恢复后最终状态。
- **Anti-bloat**：不新增离线队列、不同步协议、不复制测试模板；只加来源字段与
  runbook。新增抽象必须先用一个真实缺陷证明其必要性。
- **Gates**：`pnpm -C plus run check`、`test`（`REQUIRE_DB=1`）、`graph:check`、
  `audit:check`、`schema:check`、`uv run pytest tests/gates -q`、`check_docs`，
  以及针对 DEG-01…08 的数据库/浏览器用例。

## 8. 非目标

- 不做浏览器离线写、离线投票、离线结果确认；
- 不把纸面数据自动升级为 direct judge/观众原始票；
- 不实现多设备自动冲突合并；
- 不把“重启/清库”当作恢复手段。
