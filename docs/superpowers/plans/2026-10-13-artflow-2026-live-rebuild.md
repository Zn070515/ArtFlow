# 2026-10-13 ArtFlow 现场赛制闭环改造计划

> **For the primary agent:** REQUIRED SUB-SKILL: use `superpowers:executing-plans` to execute this plan task-by-task. The repository explicitly forbids subagents; all work stays in this checkout.

**Goal:** 将 2026 校园十佳的第一轮、连续挑战和第三轮冠军赛接入 ArtFlow 的现有 authority、冻结规则、评分和材料体系，形成可正式彩排的闭环。

**Design source:** `docs/superpowers/specs/2026-10-13-live-competition-rebuild.md`，源意见为 `C:\Users\16275\Desktop\advices\ChatGPT.md`。

**Constraints:** 保留旧轮次兼容；所有跨模块事实只有一个 authority；命令具备版本校验和幂等；确认后的原始评分、配对、席位和结果不可由直接 ORM 写入绕过；不引入隐藏并列规则。

**截至 2026-10-14 的交付状态：** Task 0–7 已落地：评分完成策略/两位小数正式值、逐表演开分与迟交、官方选手编号 authority、Live Challenge 状态机、动态两人评分、材料投影和工作人员操作台均已接入。Task 8 的生产彩排手册已补齐，Django check、迁移检查、Ruff、Pyright 及现场赛制定向测试已通过；PostgreSQL、真实浏览器和 Compose 服务相关门禁仍需在对应环境执行后才能标记为完全验收。

## Task 0 — 基线、文档和配置审计

**Files:** `docs/superpowers/specs/2026-10-13-live-competition-rebuild.md`、本计划、`pyrightconfig.json`、`pyproject.toml`、`tailwind.config.js`、`tsconfig*.json`、`.env*.example`、忽略文件和 dependabot 配置。

**Steps:**

1. 固化业务规格与验收矩阵。
2. 对照生产模块和配置 include/src/content 做配置 sweep。
3. 运行基线：`uv run python manage.py check`、`uv run python manage.py makemigrations --check --dry-run`、相关 `singer_contest` 测试。
4. 记录不属于本阶段的既有问题，不把它们静默混入功能提交。

**Verify:** `git diff --check`、Django check、迁移检查、定向回归测试。

## Task 1 — 单一评分核心和最低有效评委数

**Files:** 新建 `singer_contest/scoring.py`；修改 `singer_contest/models.py`、`singer_contest/services.py`、`singer_contest/judge_authority.py`、`ruleset/resolver.py`；新增 `singer_contest/migrations/` 和评分服务测试。

**RED first:**

1. 测试 `90.005` 按 `ROUND_HALF_UP` 量化为 `90.01`，并验证汇总、规则解析和加权结果一致。
2. 测试 5 名评委/最低 4 人时不同选手可用不同 4 人；缺失不按 0 计算。
3. 测试达到最低人数时状态为可锁定而不是已锁定；人工锁定后拒绝新分。
4. 测试旧轮次仍要求完整矩阵，新增显式最低人数轮次才允许部分矩阵。
5. 测试相等正式成绩进入待人工处理，不按 `pk` 自动排序确认。

**Implementation:**

1. 在 `scoring.py` 建立 `quantize_official_score`、`official_average`、`official_weighted_score` 和 `ScoreCompleteness`，所有 Decimal 计算在此收口。
2. 为轮次/冻结面板增加明确的完成策略快照；旧数据迁移为完整矩阵，新赛制使用最低有效人数。
3. 修正 `prepare_judge_panel()` 读取配置的 `minimum_judge_count`；面板快照保存真实最低人数。
4. 修改 `_recalculate_round()`、`lock_round()`、resolver `_assess()` 使用同一策略和两位小数正式值。
5. 保留有效评分事实和面板/版本证据，不把缺失单元写成 0。

**Verify:** `uv run python manage.py test singer_contest`、`uv run python manage.py check`、`uv run python manage.py makemigrations --check --dry-run`、`npm run check:pyright`。

## Task 2 — 逐表演开分与迟交

**Files:** `singer_contest/models.py`、`singer_contest/judge_authority.py`、`staff_panel/views.py`、`staff_panel/urls.py`、`templates/staff_panel/judge_control.html`、`frontend/judge_terminal.ts`、相关测试。

**RED first:**

1. 开启 A 后推进 B，评委能补交 A，未开启 C 仍拒绝。
2. A 锁定后拒绝新评分；重复 `command_id` 返回原回执。
3. 当前/待提交列表随 HTTP authority 状态变化，不依赖 WebSocket。
4. 面板、席位、版本变化后旧请求得到明确 stale/panel changed 错误。

**Implementation:**

1. 增加逐表演开放/锁定 authority 记录或等价的冻结事实，`PerformanceRunState` 只负责现场游标。
2. `submit_judge_score()` 先解析回执，再锁定并重新检查面板、席位、表演开放状态和该表演版本；不能删除旧的上下文校验。
3. Staff 端展示“当前表演”和“已开启待提交”，裁判端一次扫码后可切换已有授权表演。
4. Redis/WebSocket 只发送通知，HTTP 服务是唯一权威。

**Verify:** 定向 judge authority 测试、`npm run check:client`、`npm run test:client`、Playwright 类型门禁。

## Task 3 — 官方选手编号和冻结控制

**Files:** `singer_contest/models.py`、服务、表单、管理页、迁移、测试。

**RED first:**

1. 同一活动官方编号唯一且不能靠 `pk` 推断。
2. 草稿可配置，冻结后普通 Staff 不能改；Admin 更正必须审计并触发下游保护。
3. 第三轮 roster/order 按官方编号升序，挑战胜者沿用被挑战席位。

**Implementation:**

1. 增加受控的活动内官方编号字段/映射及准备、冻结、管理员更正服务。
2. 将编号纳入规则/结果 fingerprint 和审计。
3. 替换第三轮排序中依赖 `pk`、报名时间或旧轮次顺序的路径。

**Verify:** model/service/permission tests、migration check、pyright。

## Task 4 — Live Challenge authority state machine

**状态：已完成。** 已实现独立会话、固定挑战队列、席位和配对 authority；命令幂等、revision、冻结规则/第一轮输入依赖校验、审计和 raw ORM 防护均已覆盖。

**Files:** 新建 `singer_contest/challenge_models.py` 或等价模型模块、`challenge_services.py`、迁移、admin、测试。

**RED first:**

1. 第一轮确认生成固定五人队列和十席位。
2. 只能处理当前 challenger；配对前放弃不消耗席位。
3. 已挑战席位、重复挑战者、非法阶段和空目标全部拒绝。
4. 两名工作人员并发选定/确认/判胜时最多一个正式结果。
5. 重试幂等；规则版本、第一轮结果或输入 fingerprint 变化拒绝旧挑战。

**Implementation:**

1. 建立 `ChallengeSession/Turn/Seat/Match`，关键唯一约束和状态约束在数据库表达。
2. 所有命令按 Activity → ChallengeSession → 当前实体顺序加锁，并使用 `command_id`、expected version、审计事件。
3. 实现开始选择、记录目标、确认配对、挑战者/守擂者结束、锁分、确认胜负、放弃和最终十强确认。
4. 结果确认原子替换席位并生成第三轮 roster 输入；弃权不伪造 score。

**Verify:** challenge service tests、PostgreSQL concurrency tests、permission/audit tests。

## Task 5 — 动态两人评分和结果闭环

**状态：已完成。** 每场挑战生成严格两人的动态评分轮次，双方独立开分、迟交、最低人数锁分，确认后原子替换席位；最终十强可以生成绑定挑战会话的第三轮名单。

**Files:** `singer_contest` scoring/roster services、`ruleset` compiler/resolver、`common` closure/fingerprint、迁移与测试。

**RED first:**

1. 每场挑战只创建两人评分单元，双方可独立达到最低人数并锁定。
2. 胜者继承 defender seat；五场后正好十名唯一持有人。
3. 第三轮只读取最终十席位，podium 只读取第三轮正式分。
4. 第一轮更正或已确认挑战撤销会阻止旧结果解锁绕过。

**Implementation:**

1. 让冻结规则声明挑战执行结构和当前两人单元，而不是把五场挑战伪装成完整 15 人 `ContestRound`。
2. 接入已有 `ScoreRecord`/panel snapshot/receipt 权限边界，确认比赛后禁止 raw ORM 变更。
3. 将 ChallengeSession 作为最终十强 authority 接入 StageResult/closure，并携带 result version/fingerprint。

**Verify:** full singer/ruleset/closure tests、PostgreSQL acceptance。

## Task 6 — 三轮材料和 Questionnaire 投影

**状态：已完成。** 已增加冻结时的 R2/R3 个人材料契约校验，并在 Staff 页面提供 R1 分组、R2 个人、R3 个人的完成度投影；文件写入仍复用原有 ImageField、sanitize 和材料 authority。

**Files:** `questionnaire/`、`files/`、`staff_panel/`、模板、测试和文档。

**RED first:**

1. 预先要求每人第二、第三轮材料；第一轮组内共享材料可见。
2. 材料检查按 R1 group/R2 personal/R3 personal 展示；未通过 ImageField/sanitize/upload authority 不能进入正式状态。
3. 受控补交保留历史和审计。

**Implementation:** 复用现有 questionnaire/material check projection，增加赛制目的键和工作人员进度汇总，不创建旁路文件字段。

**Verify:** questionnaire/file tests、docs check、staff tests。

## Task 7 — 工作人员操作台

**状态：已完成。** 已接入业务语言的材料进度页和现场挑战控制台；页面只调用 authority service，不直接写席位、配对或结果，也不提供公开实时成绩广播。

**Files:** `staff_panel/views.py`、`urls.py`、templates、frontend client、tests。

**RED first:** 以状态→主动作验收表驱动 view tests 和真实浏览器 smoke，不允许页面自行拼权限或写席位。

**Implementation:**

1. 提供一个业务语言控制台，显示当前地点、当前人员、待办、合法目标、异常入口和交接提示。
2. 所有按钮调用 authority service；Staff/Admin 可接管；Admin 高风险操作单独确认并审计。
3. 不做公开实时结果/主持人大屏。

**Verify:** `npm run check:client`、`npm run check:e2e`、`npm run test:e2e`、staff permission tests。

## Task 8 — 彩排与交付

**状态：进行最终环境验收。** `docs/production-rehearsal-runbook.md` 已提供发布前门禁、操作流程、18 项验收清单、失败注入和证据记录口径。代码仓库门禁先行执行；PostgreSQL、真实浏览器和远端 CI 结果需在相应环境完成后记录。

**Files:** `docs/production-rehearsal-runbook.md`、本规格、验收测试、CI 配置（仅必要时）。

**Steps:**

1. 先跑当前全量回归，再跑 18 项验收场景和并发/失败注入。
2. 跑 Django check、迁移、test、ruff、mypy、pyright、CSS/client/e2e、docs、PostgreSQL acceptance 和 backup/restore rehearsal。
3. 在真实浏览器完成非开发工作人员彩排；记录 Redis/WebSocket 不可用时 HTTP 仍可完成的证据。
4. 每个逻辑变更独立 conventional commit；全部验证后合并到 `main`，确认远端 CI 成功后再清理分支。

**Definition of done:** 正式流程可操作、无隐藏并列规则、无 authority bypass、审计可追溯、旧回归不退化、文档和验收清单同步。
