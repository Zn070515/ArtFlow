# ArtFlow-Plus M8d：Live 控制台 + 评委评分

状态：已确认（2026-10-26）
范围：staff Live 控制台（回合/评委组/表演/评分进度/锁轮/解析）、
capability 评委入口与评分页、SSE/HTTP 游标恢复。
非目标：公开投票/票据 UI（下一轮）、现场大屏、导出、cutover。

## 权限

- Live 读写：`competition.manage`、`competition.round.prepare`、
  `competition.score.write`、`judge.manage`（按命令各自校验）。
- `GET /api/activities` 列表额外接受 `competition.manage`/`judge.manage`，供 Live
  选择活动。
- 评委评分不需要本地账号：judge capability 认领后使用 HttpOnly
  `artflow_judge_session`；评委页不读取原始 token。

## 新增读端点

`GET /api/activities/:id/live`（competition.manage 或 judge.manage）：
- activity 摘要 + active definition version；
- 从 active release 的 competition artifact 取 `rounds/rubric/tiePolicy`；
- 当前运行中的 judging execution session；
- 每个配置回合：round 状态/revision/scoreVersion/currentPanelId、
  current panel（expectedJudges/contextVersion）、seats、performances
  （state/contextVersion/scoreCount/expectedJudges）、最新 ranking（如有）；
- 最终 roster 的 approved participant ids（用于开表演）；
- config 只返回比赛所需字段，不返回完整 release。

`GET /api/judge/context`（judge cookie）：
- seat/panel/round/open performance；
- rubric criteria、contextVersion、panelSnapshotId、seatId、roundKey；
- 该评委当前 score fact（如已提交）；
- 无 open performance 时返回 seat + null performance，供轮询。

## Live 控制台

- `/live` 活动列表；`/live/:activityId`：
  - 启动 judging session（scope=judging，mode=test/rehearsal/formal）；
  - 按 config 回合准备回合；激活评委组（judgeId/seatKey）；
  - 从 final roster 选择选手开表演；锁表演；锁轮；resolve；查看 ranking；
  - 显示每个表演的 scoreCount/expectedJudges；HOLD/tie 状态；
  - 生成评委入口链接 `/judge/<publicCode>?capability=<signed>`；
  - 关闭 session。
- SSE：订阅 `/api/activities/:id/stream?mode=...` 后失效 live 查询；失败时退化为
  5s 轮询；HTTP events/execution-state 仍是权威恢复路径。

## 评委页

- `/judge/:publicCode?capability=...`：
  - capability 认领（`POST /api/judge-entry/claim`）→ HttpOnly judge cookie；
  - 轮询 `/api/judge/context`；显示当前选手与 rubric；
  - 输入三项分数 + 备注 → `POST .../scores`（source=direct_judge）；
  - 已提交则显示分数并等待下一表演；错误/过期显示可操作提示。
- 不把 capability/session token 写入 localStorage；刷新后 judge cookie 仍在。

## 测试

- API：live state 权限/形状；judge context 无 cookie 401、认领后返回当前表演；
  评分写入后 state scoreCount 1；resolve 后 ranking。
- Web：Live 操作、评分表单、SSE/轮询。
- E2E：staff 启动 session → 准备回合 → 激活评委组 → 开表演 → 生成评委链接 →
  评委认领并打分 → staff 锁表演/锁轮/resolve → ranking → 关闭 session。
- Seed：active activity + competition release + approved registration + final roster；
  e2e admin 增加 competition/judge 权限。

## 边界

- 投票/票据入口不在本轮。
- 评委上下文只支持评委组/当前表演模型；多轮切换由 staff 控制。
- 内存限流器仍是单进程。
