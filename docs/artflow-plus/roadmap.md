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

## M1 — Engine Kernel（进行中）

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

## M2 — Capability Composition 与 Activity Packs

- 工具链：pnpm workspace + Vitest/fast-check 已在 M1 落地；M2 加入 `packages/contracts`
  （TypeBox/JSON Schema）、`apps/api`（Fastify 5 + OpenAPI）、`packages/db`
  （Kysely + module-owned migrations）。
- Capability 注册表：identity/version/dependencies/conflicts/definition contract/
  commands/queries/events/permissions/surfaces。
- Activity Pack：Registration+Questionnaire+Materials+Competition+Evaluation+
  Voting+Publishing+Archive（Singer Competition Pack）等组合与默认值。
- Pack 的引导（Guided Mode）与兼容性校验；禁用 capability 时的依赖处理。
- 结构门禁：capability 不得导入其他 capability 的 persistence。

**出口**：能用一个 Pack 生成可编译的空定义；依赖/冲突诊断正确；Gate 检查
capability 边界。

## M3 — Execution Runtime

- Execution Session 生命周期与投影（当前表演/评分门/投票状态/签到）。
- Outbox + worker；断线可恢复；实时失败降级到 HTTP。
- 正式/测试 scope 隔离的端到端验证。

**出口**：多个 scope 并行；冲突策略生效；恢复后状态一致；事件可重放。

## M4 — Registration / Questionnaire / Materials

- 报名 DRAFT→OPEN→REVIEW→FINAL；问卷版本与文件槽位；受控媒体。
- 名单 FINAL/UNKNOWN；执行边界 fail closed。
- 从 v1 导入历史报名（可重放）。

**出口**：`unknown-roster` golden；文件所有权/审核回归；名单未定时执行拒绝。

## M5 — Competition / Evaluation / Podium

- 轮次、评委组、席位、会话、score fact 唯一性。
- 快速录分、代录、纸面、纠错 saga。
- 排名/晋级/最终名次；tie 显式决策。

**出口**：`duplicate-score-fact` golden；真实 PostgreSQL 双线程并发；
纠错链 E2E。

## M6 — Voting / Ticketing

- 投票场次、ballot 唯一性、成绩组成规则快照。
- 票据、capability、领取、访问会话、限流。
- Live 投影与降级。

**出口**：`capability-reissue-close` golden；重复投票/重放/跨活动拒绝。

## M7 — Publishing / Results / Archive

- 候选 → 核定 → release snapshot → 撤销/再发布 → 解锁纠错。
- 公开页面/列表/Live/媒体/PDF 共用同一 selector。
- 归档包：冻结身份、历史、文件清单、保留。

**出口**：`result-release-lifecycle` + `archive-identity` golden；媒体出口
回归；归档与在线一致。

## M8 — Product Surfaces 与 Cutover

- Studio/Ops/Live/Portal 四个产品面按 capability 贡献组装。
- 按入口切换 v1 → v2；双环境并行验证。
- 数据导入/对账；回滚开关；操作手册。
- v1 只读保留窗口结束后再删除。

**出口**：关键旅程 E2E；迁移报告；回滚演练；现场彩排通过；至少三个结构不同
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
