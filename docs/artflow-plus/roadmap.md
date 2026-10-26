# ArtFlow-Plus 路线图

状态：规划基线（2026-10-19）。产品与架构身份的权威是根目录 `GOAL.md`；本文件
只把它拆成可交付的 vertical slices。每个里程碑的出口条件都是可执行的
（测试/golden/门禁），不是“代码写完了”。

## M0 — Legacy Extraction（已完成）

- 54 条领域不变量：`docs/invariants/`。
- 497 条 fix 的经验与事故库：`docs/artflow-plus/analysis/`、`docs/incidents/`。
- 6 个 golden fixtures + v1 适配器（结果发布生命周期）。
- 6 组结构门禁 + Gates CI。
- 时代边界：`main` = 1.x，`artflow-plus` = v2。

**出口**：Gates 在 `artflow-plus` 常绿；golden 结构校验通过。

## M1 — Engine Kernel（已完成）

- 薄 Activity：DRAFT → ACTIVE → CLOSED → ARCHIVED；enabled capabilities；
  active definition version。
- Definition Draft → Activity Definition Package（manifest + capability
  definitions + bindings）→ 每个 capability 自己的 compiler → Activity
  compiler 协调 → 不可变 Release。
- `CapabilityDefinition` 对 Activity 编译器不透明（ADR-0010）：payload +
  注册的 capability compiler；比赛 DAG 已移入 `capabilities/competition.ts`。
- Execution Session：activity + release + scope + mode；一个 activity 可并行
  多个 scope；冲突策略由组合提供；TEST/REHEARSAL 与 FORMAL 在冲突 scope 上
  不能重叠。
- 领域错误码、OCC、冻结、单 scope 运行、Activity 关闭前必须关闭 sessions。

**出口**：领域测试覆盖上述规则；`pnpm -C plus run check/test` 常绿；Vitest +
fast-check 已迁移，属性测试覆盖 hash 稳定性、陈旧 revision、closed/archived
活动、同 scope 双 session、scope 冲突隔离。

## M2 — Capability Composition 与 Activity Packs（已完成，2026-10-19）

- 工具链：`packages/contracts`（TypeBox/JSON Schema）、`apps/api`（Fastify 5 +
  OpenAPI）、`packages/db`（Kysely + module-owned migrations）。
- Capability 注册表（`plus/packages/domain/src/registry.ts`）：identity/version/
  dependencies/conflicts/definition contract/commands/queries/events/permissions/
  surfaces；组装期拒绝重复 identity、compiler 错配、未知依赖与自引用。
- Activity Pack（`packs.ts`）：Singer Competition Pack 等组合与默认值；Guided
  Mode 问题映射到 capability；Pack 只产出 Definition Package，不是 Activity
  子类。
- 组合校验：依赖传递展开；禁用仍被依赖的 capability、互斥 capability、未知
  capability 都产生带 code/path 的诊断；scope 冲突策略由参与组合的 capability
  合并。
- 结构门禁 GATE-PLUS-BOUNDARY-01：capability 不得导入其他 capability 的内部
  文件或 persistence；engine assembly 不得硬编码具体 capability。
- API：`GET /api/capabilities`、`GET /api/packs`、
  `POST /api/packs/:id/instantiate`；未实现的 capability 以诊断返回，不生成
  半启用的占位 Pack。

**出口**：Singer Pack 在完整注册表上生成可编译的空定义；依赖/冲突诊断正确；
Gate 检查 capability 边界。真实 Registration 等 capability 仍按
M4-M7 分片实现；M2 当时的默认注册表只暴露 `competition`，已在 M4 更新为暴露当前
四个已实现 capability。

## M3 — Execution Runtime（已完成，2026-10-19）

- **Durable command**：receipt claim（payload hash / replay / conflict）、OCC、确定性 id，
  事实 + outbox + receipt 同一事务；定义 draft/compiled/release 与 execution session 全部
  持久化。
- **Outbox + worker**：outbox 升级为事件日志（envelope 字段、attempts、dead letter）；
  `FOR UPDATE SKIP LOCKED` relay；pg-boss 12 作为分钟级兜底 + 250ms 低延迟循环；
  `apps/worker` 独立进程。
- **投影与恢复**：`execution_projection(activity_id, mode)`；失败停批保持顺序；
  `rebuildExecutionProjection` 从事件日志重放；权威 session 列表与最终一致投影分离。
- **实时降级**：SSE `GET /stream`（Last-Event-ID、heartbeat）尾随事件日志；
  `GET /events?after=` 是权威恢复路径；SSE 失败不阻塞写。
- **正式/测试隔离**：mode 来自服务端 session；事件、投影、读路径均按 mode 分区。
- **骨架证明 E2E**：Pack → Activity → Compile/Release → 并行 scope → capability facts →
  投影隔离 → 重放 → 重启后一致（`apps/api/test/skeleton.test.ts`）。
- **门禁**：GATE-PLUS-BOUNDARY-01 扩展到 runtime/API/worker 不得直接 import 具体
  capability；CI `REQUIRE_DB=1` 使数据库测试不能静默跳过。

**M3 硬化（review 后补齐，2026-10-19）**

- Definition Release 冻结 execution policy / capability versions / bindings；启动只读
  release 快照，版本或 scope 不匹配即拒绝。
- relay 按 `(activity_id, mode)` 分区 + advisory lock；投影 CAS；死信把分区置为
  BLOCKED，后续事件不得越过，operator 可 retry/rebuild。
- 所有 registry/compiler/domain 校验移到 receipt claim 之后，严格 replay。
- 删除 `saveActivityWithRevision` 第二写路径；结构门禁禁止 API/worker import DB mutator。
- 真实双连接测试：同 scope、冲突 scope、同 command id retry、并发 relay。
- `/readyz` 检查 PostgreSQL 与迁移；SSE 轮询不重叠。

**出口**：多个 scope 并行；冲突策略生效；恢复后状态一致；事件可重放。真实
Evaluation/Voting 等 capability 仍由 M5-M7 实现。

## M3.5 — Actor / Audit Foundation（已完成，2026-10-19）

- `ActorContext`（actorId/actorType/roles/permissions/authContext）由 transport 注入，
  绝不从请求 body 读取；M3 默认显式 system actor，测试可注入。
- 每个被接受的 command 在同一事务内写 `audit_entry`；receipt 与 outbox 记录
  actor_id/actor_type；replay 不重复审计。
- 认证 provider（本地会话/SSO）仍可后置，但 M4-M7 的命令从第一天起就带 actor。

**出口**：ADR-0012；M4 的 Registration 命令不需要再横向补 actor/audit。

## M4 — Registration / Questionnaire / Materials（已完成，2026-10-19）

- **前置**：第一个真实 capability command 落地前，必须把本地会话派生的 ActorContext 与
  命令级权限检查接上（M3.5 只固定了 actor/audit 数据模型，ADR-0012）。
- 报名 DRAFT→OPEN→REVIEW→FINAL；问卷版本与文件槽位；材料 metadata、所有权与审核
  权威已完成，实际字节存储/受控媒体网关留给后续媒体 slice。
- 名单 FINAL/UNKNOWN；执行边界 fail closed。
- 从 v1 导入历史报名（可重放）。

- 本地 session 登录与 bearer actor 派生已接入 M4 HTTP 写路径；权限在 command
  handler 内检查，actor 不从 body/header 自定义字段读取。
- `registration`、`roster`、`material` 由 `0005_registration_materials` 持久化；
  当前状态与 durable receipt/audit/outbox 在同一 command 事务内提交。
- `tests/golden/unknown-roster.json` 已由 Plus runtime adapter 消费；名单未知时
  `prepareCompetitionRound` 返回 `ROSTER_UNKNOWN` 且事件/receipt 无副作用，最终化
  后按服务端 approved registration 数量准备轮次。

**出口**：已满足：`unknown-roster` golden；文件所有权/审核回归；名单未定时执行拒绝。

## M5 — Competition / Evaluation / Podium（已完成，2026-10-19）

`Evaluation` 是领域语义，不是单独 registry capability；当前由 `competition`
capability 统一拥有评委、评分、排名与 podium 的事实和命令。

- 轮次、评委组、席位、表演评分门和锁定状态均由 Competition capability 自有
  projection 管理；round/panel/performance 使用 PostgreSQL 锁顺序与 CAS。
- direct judge、staff rapid、staff proxy、paper recovery 共用一个 score fact 唯一键；
  代录/纸面要求来源编号与原因，编辑保留 immutable revision，纠错以 fingerprint
  绑定的 open → revise → close → recalculate saga 完成；performance context
  递增时只退役旧 current facts，不改写历史，随后必须重新锁轮与 resolve。
- Ranking 从 frozen score snapshot 确定性计算；同分保持 HOLD，晋级跨 cutoff 必须
  显式 tie decision；podium 从 frozen release 推导完整必需轮次并记录每轮
  source score version，仅产出 candidate，不物化 Award 或 confirmed result。

**出口**：`duplicate-score-fact` golden adapter；score fact 与 panel activation 的
真实 PostgreSQL 双连接并发；纠错链 E2E；resolution fingerprint / tie HOLD / podium
candidate 定向测试。

## M6 — Voting / Ticketing（功能完成；M6.5 authority hardening 已完成，2026-10-19）

M6.5 收尾语义：voting artifact 采用 v2；旧 release 重新发布前不能新开场次；closed
tally 使用单一 PostgreSQL snapshot；评分和票数百分比的 authority decimal 以 canonical
string 保留；0011 回滚恢复旧 identity constraint。

- 投票场次、ballot 唯一性、成绩组成规则快照均绑定 execution session 的
  frozen definition release；运行中禁止换版，ballot/close 会拒绝 stale release。
- 票据使用 redeemed ticket access session，judge scoring 使用 HttpOnly judge
  session；原始 token 不进入 ballot payload、receipt 或 audit。投票 session 冻结
  `identityPolicy`，正式计票排除 revoked/expired ticket ballot；无有效票据时
  `score_component` 保持 HOLD。
- voting capability 不静态依赖 ticketing；仅 `identityPolicy = ticket` 的组合要求
  ticketing。评委分数、平均值、排名比较与投票百分比使用 Decimal.js + PostgreSQL
  numeric 的 `ROUND_HALF_UP` 语义。
- 默认 `MemoryRateLimiter` 是单进程 IP bucket，不是多 worker 全局限流；生产多实例
  必须接共享 Redis/PostgreSQL/gateway 限流器。
- Live 投影与降级保留；ticket/judge 终态迁移显式拒绝重复副作用。

**出口**：`capability-reissue-close` golden；重复投票/重放/跨活动拒绝；
ticket redemption、ballot uniqueness、judge-seat claim 的真实 PostgreSQL 双连接
并发测试；release/session stale-context 与状态迁移回归。

## M7a — Publishing / Results（已完成，2026-10-26）

- `publishing` capability：核定、解锁、release snapshot、撤销/替代、唯一公开 selector。
- 公开出口 `GET /api/public/results/:publicCode`；staff 状态出口与五条写命令。
- `result-release-lifecycle` golden 已由 Plus adapter 消费。

**出口**：发布/撤销/再发布/解锁生命周期、公开 selector、并发与审计测试全绿。

## M7b — Archive（已完成，2026-10-26）

- `archive` capability：本地卷 ZIP 包（JSON + CSV + README）、密封版本、SHA-256、
  受控下载；strict fail-closed 归档闭环；独立 unarchive。
- 活动补齐 `close` / `rename`；ARCHIVED 是终态，归档后修改返回 `ACTIVITY_ARCHIVED`。
- publishing 改为 formal-only；legacy 无 snapshot 的 ACTIVE release 不出现在公开 selector。
- `archive-identity` golden 已由 Plus adapter 消费。

**出口**：归档/解归档/重归档、完整性校验、并发归档、ZIP 白名单与 legacy snapshot 全绿。
registration/material/vote/score 的 mode 缺口留给后续 hardening。

## M8 — Product Surfaces 与 Cutover（进行中）

- Studio/Ops/Live/Portal 四个产品面按 capability 贡献组装。
- 按入口切换 v1 → v2；双环境并行验证。
- 数据导入/对账；回滚开关；操作手册。
- v1 只读保留窗口结束后再删除。

### M8a — Web Shell + Portal（已完成，2026-10-26）

- `apps/web`：React 19 + Vite 8 + TanStack Router/Query；Afterglow shader hero。
- 公开结果页消费唯一 selector；loading/404/空态/错误态；移动端与
  `prefers-reduced-motion` 回退。
- Playwright E2E 使用独立 `artflow_e2e` schema；Gates 增加 `web-e2e` job。

### M8b — Ops + Participant Portal（下一 slice）

- 登录、报名、问卷、材料、名单审核与参与者入口。
- 需要先定义认证/会话在 web 层的边界，并与 M8e 的 mode hardening 对齐。

**M8 出口**：关键旅程 E2E；迁移报告；回滚演练；现场彩排通过；至少三个结构不同
的活动（judged singing competition、stage show、另一种比赛/复杂活动）证明
内核无需重写。

## Definition of Done（每个 slice）

1. 领域规则写入 `docs/invariants/`（新增或引用）。
2. 领域单元 + 至少一个反例；适用的 golden fixture 通过。
3. 结构门禁通过；没有新增 allowlist 例外。
4. 错误码/审计/权限齐全；没有跨 capability 直接表访问。
5. 部署影响已说明（迁移、配置、静态/媒体、回滚）。
6. 文档更新：capability、ADR（如改决策）、roadmap 勾选。

## 非目标（整个 v2.0）

- 多租户、计费、开放生态。
- 全量 UI 先行的重写；页面必须跟随 slice。
- 一次性删掉 v1；先证明没有入口指向它。
- 把非比赛活动强行塞进比赛 DAG。
