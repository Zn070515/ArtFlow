# ArtFlow-Plus 路线图

状态：规划基线（2026-10-19）。里程碑按 vertical slice 交付；任何一步都必须能
回退到 v1。每个里程碑的出口条件都是**可执行的**（测试/golden/门禁），不是
“代码写完了”。

## M0 — Legacy Extraction（已完成）

- 54 条领域不变量：`docs/invariants/`。
- 497 条 fix 的经验与事故库：`docs/artflow-plus/analysis/`、`docs/incidents/`。
- 6 个 golden fixtures + v1 适配器（结果发布生命周期）。
- 6 组结构门禁 + Gates CI。
- 时代边界：`main` = 1.x，`artflow-plus` = v2。

**出口**：Gates 在 `artflow-plus` 常绿；golden 结构校验通过。

## M1 — Domain Kernel（进行中）

- Activity → Definition Draft → Compiler → Release → Execution Run（已完成）。
- 属性测试：OCC、冻结、hash 稳定性、非法状态边。
- 领域错误码表 + API 映射草案。

**出口**：领域测试覆盖上述不变量；`npm run check:plus`/`test:plus` 常绿；至少
一条属性测试。

## M2 — Definition Compiler 正式化

- 节点类型：ROSTER、ROUND、AGGREGATE、SELECT、OUTPUT；显式端口/绑定。
- 编译产物：稳定 plan、输入指纹、依赖顺序、诊断（ERROR/DEFERRED/WARN）。
- 冻结/发布：版本化、不可变、可回放；与 golden 的 `unknown-roster` 对齐。

**出口**：编译器属性测试（任意 DAG/顺序）；DEFERRED 语义；发布后不可编辑。

## M3 — Execution Runtime

- 执行实例绑定 released version；状态机与事件。
- 投影：当前轮次/当前表演/评分门；断线可恢复。
- `RUN_ALREADY_ACTIVE`、`STALE_REVISION` 等边界的 HTTP 映射。

**出口**：同一活动单 run；恢复后状态一致；事件可重放。

## M4 — Registration / Questionnaire / Materials

- 报名、草稿、提交、审核、名单 FINAL/UNKNOWN。
- 问卷版本与文件槽位；受控媒体。
- 从 v1 导入历史报名（可重放）。

**出口**：`unknown-roster` golden；文件所有权/审核回归；名单未定时执行拒绝。

## M5 — Evaluation / Scoring / Podium

- 轮次、评委组、席位、会话、score fact 唯一性。
- 快速录分、代录、纸面、纠错 saga。
- 排名/晋级/最终名次；tie 显式决策。

**出口**：`duplicate-score-fact` golden；真实 PostgreSQL 双线程并发；
纠错链 E2E。

## M6 — Voting / Tickets

- 投票场次、ballot 唯一性、成绩组成规则快照。
- 票据、capability、领取、访问会话、限流。
- Live 投影与降级。

**出口**：`capability-reissue-close` golden；重复投票/重放/跨活动拒绝。

## M7 — Results / Release / Archive

- 候选 → 核定 → release snapshot → 撤销/再发布 → 解锁纠错。
- 公开页面/列表/Live/媒体/PDF 共用同一 selector。
- 归档包：冻结身份、历史、文件清单、保留。

**出口**：`result-release-lifecycle` + `archive-identity` golden；媒体出口
回归；归档与在线一致。

## M8 — Cutover

- 按入口切换 v1 → v2；双环境并行验证。
- 数据导入/对账；回滚开关；操作手册。
- v1 只读保留窗口结束后再删除。

**出口**：关键旅程 E2E；迁移报告；回滚演练；现场彩排通过。

## Definition of Done（每个 slice）

1. 领域规则写入 `docs/invariants/`（新增或引用）。
2. 领域单元 + 至少一个反例；适用的 golden fixture 通过。
3. 结构门禁通过；没有新增 `tests/gates` 例外。
4. 错误码/审计/权限齐全；没有直接跨模块表访问。
5. 部署影响已说明（迁移、配置、静态/媒体、回滚）。
6. 文档更新：domain、ADR（如改决策）、roadmap 勾选。

## 非目标（整个 v2.0）

- 多租户、计费、开放生态。
- 全量 UI 先行的重写；页面必须跟随 slice。
- 一次性删掉 v1；先证明没有入口指向它。
