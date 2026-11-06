# ArtFlow-Plus 路线图

状态：**M0–M15.1 已完成**（2026-10-28）；生产 cutover 未执行。M13.3 补齐了
participant/material cutover：MaterialCheck 导入、补交 capability、原子上传、
生产媒体卷与 Unicode 路径；production cutover 以干净 baseline、自动化/隔离验收、
operational smoke 与 owner acceptance 为准。产品与架构身份的
权威是根目录 `GOAL.md`；本文件记录每个里程碑的可执行出口（测试/golden/门禁）
与证据。已完成里程碑的段落保留当时的实现描述，后续里程碑在其上覆盖。

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
Gate 检查 capability 边界。真实 Registration 等 capability 在
M4–M7 分片实现；M2 当时的默认注册表只暴露 `competition`，后续里程碑已扩展到
当前全部九个 capability。

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
  `GET /events?after=` 是权威恢复路径；SSE 失败不阻塞写。（M13 已退役 SSE，
  改为 `@artflow-plus/realtime` 的失效主题。）
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
- `/readyz` 检查 PostgreSQL 与迁移；SSE 轮询不重叠（SSE 已于 M13 退役）。

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

## M8 — Product Surfaces 与 Cutover 拓扑（已完成，2026-10-26）

> 完成的是四个产品面、切换拓扑与工具链；**生产接管流程**（v1 当前活动 →
> Plus 可运行活动）不在 M8，见 M13.1。因此 M8“完成”不等于 production cutover
> ready。

- Studio/Ops/Live/Portal 四个产品面按 capability 贡献组装。
- 按入口切换 v1 → v2；双环境并行验证。
- 数据导入/对账；回滚开关；操作手册。
- v1 只读保留窗口结束后再删除。

### M8a — Web Shell + Portal（已完成，2026-10-26）

- `apps/web`：React 19 + Vite 8 + TanStack Router/Query；Afterglow shader hero。
- 公开结果页消费唯一 selector；loading/404/空态/错误态；移动端与
  `prefers-reduced-motion` 回退。
- Playwright E2E 使用独立 `artflow_e2e` schema；Gates 增加 `web-e2e` job。

### M8b — Ops + Participant Portal（已完成，2026-10-26）

- Cookie + CSRF 登录、参与者自助账号、公开码入口、冻结问卷填写/保存/提交。
- Ops 活动列表、报名列表/详情、批准/需补充/拒绝、名单定稿。
- 材料只登记 metadata；字节网关仍留给媒体 slice。
- E2E：参与者报名 → Ops 审核 → 名单定稿。

### M8c — Studio（已完成，2026-10-26）

- Guided Pack 创建 + Expert Definition Package JSON 编辑、编译、发布。
- `studio.manage` 权限；engine mutation 路由改为请求 actor + 权限校验。
- Studio 状态读取、release 历史、按 declaredScopes 启动/关闭执行会话。
- E2E：创建 → 激活 → 编译 → 发布 → rehearsal 会话 → 关闭。

### M8d — Live + 评委入口（已完成，2026-10-26）

- `GET /api/activities/:id/live` 只返回比赛所需投影：config 回合/评分表/同分策略、
  运行中的 judging session、每回合 panel/seats/performances 评分进度、最新排名、
  最终名单。
- Live 控制台：启动/关闭 judging session、准备回合、激活评委组、从最终名单开表演、
  锁表演/锁轮、生成排名、生成评委入口链接。
- capability 评委入口：staff 重签 `J` capability → 评委认领 `judge_seat_grant` →
  HttpOnly `artflow_judge_session`；`GET /api/judge/context` 按 seat key 解析当前
  panel 与表演，评委直接写 `direct_judge` 分。
- SSE 只做失效提示，失败退化为 5s 轮询；events/execution-state 仍是恢复权威。
  （M13 已把失效提示迁移到实时核心。）
- E2E：启动会话 → 准备 → 激活评委组 → 开表演 → 生成链接 → 评委打分 →
  锁表演/锁轮 → 生成排名 → 关闭会话。
- 投票/票据 UI、现场大屏、导出、cutover 不在本 slice。

### M8e — Cutover

拆为四个子 slice：

- **M8e-1 模式加固（已完成，2026-10-26）**：score_fact / vote_session /
  ranking_snapshot 带 mode；正式读路径按 mode 过滤；非 formal 生命周期在 formal
  事实出现后被 `FORMAL_FACTS_EXIST` 拒绝；`reset-rehearsal` 清除非 formal 数据并
  把回合还原到 prepared。正式后排练改用活动副本。
- **M8e-2 v1 导入与对账（已完成，2026-10-26）**：v1 `export_plus_bundle` →
  v2 `activity.legacy.import`；单事务 + 对账，失败回滚；test 行跳过并计数；
  媒体只迁元数据；历史快照直接导入并可在公开页展示；无法表达的结构进入
  `unsupported`。ADR-0021。
- **M8e-3 入口切换与回滚（已完成，2026-10-26）**：Plus api/web 生产镜像
  （esbuild + nginx）、Compose `plus` profile、Caddy site profile 主域名整体
  替换、只读 smoke、cutover runbook、staff 账号 provision。回滚边界为首次 v2
  正式写入前；切后参与者只读。ADR-0023。
- **M8e-4 自动化三类活动验证（已完成，2026-10-26）**：新增 stage-show /
  review-awards packs，Pack 可携带默认 capability definitions；三条关键旅程
  （歌手赛、节目征集+归档、作品评审+发布）通过；自动化关键旅程与验证报告。
  当时的缺口（节目单公开页、纯投票发布、bracket、参与者账号）已明确记录；
  参与者账号随后由 M14.1 完成。ADR-0024、ADR-0035。

**M8 出口**：关键旅程 E2E；迁移报告；回滚演练；自动化/隔离验证通过；至少三个结构不同
的活动（judged singing competition、stage show、另一种比赛/复杂活动）证明
内核无需重写。

M8 出口证据（2026-10-26）：M8a–M8e 全部 slices 完成；E2E 覆盖注册/Studio/Live/
评委/导入赛果；M8e-2 导入报告与 M8e-3 runbook 提供迁移/回滚证据；三类活动
关键旅程见 `docs/artflow-plus/shape-validation.md`。原现场彩排 runbook 已退役，不再作为
cutover 前置条件。

## M9 — Grouping Capability（已完成，2026-10-27）

- 新 `grouping` capability：四态生命周期、append-only 成员历史、两种名单来源、
  材料窗口状态、release `groupCount` 校验、活动级消费保护。
- Ops 三步卡片（分组 → 确认 → 冻结），修正/取消/材料窗口收进「更多操作」。
- 归档阻塞与归档包 `grouping.json`/CSV；v1 导出与导入分组。
- 出口：domain/db/runtime/api/web E2E 全绿；GRP-01…09 写入不变量。

## M10 — Vote-Result Publishing（已完成，2026-10-27）

- `publishing` 解耦 competition，改为组合期要求 competition 或 voting。
- 新增投票赛果预览与 `publishing.vote_result.confirm`；tally 在确认时冻结。
- `vote-poll` pack；公开赛果百分比显示（`ResultDecision.unit`）。
- 出口：domain/runtime/api/web 测试与结构门禁全绿。

## M11 — Realtime Core and Voting UI（已完成，2026-10-27）

- 新 `@artflow-plus/realtime`：协议/服务端/客户端、核心门禁与 CORE.md。
- `voting:<activityId>` topic；Ops 投票卡片：会话编排、实时票数、发布投票结果。
- E2E 证明 WebSocket 实时更新与 REST 兜底。
- Live 控制台的 SSE 保持不动，后续单独迁移。

## M12 — Participant Vote Page（已完成，2026-10-27）

- 公开读 `/api/public/vote/:sessionId`（只 formal，无票数/身份）。
- `/vote/<sessionId>` 页面：browser/anonymous 投票、已投状态、ticket 明确阻断。
- Ops 卡片提供投票链接、复制与二维码。
- 出口：公开读测试、投票页 E2E、全量门禁全绿。

## M13 — Live on the Realtime Core（已完成，2026-10-27）

- `activity:<activityId>` 失效主题（outbox head），Live 页面改用实时模块。
- 删除 SSE `/stream` 与 `useLiveEvents`；保留 `/events` 作为恢复权威。
- 出口：topic 测试、`/events` 测试、Live E2E、全量门禁全绿。

## M13.1 — Cutover Adoption & Consumption Precision（已完成，2026-10-27）

- **历史导入与运营接管分离**：`import:legacy --mode historical` 保持只读快照；
  `--mode adoption --pack <id>` 走正常 Pack → Compiler → Release，冻结完整
  capability 组合、`commandScopes` 与 runtime contract v2。
- **接管只导入准备事实**：报名、名单、材料、分组与 prepared 回合；历史分数、
  选票与结果留在 v1，并在报告 `warnings` 中列出。
- **来源级消费**：评分只锁定依赖该回合的结果；票据吊销只 stale 实际投过票的
  vote session；未使用票据轮换、access session 撤销不 stale；分组修正只在
  结果命中受影响参与者时拒绝。
- **公开 selector fail-closed**：ACTIVE release 必须关联 confirmed、
  `source != null`、`stale_at == null` 的 StageResult。
- **Runtime contract v2**：没有 command ownership 的 release 在
  `startExecution` 直接 `RUNTIME_CONTRACT_MISMATCH`。
- **Cutover smoke 双 profile**：`historical` 验证公开历史结果；`operational`
  验证当前活动有 active release、capability 组合与 scopes，不要求尚未发生的
  正式结果。
- 出口：adoption 单测（启动 judging 会话 → 激活 panel → 开投票）、来源级消费
  测试、公开 selector 测试、全量门禁与 E2E。

## M13.2 — Semantic Adoption Closure（已完成，2026-10-27）

- **Adoption Definition 来自 bundle**：questionnaire、round keys/judge config/rubric、
  grouping groupCount、materials purposes、registration lifecycle、publishing
  stages 全部由 v1 事实生成，再走正常 Compiler → Release。
- **Canonical round identity**：adopted round id 使用 resolver 同一套
  `idFromCommand("round", "<activityId>:<roundKey>")`；真实 exporter 的 `round-21`
  可直接被 Live/resolver 使用。
- **Registration lifecycle**：release 冻结 `draft/open/review/final`；adoption 导入
  已截止活动为 `final`，`registrationOpen=false`，新报名返回 `REGISTRATION_CLOSED`。
- **媒体桥**：v1 exporter 记录 material 相对路径；Plus 通过只读
  `ARTFLOW_PLUS_LEGACY_MEDIA_DIR` 提供原文件；新上传字节落在
  `ARTFLOW_PLUS_MEDIA_DIR` 并经受控路由读取。
- **语义 readiness**：questionnaire keys、round keys、judge config、rubric hash、
  groupCount、material slots、registration lifecycle、publishing stages 全过的
  `semanticReady` 才为 true；blocking unsupported（multiple_rubrics/group_material）
  直接拒绝。
- **来源依赖 refs**：`round:` / `voteSession:` / `groupingStage:`，grouping 不再用
  参与者重合猜测消费关系；公开 selector 先按 stage 过滤再取 snapshot。
- 出口：真实 exporter 形状 fixture 跑通 adoption → 报名详情 → judging → score →
  lock → ranking → podium → confirm → release → public selector → 开投票。

## M13.3 — Participant & Material Cutover Closure（已完成，2026-10-27）

- **MaterialCheck 进 bundle**：v1 exporter 独立导出 `materialChecks`（含无
  SubmissionFile 的缺交项）；adoption 导入 `material_check` 并为每个 slot 生成
  真实 file question（purpose/扩展名/maxBytes），不再用 `document + */*`。
- **补交 capability**：staff 命令 `registration.supplement.issue` 绑定
  registration + allowedKeys 并签发一次性 token；REVIEW/FINAL 禁止新报名与普通
  编辑，只允许指定 slot 补交；公开 claim/context/upload/submit 端点让 v1 选手
  无需迁移账号即可补交。
- **材料原子上传**：metadata 只建 pending 行；bytes 落盘后才在同一事务退役旧
  current 并激活新行；内容失败时旧文件保持权威；approve 要求 content-ready；
  material_check 随上传/审核更新状态。
- **生产媒体**：compose 增加 `plus_media_data` 与 v1 `media_data:ro`，env 模板
  增加 `ARTFLOW_PLUS_MEDIA_DIR` / `ARTFLOW_PLUS_LEGACY_MEDIA_DIR`；传输上限
  128 MiB，领域策略仍是权威（stage-show 100 MiB）。
- **Unicode 路径**：media storage 接受中文文件名（NFC），只拒绝分隔符、控制字符
  与 traversal。
- **Readiness 命名**：`semanticReady` 只证明定义/事实兼容；生产 readiness 仍需
  activity acceptance journey 与 operational smoke。
- 出口：`material-cutover.test.ts` 覆盖 legacy 伴奏下载、缺交歌词、补交 capability、
  失败替换保留旧 current、成功替换原子切换、审核、提交、重启后两文件可读。

## M14 — Ticket-backed Voting（已完成，2026-10-28）

- 票据场次的公开投票页支持 URL fragment 与手工 credential 输入；兑换后只保留 HttpOnly
  ticket access session，原始 credential 不进入 ballot。
- 公共读返回非敏感的 ticketReady，并按有效 ticket session 恢复 voted 状态；无效、过期、
  撤销与跨活动 cookie fail closed。
- ticket ballot 继续复用既有锁内 submitBallot、ticket 状态和唯一约束；browser/anonymous
  投票路径保持兼容。
- 出口：API 公共读回归、Web API 测试、票据 fragment 与手工输入 E2E、browser 投票
  回归、Plus 类型与测试门禁通过；cutover 使用自动化/隔离证据。

## M14.1 — Participant Account Claim（已完成，2026-10-28）

- Staff 可为 active activity 中的 `legacy-user:*` 导入报名生成一次性认领链接；
  token 只存 digest，并受活动、报名、过期时间和一对一 identity link 约束；重新生成时
  撤销同一报名尚未消费的旧 token。
- 参与者通过 `/claim#...` 或手工粘贴 token 创建新账号或绑定已有参与者 session；fragment
  会立即从地址栏移除，原始 token、session token 和 `authContext` 不进入 JSON、receipt、audit
  或 outbox。复制链接在 Clipboard API 不可用时降级为选中文本复制。
- registration/material 的所有权解析同时支持本地 actor 与其唯一 legacy identity；
  导入的 `participant_id` 保持权威，不迁移旧密码、不删除 v1 源码或媒体。
- 出口：DB/runtime/API/Web 定向测试、Claim UI 测试和独立 Ops/参与者/重放
  headless Chromium E2E 通过。详见 ADR-0035。

## M15.1 — Activity Operations Analytics（已完成，2026-10-28）

- 新增只读 `analytics` read surface 与
  `GET /api/activities/:id/operations/analytics`，汇总报名、材料、名单、比赛、
  投票、赛果发布和归档的现有权威事实。
- 有效票数复用 ticket `redeemed` 语义；聚合查询不返回报名答案、评审备注、凭证、
  token、storage key 或 row-level identity，不新增可写 analytics 状态。
- Ops 活动详情增加只读准备度卡片和稳定 attention codes；提示项不参与 command gate，
  不替代 closure/resolver/archive authority。
- 出口：统计脚本单测、PostgreSQL 聚合/脱敏测试、runtime 权限测试、API 403/404 测试、
  Web 卡片测试、Plus 类型检查与全量 Plus 测试通过。

## M15.2 — Tasks / Readiness（已完成，2026-10-28）

- 新增可选、独立的 `tasks` capability：任务模板进入 Activity Definition Package，随
  release definition version 冻结；现有四个 Pack 默认关闭，显式启用时只接受同一组合中
  已启用的 source capability。
- `task_item` 以 `(activity, definition version, template key)` 版本化保存任务事实；同步
  幂等且不覆盖既有状态/负责人/截止时间/理由。任务命令沿用 receipt、Activity → task
  锁、OCC、audit、outbox 事务链，只改变任务 authority，不写报名、材料、比赛、投票、
  发布、归档或活动生命周期事实。
- 新增 protected `tasks` read surface：任务列表与 readiness 只读聚合 task rows，不成为
  第二 authority；新增 `tasks.sync/assign/start/block/complete/reopen` 命令及安全响应契约。
- Ops 活动详情增加任务清单与准备度卡片；仅 `tasks.manage` 显示 mutation controls，空模板、
  阻塞、逾期和 stale revision 均有明确 UI 行为。Realtime 只发失效通知，HTTP 仍是恢复权威。
- 出口：domain/DB/runtime/API/Web focused 与 Plus full check/build/test、结构门禁、文档门禁
  通过；没有真实活动彩排前置条件。详见
  [`M15.2 自建检查`](checks/2026-10-28-tasks-readiness-checks.md) 与
  [`M15.2 设计`](specs/2026-10-28-tasks-readiness-design.md)。

后续按顺序实现 M15.3 Check-in/Attendance、M15.4 Schedule/Program Release、M15.5
Incident/Recovery/Feedback；仍不把真实活动彩排作为验收前置条件。

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
