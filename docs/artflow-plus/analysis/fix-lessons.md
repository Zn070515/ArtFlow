# 从 v1 的 497 条 fix 里提炼的经验

统计范围：`main` 全部历史，排除 merge commit，共 1130 个非合并提交；其中
`fix:` / `hotfix:` 497 条（44.0%）。主题按提交标题与改动路径做多标签归类，
所以一项 fix 可能同时属于多个主题。

这份文档不是 changelog，而是把 v1 反复修过的东西提炼成 ArtFlow-Plus 可以
直接采用的不变量、检查项和测试策略。

## 数据快照

| 主题 | fix 数 |
| --- | ---: |
| 评审收口 / 契约 | 88 |
| 赛制 / 分组 / 轮次 | 77 |
| 生命周期 / 清理 / 归档 | 74 |
| 评委 / 评分 / 踢馆 | 71 |
| 部署 / Docker / 环境 | 69 |
| 票据 / 凭证 / 访问 | 52 |
| 结果 / 公示 / 快照 | 50 |
| 格式 / 类型 / lint | 50 |
| CI / 门禁 / 构建 | 49 |
| 报名 / 问卷 / 材料 | 47 |
| 权限 / ORM / authority | 43 |
| 测试 / 回归 | 39 |
| 并发 / 锁 / OCC | 34 |

改动最集中的模块：`singer_contest/`（188）、`staff_panel/`（166）、
`common/`（100）、`templates/`（95）、`ruleset/`（72）、`voting/`（46）。

---

## A. 权威与状态

### 1. 权限是写路径的闭包，不是视图里的一个 if

**经验**：只要存在第二条写路径，第一条路径上的校验就不算数。ORM 的
`save`、`QuerySet.update/delete`、`bulk_create`（含 conflict upsert）、
`bulk_update`、`_base_manager`、raw delete、Django Admin 都是独立入口。

**证据**：43 条权限/ORM 类 fix；对抗式审查反复发现 `_base_manager`、
conflict upsert、raw delete 绕过 guard。最终做法是让 `objects` 与
`_base_manager` 指向同一个受保护 manager，并给冲突 upsert 直接判死。

**Plus 做法**：一个聚合只能有一个写入口（domain command）。仓储层不暴露
通用 update/delete；所有写操作经过 command，command 内部做授权与状态校验。
对每个聚合写一组“攻击所有入口”的 contract test。

### 2. 一个业务事实只能有一个权威 selector

**经验**：当页面、列表、PDF、归档各自计算“当前正式结果”时，它们一定会
漂移。必须抽出唯一的 selector，所有出口复用它。

**证据**：50 条结果/公示类 fix。`active_result_release_for_post()` 最终成为
首页、结果列表、详情、Live、主持手卡、归档、发布检查共用的唯一选择器；
此前每处各写一套 predicate。

**Plus 做法**：把 selector 定义成领域查询（read model），而不是散落在
controller 里；出口只能消费 selector 的输出，不能自己拼条件。

### 3. 冻结/发布/归档是快照边界，不是状态标签

**经验**：状态变成 FROZEN/PUBLISHED/ARCHIVED 的那一刻，必须把“公众看到的
事实”冻结下来。之后活动改名、文章改标题、候选重算，都不能改写历史。

**证据**：`ResultRelease.result_snapshot` 冻结 decisions/awards/
`activity_title`/`public_title`/`candidate_revision`；归档导出冻结标题；
0011 明确标注旧 ACTIVE 标题只是 best-effort，不伪造历史。

**Plus 做法**：每个 authority transition 产出一个自包含 snapshot；历史读模型
只读 snapshot，不回查当前值；无法重建的旧数据显式标 legacy，不猜。

### 4. 状态机要有唯一入口和显式边，恢复路径必须是窄 seam

**经验**：
- 状态只能通过一个命令迁移，不能由任意 `save()` 改。
- “解锁”不是“重置全部”，而是只打开这次结果真正拥有、且允许重写的事实。
- 恢复路径必须能在 UI 走完，并且每一步可审计。

**证据**：74 条生命周期类 fix。典型事故：`unlock_stage_result` 把 challenge
source 的 R1 也改回 SCORING，绕过了 `unlock_round` 的 guard；修复为保持
challenge source 锁定，只对目标 performance 开一个窄门
（`reopen_performance_score_for_correction`），并要求重新锁定、重算、重新核定。

**Plus 做法**：状态迁移表是显式数据；每个迁移声明它消费/产出的事实；恢复
命令按“最小可写集合”设计，超出窗口交给完整事故流程。

### 5. OCC 用单调 revision，不用内容 hash；缺 token 视为拒绝

**经验**：内容签名会把 A→C→A 当成“没变”。并发控制必须有单调 revision，
并且每个独立写入口都要带 token；服务端对“缺少 token”应拒绝，而不是当作
“跳过检查”。

**证据**：34 条并发/OCC 类 fix；`binding_revision`、
`group_stage_binding_revision`、`StageResult.candidate_revision` 三层粒度；
旧编辑器漏 token、preview 晚到覆盖新选择，都是同一类事故。

**Plus 做法**：聚合根持有 revision；命令必须携带 expected revision；独立
表单/自动写也要带；preview 记录它基于哪一版。

---

## B. 并发与失败

### 6. 并发正确性需要真实数据库的双线程证据

**经验**：单线程 service 测试不能证明行锁、唯一约束和幂等回执。需要
PostgreSQL + 两条连接，把 interleaving 固定下来。

**证据**：34 条并发类 fix，后期补了 judge score race、ticket credential
race、binding CAS 等 `TransactionTestCase`。早期只靠设计推断，结果现场
路径存在“锁后重读 `.get()` 被并发删除变成 500”之类的窗口。

**Plus 做法**：每个依赖行锁/唯一约束的写路径，至少一条真实 PostgreSQL
双线程测试；锁后一律 `filter().first()` + 业务错误；唯一 key 分配与 INSERT
在同一把 aggregate 锁内完成。

### 7. 拒绝要 fail closed，而且要说人话、给出下一步

**经验**：
- 不认识的输入、缺失的 token、未知的名单状态 → 拒绝，不猜。
- 裸 reason code（如 `DUPLICATE_SCORE_FACT`）对现场人员没有意义；错误必须
  说明“发生了什么 + 现在该做什么”。
- 二次验证后的 POST 不能回到 POST-only URL（会 405）；要回到能安全 GET 的
  表单页。

**证据**：88 条评审收口类 fix；后期专门把重复评分提示改成中文业务说明，
把 admin 再验证落点改成表单页。

**Plus 做法**：domain error = code + 人类消息 + 恢复动作；HTTP 层不拼接异常
文本；每个拒绝路径都有 UI 验收测试。

### 8. “未知”“零”“空”是三种事实

**经验**：把 unknown 当 0 会制造假 ERROR 或假 PASS。名单未定、票数为空、
问卷未答、草稿为空，都必须有显式语义。

**证据**：报名前冻结时 `entry_size=0` 导致 `QUOTA_EXCEEDED` 假错误 → 引入
`entry_roster_final` 与 `Severity.DEFERRED`；空 session 不产生 0 分而是让
resolver HOLD。

**Plus 做法**：领域值用 `Option/Maybe` 或显式 null 语义；报告区分 ERROR /
DEFERRED / PASS；默认值只在确定事实的层出现。

---

## C. 出口与契约

### 9. authority 的终点是“对外出口”，不是后台页面

**经验**：后台改对了，公开页面、列表、SSR 首屏、媒体网关、PDF、归档仍然
可能泄漏旧事实。每个出口都要消费同一份 authority。

**证据**：撤销/替代后的结果媒体仍可匿名访问；SSR 标题仍用 editorial title；
结果页仍渲染自由正文/封面；PDF 只看“最新结果”不看 CONFIRMED。这些都不是
后台视图的 bug，而是出口各自为政。

**Plus 做法**：把 public surface 列成清单（页面/列表/SSR/媒体/PDF/导出/
归档），每个都跑同一组 snapshot 回归；媒体授权在网关层，不在模板层。

### 10. UI 是契约；模板不是权限边界

**经验**：按钮文案、标签、跳转落点都会被端到端测试钉住；同时，隐藏按钮
不等于拒绝写入。

**证据**：95 条模板相关 fix；workspace 验收 spec 因文案变化而红；表单渲染
与真正的 service authority 分离。

**Plus 做法**：UI 组件对稳定 data-testid/标签负责；所有写操作仍由后端
command 校验；E2E 只验证用户可见契约与完整重定向链。

### 11. 测试要攻击“事故的形状”，不是只走 happy path

**经验**：每个不变量至少要有一种反例测试：绕过、陈旧、并发、跨活动、已
撤销、测试模式、空值。

**证据**：39 条测试类 fix；TEST 与 FORMAL 的清理集合不同，导致“测试绿了但
正式路径 500”；直接 ORM 造数据绕过了真实 service 流程。

**Plus 做法**：不变量 → property/contract test + golden fixture；fixture
必须走与生产相同的生命周期；对每个已知事故保留一条回归。

---

## D. 部署与流程

### 12. 部署产物的一致性必须被证明

**经验**：镜像里的代码、收集到的静态文件、容器里的配置、运行时的 SHA，
任何一处不一致都算部署失败，不能靠“应该没问题”。

**证据**：69 条部署类 fix。持久化 `STATIC_ROOT` 让新镜像仍服务旧 JS；
`media`/`realtime` 没挂载 static manifest，导致 404 变 500；event compose
漏转发运行时 knob，写了也不生效。

**Plus 做法**：部署不变量写进启动检查：baked SHA == host SHA；collected
static == image static；每个 settings knob 都在 manifest 的 environment 里；
一个来源（同源代理）；健康检查区分 liveness/readiness。

### 13. 配置清单需要契约测试，不然“存在但没人检查”

**经验**：pyright/ruff/mypy 的 include 列表、Tailwind content、tsconfig、
compose environment、dependabot、.dockerignore——任何手写清单都会漂移。

**证据**：50 条格式/类型类 + 49 条 CI 类 fix；多次出现“文件存在但不在任何
检查列表里”。

**Plus 做法**：每个清单都有一个测试，从“真正的源”（settings、manifest、
目录枚举）推导出应有集合，和清单做差集；CI 按实际顺序跑全部 gate。

### 14. “收口”要成为流程，而不是一轮轮救火

**经验**：88 条提交是“close Nth audit gaps / harden X”。这本身不是坏事，
但如果每次都靠下一轮评审发现下一批边界，成本会一直累积。

**证据**：高频词 `gaps 27`、`harden 26`、`audit 13`、`acceptance 14`；
10 月单日最高 22 条 fix。

**Plus 做法**：每轮改动后按固定清单扫一遍：所有写路径、所有公开出口、所有
恢复路径、所有配置清单、所有并发窗口；把清单变成 contract test，而不是
依赖评审者的记忆。

### 15. 提炼领域知识，而不是搬运实现

**经验**：反复出现的 authority、lifecycle、snapshot、OCC、ticket、judge
问题，都是领域问题；Django 只是 v1 的实现载体。

**证据**：同样的“单一权威来源”“冻结快照”“窄恢复 seam”在
ruleset/singer_contest/public_portal/archive 反复出现。

**Plus 做法**：先写 `docs/domains`、`docs/invariants`、`docs/incidents` 和
`tests/golden`；新架构用自己的机制满足同一组不变量。实现 bug 留在 v1，
业务不变量前向传播。

---

## 对 Plus M0 的优先级

1. **authority 写路径闭包**（43 条 fix 的最大公约数）
2. **生命周期/状态机与恢复 seam**（74 条）
3. **并发/OCC**（34 条）
4. **评分事实与评委链**（71 条）
5. **结果快照/公示/撤销**（50 条）
6. **票据/凭证/访问**（52 条）
7. **部署产物一致性**（69 条）

每条不变量至少配：领域描述、反例测试、Golden fixture、v1 事故链接。
