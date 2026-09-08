# M2-C2 Staff Judge Control Surface

状态：设计已获批准，待实现

## 目标

让普通文艺部工作人员可以在一个受保护的后台页面完成一轮比赛的现场评委控制：确认实际到场评委、建立 Panel、签发一次性 Judge QR、切换当前演出、暂停/恢复现场，以及在评委终端不可用时使用 STAFF_PROXY 或 PAPER_DR 代录评分。

本阶段不改变 M2-C1 的 Panel authority 模型，不实现 Judge 端轮询、分项评分或学校 SSO。

## 权威边界

- `RoundJudge` 是预备评委名单；页面的到场选择只能来自当前轮次的 `RoundJudge`。
- `prepare_judge_panel()` 是建立正式 Panel 的唯一写入口。Staff view 不直接创建或更新 `RoundPanelSnapshot`、`RoundPanelSnapshotMember` 或 `JudgeSeat`。
- `issue_judge_grant()` 是签发 Judge QR 的唯一写入口。明文 grant token 只进入当前 HTTP 响应中的 QR 内容，不写数据库、不写日志、不放入 Django message 或错误文本。
- `advance_performance()`、`hold_performance()`、`resume_performance()` 是演出上下文的唯一写入口。
- `hold_judge_panel()`、`resume_judge_panel()` 是 Panel 暂停/恢复的唯一写入口。
- `submit_staff_proxy_score()` 和 `submit_paper_score()` 是 STAFF_PROXY / PAPER_DR 的唯一写入口；页面必须提交当前 `context_version`、`performance_id`、`seat_id`、来源参考和原因。
- 任何失败都使用已有 service 的事务和错误语义；页面不能捕获错误后继续执行下一步。

## 页面与路由

新增 Staff 页面与 POST action，全部使用 `staff_required` 和 CSRF：

| 路由 | 方法 | 用途 |
| --- | --- | --- |
| `/staff/judges/round/<round_id>/control/` | GET | 现场控制台 |
| `/staff/judges/round/<round_id>/prepare/` | POST | 提交实际到场评委并准备 Panel |
| `/staff/judges/round/<round_id>/panel/hold/` | POST | 暂停 Panel |
| `/staff/judges/round/<round_id>/panel/resume/` | POST | 恢复 Panel |
| `/staff/judges/round/<round_id>/performances/advance/` | POST | 切换当前演出 |
| `/staff/judges/round/<round_id>/performances/hold/` | POST | 暂停当前演出 |
| `/staff/judges/round/<round_id>/performances/resume/` | POST | 恢复当前演出 |
| `/staff/judges/round/<round_id>/seats/<seat_id>/qr/` | POST | 为有效席位签发 QR |
| `/staff/judges/round/<round_id>/scores/proxy/` | POST | Staff 代录评分 |
| `/staff/judges/round/<round_id>/scores/paper/` | POST | 纸面评分录入 |

POST 成功后使用 PRG 回到控制台；QR 签发成功时在当前响应中显示二维码和短暂有效提示。刷新页面不得再次签发授权。

## 控制台信息

页面必须展示非敏感运营事实：

- 活动、轮次名称、轮次状态和当前 Panel 状态；
- 预备评委名单，每人显示到场选择状态；
- `expected_judge_count`、`actual_judge_count`、`minimum_judge_count`；
- 当前 Panel 成员、席位状态、授权是否仍有未兑换 grant；
- `PerformanceRunState`：当前演出、演出状态、`context_version` 和 hold reason；
- 按 `Performance.sequence` 排序的可切换演出列表，显示选手姓名、曲目标题和演出状态；
- 最近一次 action 的成功或通用失败提示。

当前不存在正式 Panel，或实到人数不足最低人数时，控制台必须显式显示 `INSUFFICIENT_JUDGES / HOLD`，禁用签发 QR、切换演出和录分控制；不得显示“可以开始评分”。不足人数不会创建 ACTIVE Panel 或 PerformanceRunState，Staff 补充到场选择后可重新提交准备。

## 现场操作契约

### 准备 Panel

- 仅允许非 DRAFT、非 LOCKED 轮次；实际到场 ID 必须是唯一整数集合。
- 不足最低人数时保持 fail-closed，显示 `INSUFFICIENT_JUDGES / HOLD`。
- 达标后页面显示正式 Panel 的 expected/actual/minimum 和席位；后续矩阵由该快照决定。

### 签发 Judge QR

- 只允许 ACTIVE Panel 且 `JudgeSeat.State.ASSIGNED` 的席位。
- 一个席位存在未兑换且未过期 grant 时拒绝再次签发。
- QR 目标为 Judge terminal 路由的 fragment；明文 token 不进入页面普通文本、日志、审计字段或 URL query。
- QR 生成在内存中完成，使用现有 `qrcode` 依赖，不新增持久化二维码模型。

### 演出切换与暂停

- 切换演出只接受属于当前轮次和活动的 `Performance`。
- `advance_performance()` 负责递增 `context_version`；当前演出改变时所有 Judge client 必须通过已有 context 语义感知变化。
- Panel 或演出处于 HOLD 时，QR 签发和评分 action 均被拒绝；恢复必须使用对应 authority service。

### STAFF_PROXY / PAPER_DR

- 两类表单都必须绑定当前 `context_version`、`performance_id` 和有效 `seat_id`。
- `STAFF_PROXY` 必须有代录参考和原因；`PAPER_DR` 必须有纸面参考和原因。
- 统一显示“评分未被接受”的安全错误，不回显 token、完整评分 payload 或内部异常；service 的稳定 reason code 用于定位 `STALE_CONTEXT`、`ROUND_ON_HOLD`、`DUPLICATE_SCORE_FACT` 等现场问题。

## 安全与一致性

- 所有 POST 使用 CSRF；不新增 `csrf_exempt`。
- 所有对象 ID 经过 service 的轮次、活动、Panel、seat 交叉校验；不能通过替换 URL 中的 round/seat/performance ID 跨活动或跨轮次操作。
- staff 权限只允许操作 Staff 可见的运营数据；Judge bearer token 不暴露给 Staff 页面以外的普通文本响应。
- 失败 action 不得部分写入；所有写入由现有 `transaction.atomic` service 完成。
- 页面是 server-rendered，浏览器脚本不是 authority；本阶段不依赖 JavaScript 才能完成关键控制。

## 验收标准

1. Staff 可以在五人预备名单中选择四人到场（最低四人），准备出四席 ACTIVE Panel。
2. 三人到场时显示 `INSUFFICIENT_JUDGES / HOLD`，不能签发 QR、切换演出或录分。
3. 每个 ACTIVE 席位可以签发一个短期 QR；重复未兑换签发被拒绝，QR 不泄露明文 token。
4. Staff 可以切换当前演出，`context_version` 单调递增，非法演出 ID 被拒绝。
5. Staff 可以 HOLD/resume Panel 和当前演出；HOLD 时评分服务拒绝写入。
6. Staff_PROXY 和 PAPER_DR 成功写入正确 `ScoreSource`、Panel、seat、context 和审计记录；重复命令幂等，过期 context 失败。
7. 页面访问、跨轮次 ID、CSRF、权限、异常路径均有回归测试。
8. Django、Pyright、client、PostgreSQL 和 Playwright 相关门禁保持通过。

