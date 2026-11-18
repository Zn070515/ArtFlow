# Tournament / Teams 实施计划

状态：待评审（2026-11-18）

对应设计：[2026-11-18-tournament-bracket-design.md](../specs/2026-11-18-tournament-bracket-design.md)

## 总体顺序

先冻结契约与 schema，再按「Teams → elimination → 判定语义 → composite →
challenge → Pack/公开面」推进。每一片都必须先写失败测试，再实现，再跑聚焦
门禁；不把多片合成一次提交。

预计 6–10 周，按一个主开发 + review 的节奏。

## 决策默认值

在评审确认前，计划按以下默认值推进：

1. **首发包含 elimination 与 challenge**，但 challenge 排在 composite 之后；
   若时间收紧，challenge 可整体后移，前置切片不受影响。
2. **内部评分单元复用 `competition_round`**，新增 `kind` 列；不新建第二套
   评分表。理由：panel/performance/score fact/Decimal 核心已经过正式赛验证。
3. **公开 bracket 使用活动内页面**（`/bracket/<publicCode>`），不新建独立
   public activity 类型。
4. **Tournament Pack 提供两个 preset**：`tournament-elimination` 与
   `tournament-challenge`，共享同一 capability 组合。

## Slice 0 — 契约与 schema 冻结

- 新增 ADR-0047：对阵/复合分/Teams 的权威边界。
- 确认设计文档第 16 节的四个取舍。
- 写出 `teams` 与 `tournament` 的 capability 定义草案与命令/事件清单。
- 预先登记 contract adapter 的覆盖位置与 graph 预计新增节点。

出口：设计评审通过；ADR 合入；无代码实现。

验证：`check_docs`。

## Slice 1 — Teams capability

实现：

- `packages/domain/src/capabilities/teams.ts`：定义、compiler、empty definition。
- 迁移：`tournament_team`、`tournament_team_member`（partial unique index）。
- `packages/runtime/src/teams-service.ts`：创建/更新/增删队员/退赛/冻结/修正。
- API：`apps/api/src/routes/teams.ts`。
- Ops 队伍卡片；Studio `TeamsEditor`。
- contract adapter：`teams`。

规则：

- 参与者必须 approved；活动内一人一队；冻结名册整体成功或整体失败；
- roster correction 受 bracket 消费保护；
- 单写路径 + OCC + 审计。

出口：

- 同一参与者加入两队被拒；冻结后直接改名单被拒；修正需管理员与原因；
- 从 frozen grouping 导入的队伍与组员一致；
- 双连接并发修正只有一个成功。

验证：domain/runtime/db/api/web 测试；contracts；schema:check；graph:check；
结构门禁；E2E（建队 → 冻结 → 修正）。

## Slice 2 — elimination bracket core

实现：

- `packages/domain/src/tournament/bracket.ts`：
  - 标准 seed 顺序生成（2..64）；
  - bye 分配与首轮自动晋级；
  - match 树与 `next_match_id/next_slot`；
  - 输入 fingerprint。
- 迁移：`tournament_bracket`、`tournament_side`、`tournament_match`；
  `competition_round.kind`。
- `packages/runtime/src/tournament-service.ts`：create、lock、cancel；
  side snapshot；内部评分轮次创建。
- 所有 competition 轮次查询过滤 `kind = "bracket"`。
- Ops 赛事卡片：创建、种子预览、锁定、结构只读。
- contract adapter：`tournament`（先只覆盖 bracket lock 前状态）。

出口：

- 8 槽 6 人：2 个 bye 分配给最高种子，首轮无 bye 对 bye；
- seed 顺序对 2/4/8/16 与标准 bracket 一致；
- lock 后结构不可变；重复 side / 未 approved / 未冻结队伍被拒；
- 内部轮次不出现在 Studio 轮次列表与 podium。

验证：fast-check 生成器性质测试（场次数、每 side 恰好一个入口、冠军路径）；
domain/runtime/db/api 测试；schema:check；graph:check；E2E（锁定并生成首轮）。

## Slice 3 — 比赛判定语义

实现：

- `tournament.match.open` / `lock` / `decide` / `decide_tie` / `walkover` /
  `reopen` / `side.withdraw`。
- 复用 performance/score fact/panel；比赛 lock 只校验本场两侧。
- tie hold；decided 只读；reopen 级联。
- Live 比赛控制与 Ops 同源命令。
- contract adapter 扩展：完整 match 生命周期。

出口：

- 两侧正式分不等时 decide 成功；相等时返回 `MATCH_TIED`，必须显式 tie 决定；
- 缺一名最低评委时不能 lock，不能 decide；
- 退赛：未赛场次 walkover，已决场次保留，决赛退赛产生冠军；
- reopen 下游已 decided 默认拒绝，`cascade: true` 时按序回滚并审计；
- 两个管理员并发 decide 只有一个成功；commandId 重放幂等。

验证：contracts 生命周期模板；双连接并发；故障注入（锁分后上游更正、
reopen 级联、outbox 失败）；E2E（开赛 → 锁分 → 判定 → 修正）。

## Slice 4 — Composite

实现：

- `packages/domain/src/tournament/composite.ts`：
  - basis points 编译校验（合计 10000）；
  - 两位小数加权与二次量化；
  - 缺失分拒绝；tieGroup 复用 `computeRanking`。
- 迁移：`tournament_result`。
- `tournament.composite.preview/confirm`；fingerprint 与 stale。
- publishing 新增 `tournament_result` 来源与 stale supersede。
- Ops 复合分预览/确认；Studio 权重编辑器。

出口：

- 权重合计不等于 10000 在编译期被拒；
- 0.01 级别的边界与 ROUND_HALF_UP 有明确测试；
- 任一源轮次更正后 confirmed 结果变 stale，公开结果被 supersede；
- 缺失参赛者成绩返回 `SCORE_MISSING`，不按 0；
- 平局 hold，不自动破平。

验证：composite 性质测试（顺序无关、权重归一、量化边界）；
contracts（result 确认与 stale）；publishing 集成；E2E（权重 → 确认 → 更正）。

## Slice 5 — Challenge 模式

实现：

- `tournament_seat`、`tournament_challenger` 迁移。
- 从源轮次 finalize 的 advancement 生成席位与挑战队列。
- `challenge.select` / `pair` / `decline`；胜者继承席位。
- 挑战场 composite 判定（默认第一轮/第二轮权重，不含挑战场）。
- Ops 队列与席位卡；Live 当前挑战者提示。

出口：

- 队列顺序在 lock 后冻结；低排名先挑战；
- 席位只能被挑战一次；配对前 decline 不消耗机会；
- 勝者继承席位位置；五次机会后恰有 N 个唯一席位持有人；
- 挑战比分不进入最终冠亚季军复合分（除非规则显式加入）；
- 并发选择/配对只有一个成功。

验证：challenge 生命周期 adapter 分支；双连接并发；E2E（完整五次挑战）。

## Slice 6 — Tournament Pack、公开面与归档

实现：

- Pack：`tournament-elimination`、`tournament-challenge`，携带默认
  competition/grouping/teams/tournament/publishing 定义。
- 公开 `/bracket/<publicCode>`：只读已发布快照，未发布 404。
- 归档：`tournament.json`、`bracket.csv`、`matches.csv`；归档阻塞条件。
- Screen/Print 复用公开快照。
- README/roadmap/覆盖审计更新。

出口：

- 三个结构不同的活动仍可运行（歌手赛、节目征集、作品评审）；
- Pack 创建的活动无需手工配置即可走到 bracket lock；
- 公开页不泄露未发布对阵与内部评分；
- 归档包在 bracket running 时被阻塞，completed 后可导出；
- 全量门禁绿。

验证：全量 `pnpm run test`；Web E2E 全套；`graph:check` 0 unresolved；
`schema:check`；结构门禁；Golden；`check_docs`；`build:prod`。

## 每片的固定门禁

- 聚焦测试：domain/runtime/db/api/web/contracts 对应包；
- `pnpm -C plus run schema:check`（有迁移时）；
- `pnpm -C plus run graph:check`；
- `uv run pytest tests/gates -q`；
- `uv run python tests/golden/validate_fixtures.py`；
- `pwsh -NoProfile -File scripts/check_docs.ps1`（文档改动时）；
- `pnpm -C plus run build:prod`（切片合并前）；
- 涉及 UI 的切片跑对应 Playwright journey。

## 风险与缓解

| 风险 | 缓解 |
| --- | --- |
| 内部评分轮次污染 competition 读面 | `kind` 列 + 全查询过滤 + graph/回归测试 |
| reopen 级联产生半完成 bracket | 单事务、从下游到上游回滚、显式 cascade |
| composite 浮点/精度漂移 | 整数 basis points + Decimal + 性质测试 |
| Teams 与 grouping 双权威 | teams 只读 frozen grouping，不回写 |
| 公开页暴露未发布对阵 | 只读 published snapshot，API 层 404 |
| 切片过大 | 每片独立分支、独立 review、独立合并 |

## 完成定义

- 设计文档与 ADR 合入；
- 六个切片全部通过各自出口与固定门禁；
- 至少一条 elimination journey 与一条完整 challenge journey 在真实浏览器通过；
- 归档包包含对阵且可重放；
- 知识库记录 design/ADR/pitfall。
