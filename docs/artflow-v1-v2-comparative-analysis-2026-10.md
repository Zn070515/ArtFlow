# ArtFlow v1 / ArtFlow-Plus v2 深度对比、统计与实现研究

日期：2026-10-28
代码参考：`e2c7805`（`artflow-plus`，M15.1 前的干净基线）；统计快照为 2026-10-28 的 M15.1 当前工作树
统计工具：[`scripts/artflow_comparison.py`](../scripts/artflow_comparison.py)
统计测试：[`scripts/tests/test_artflow_comparison.py`](../scripts/tests/test_artflow_comparison.py)

## 结论先行

这不是一次“旧技术换成新技术”的简单升级，而是一次有明确收益、也有明确负债的重构：

1. v2 真正保留并泛化了 v1 已验证的“规则/定义 → 编译 → 冻结 → 执行 → 结果/归档”链条，并把它从歌手比赛扩展到报名、材料、投票、发布、归档等 capability。
2. v2 的领域层确实更纯：`packages/domain` 不依赖 Django、数据库或 HTTP；权限、release provenance、session scope、结果来源级消费、备份恢复都形成了可自动验证的边界。
3. v2 的主要真实成本不是 TypeScript 本身，而是把 Django 原本承担的 auth、CSRF、forms、admin、迁移检测、i18n 与运维习惯重新交给项目维护。
4. 统计上，v2 约用一半生产源代码覆盖了更泛化的能力，但测试声明密度明显低于 v1，且 HTTP 层和 DB schema 仍是集中式手写边界。
5. 外部成熟项目的共同缺口不是“再做一个更灵活的比赛规则”，而是 Ops 组织执行层：活动准备度、任务/排期、签到、现场状态、权限化报表、公开传播。v2 目前已覆盖比赛/投票/结果闭环，但还没有通用 check-in、任务、schedule、resource 或 incident capability。
6. 本轮已实现的第一步是 `GET /api/activities/:id/operations/analytics`：它只读现有权威事实，返回活动级统计和注意项，不引入第二套状态机，也不把分析结果当成业务决策。

## 1. 统计口径

### 1.1 纳入范围

| Era | 生产源代码 | 测试代码 | 迁移代码 | 路由 | 模型/表代理 |
| --- | --- | --- | --- | --- | --- |
| v1 | `accounts`、`archive`、`common`、`config`、`core`、`entry_access`、`exports`、`farewell_show`、`files`、`incidents`、`public_portal`、`questionnaire`、`realtime`、`ruleset`、`singer_contest`、`staff_panel`、`tickets`、`voting`、`frontend`、`templates` | `tests.py`、`test_*.py`、`*_tests.py` | 各 app 的 `migrations/*.py` | `urls.py` 中 `path/re_path/url` | `models.Model` 类 |
| v2 | `plus/apps`、`plus/packages` 下 `.ts/.tsx/.css`，排除 tests 与 `migrations.ts` | `*.test.ts(x)`、`*.spec.ts(x)` 或 `test` 目录 | `plus/packages/db/src/migrations.ts` | `plus/apps/api/src/app.ts` 中 `app.get/post/put/patch/delete/...` | `types.ts` 中 `*Row` 接口；数据库表来自 `createTable()` |

排除：`.git`、`node_modules`、`dist`、`build`、`coverage`、`staticfiles`、`__pycache__` 和其他生成目录。源码行数是非空文件行的总行数，不是语义有效 LOC；测试声明是可重跑的代理指标，不等价于两个测试框架的实际 test case 数。统计工具故意把 test/migration LOC 单独列出，防止把测试或 schema 历史误当成生产业务代码。

### 1.2 总体快照

| 指标 | v1 | v2 | v2 / v1 | 解释 |
| --- | ---: | ---: | ---: | --- |
| 生产源文件 | 301 | 208 | 69.1% | v2 文件数更少，符合集中式 TS workspace 设计 |
| 生产源代码行 | 65,444 | 34,978 | 53.4% | v2 用约一半行数承载更通用的能力内核 |
| 测试文件 | 82 | 136 | 165.9% | v2 测试文件更多，但单文件平均覆盖更小 |
| 测试代码行 | 56,118 | 21,935 | 39.1% | v2 的测试厚度明显较低 |
| 测试声明 | 2,630 | 505 | 19.2% | 口径不同，不能当作精确 case 数 |
| 测试声明 / 1,000 源代码行 | 40.19 | 14.44 | 35.9% | v2 约为 v1 的 35.9% |
| 测试行 / 源代码行 | 85.75% | 62.71% | 73.1% | v2 仍不算测试薄，但显著低于 v1 |
| 路由声明 | 188 | 111 | 59.0% | v1 含大量 HTML/staff URL，v2 是 API routes |
| 模型/row 声明 | 68 | 48 | 70.6% | v2 的 `*Row` 是手写 DB 类型代理，不等于领域模型数 |
| v2 `createTable` 表 | — | 43 | — | v1 表由 Django model/migration 产生，不能用同一 regex 统计 |
| 迁移文件 | 202 | 1 | 0.5% | v1 按 app 分散；v2 单文件集中 |
| 迁移代码行 | 7,707 | 1,460 | 18.9% | v2 更短，但单文件 blast radius 更大 |

### 1.3 归一化判断

把 v1 的测试声明密度设为 1.0，v2 为 0.359。这个差异不能直接证明 v2 行为覆盖只有 35.9%，因为：

- v1 Django 测试大量用类/方法表达黑盒回归；v2 有更多 fixture、golden、API 与 E2E 组合，但声明写法更紧凑。
- v1 的模型、模板和 service 层存在大量历史行为测试；v2 把部分约束提升到 TypeScript 编译期、TypeBox/结构门禁和 release compiler。
- 但编译期约束无法替代运行时行为测试，尤其不能自动覆盖并发、权限组合、迁移失败、浏览器交互和真实 PostgreSQL 语义。

因此结论是“v2 的测试债务是真实的，但不能用单一 case 数做结论”。下一个质量目标应是按 capability 建立行为矩阵，而不是机械追求 v1 的测试行数。

### 1.4 领域/包分布

#### v1 生产代码重点

| 区域 | 源文件 | 源代码行 | 测试文件 | 测试行 | 测试声明 |
| --- | ---: | ---: | ---: | ---: | ---: |
| `singer_contest` | 22 | 15,204 | 15 | 16,571 | 621 |
| `staff_panel` | 6 | 7,796 | 5 | 9,819 | 425 |
| `ruleset` | 16 | 10,741 | 15 | 9,392 | 492 |
| `common` | 38 | 5,490 | 15 | 6,846 | 235 |
| `templates` | 93 | 6,933 | 0 | 0 | 0 |
| `questionnaire` | 18 | 3,575 | 10 | 3,258 | 245 |
| `files` | 7 | 1,787 | 4 | 1,965 | 115 |
| 其他应用/前端 | 101 | 14,918 | 18 | 8,267 | 497 |

v1 的行为与测试主要集中在比赛、规则、staff 编排和横切 authority；`staff_panel/views.py` 单文件 6,439 个非空源码行，是 HTTP/运营编排集中化的直接证据。

#### v2 生产代码重点

| 区域 | 源文件 | 源代码行 | 测试文件 | 测试行 | 测试声明 |
| --- | ---: | ---: | ---: | ---: | ---: |
| `packages/runtime` | 45 | 11,479 | 36 | 9,955 | 165 |
| `apps/web` | 71 | 8,516 | 50 | 2,553 | 90 |
| `packages/db` | 24 | 5,448 | 11 | 2,043 | 47 |
| `packages/domain` | 24 | 4,083 | 11 | 1,733 | 101 |
| `apps/api` | 13 | 3,810 | 23 | 4,972 | 72 |
| `packages/realtime` | 12 | 847 | 3 | 392 | 15 |
| `packages/contracts` | 16 | 665 | 1 | 232 | 12 |
| `apps/worker` | 3 | 130 | 1 | 55 | 3 |

v2 的 runtime 是最大的业务层，web 测试声明密度偏低，DB 的手写类型/迁移集中问题仍然存在；`apps/api/src/app.ts` 当前为 2,814 个非空源码行，说明 HTTP 分层问题只是从 v1 的 staff view 缩小了，并没有消失。

### 1.5 Endpoint shape

| Era | 方法统计 |
| --- | --- |
| v1 | `path/re_path/url`：188 |
| v2 | `GET` 36、`POST` 66、`PATCH` 7、`PUT` 2：111 |

这个数字不能用来判断哪一代“功能更多”：v1 的 route declaration 包含模板页、表单页、导出页和 staff 页面；v2 主要是 JSON API，web route 在 React Router 中不计入这个数字。它能证明的是边缘复杂度的位置不同：v1 在 Django URL/view/template，v2 在 Fastify route handler/API contract。

## 2. 架构对比：什么是真提升

### 2.1 定义编译/冻结链条泛化

v1 的 `ruleset/compiler.py` 已经有 `content_hash`、`ValidationReport`、`ExecutionPlan` 和 freeze 语义，最复杂的歌手比赛因此已经有“先定义、后执行”的保护。v2 没有凭空发明这条链，而是把它提升为 capability-agnostic kernel：

```text
v1: Ruleset → RulesetVersion → Singer execution
v2: Activity Definition Package
    → capability compilers
    → compiled plan + hashes
    → immutable Definition Release
    → scoped ExecutionSession
    → facts / decisions / snapshots / projections
```

这是最确定的架构提升：报名、材料、分组、评分、投票、发布、归档不再各自发明版本语义。`release`、`content_hash`、`session` 的作用是让“飞行中的正式执行不会漂移”。

### 2.2 领域层纯化

v1 的规则编译器虽然注释声称 pure/deterministic，但仍直接 import Django 的 `ValidationError`；v2 `packages/domain` 的运行时依赖收敛到 `decimal.js` 级别，测试可以脱离 Django settings、数据库和 HTTP。

收益不是“用了 TS”本身，而是：

- 可把 compiler、resolver、评分、投票数学作为纯函数验证；
- 不需要为领域测试启动 web/database；
- domain contract 可被 API、worker、导入和测试共同消费；
- 迁移、HTTP、存储故障不会直接污染领域语义。

### 2.3 Fail-closed 由纪律变成结构

v2 的三处硬边界值得保留：

- GET route 若未声明 `config.access`，应用在启动时失败；
- command scope 从当前 session 绑定的 release 读取，而不是漂移到当前 activity release；
- release provenance 在 API/Worker 迁移前校验，生产环境拒绝缺失或非完整 SHA。

v1 的 `ensure_*_unlocked()` 等守卫仍有价值，但主要依赖调用者纪律和测试覆盖。v2 把其中一部分变成默认拒绝的启动/类型/结构约束。

### 2.4 契约贯通前后端

`@artflow-plus/contracts` 同时服务 API 和 web；TypeBox schema 同时承担请求校验与 OpenAPI/响应形状的基础。这符合 Fastify 官方所描述的 schema-based validation/serialization 方向，且可以避免模板与手写 TS 的字段漂移。

但这个优势成立的前提是：

- 所有 endpoint 都使用共享 schema；
- response schema 不是只写在 handler 注释里；
- DB 类型与 migration 仍有独立 drift gate；
- aggregate/read model 不把 `unknown` JSON 直接扩散到前端。

## 3. 架构对比：没有提升或产生退步的部分

### 3.1 HTTP 边缘仍然集中

统计显示 v1 的 `staff_panel/views.py` 有 6,439 个非空源码行，v2 的 `app.ts` 有 2,814 个非空源码行。v2 已经把 domain/runtime/db 拆开，但没有把 HTTP route 按 capability 拆成模块。继续扩展时若把签到、任务、排期、资源、事件处理都塞进 `app.ts`，会重新形成 v1 的集中式编排病。

本轮 analytics route 先保持现有 API 结构，下一阶段应把 route registration 按 surface/capability 拆成插件或模块，并由一个统一的 `registerReadRoutes`/`registerCommandRoutes` 装配；不能把“拆文件”误当成领域拆分，权限和 capability ownership 仍应在 runtime/domain。

### 3.2 框架责任转移

Django 官方内建 admin/auth/forms/migrations/CSRF/i18n/ORM integration；v2 自建 local account/session/cookie CSRF、Fastify access hook、自写 1,460 个非空迁移源码行、Ops 控制台和 API contract。Django 的迁移工具会比较 models 与 migration state，并提供 `makemigrations --check`；v2 的 `types.ts` 与 `migrations.ts` 是两份事实来源，必须额外建立 schema drift 检查。

这不是说 v2 应退回 Django，而是要把丢掉的框架红利明确列为项目责任：

| 被框架承担的责任 | v2 当前替代 | 必须持续验证 |
| --- | --- | --- |
| auth/session/CSRF | local account、HttpOnly cookie、CSRF hook、capability token | cookie 属性、重放、轮换、跨活动、代理边界 |
| forms/input validation | TypeBox + Fastify hook + runtime domain checks | 每个 raw body/query/content-type 都有 schema |
| admin/ops | 自建 React Ops/Studio/Live | 权限最小化、无敏感字段泄露、可恢复操作 |
| ORM/model state | Kysely `types.ts` + repositories | types/migrations drift gate、约束与索引测试 |
| migrations | 单文件 Kysely migration registry | upgrade/down/restore/row evidence、不可变镜像验证 |
| i18n/templates | React/web CSS | 语言、无障碍、移动端和浏览器回归 |

### 3.3 测试密度与行为边界

v1 统计上有更厚的行为测试层，特别是 `singer_contest`、`ruleset`、`staff_panel`。v2 通过 compiler、结构 gates、golden fixtures 和共享 contracts 补了一部分，但这些机制主要验证“形状/约束”，不能自动证明：

- 多权限交叉下的读写是否正确；
- PostgreSQL 锁和并发时序是否符合预期；
- migration upgrade/restore 后数据语义是否完整；
- 浏览器在手机/断线/刷新/重连时是否能恢复；
- 新 capability 是否真正贯通 Studio/Ops/Live/Portal。

目标不应是复制 v1 的总测试数量，而应把差距转成 capability matrix：每个 capability 至少有 domain反例、DB约束/API权限、浏览器关键旅程、并发/恢复证据四类测试。

### 3.4 迁移文件数量不是 v2 的天然优势

v2 的 1 个 migration file 对新项目启动很简洁，但它同时有三个风险：

1. review blast radius 大，任何修改都可能影响整个 schema history；
2. types.ts 与 migration.ts 不自动互相生成，编译器不能发现列/约束 drift；
3. 回滚、空库安装、旧库升级、备份恢复的语义必须依赖自建测试。

v1 的 202 个文件显得笨重，但 Django migration graph 记录了 app 级依赖和历史 state，并提供模型变化检测。两者的正确比较不是“1 < 202”，而是“v2 更短、v1 更有成熟 schema-diff 生态；v2 必须补上 schema-diff/contract gate”。

## 4. 业务能力对照

| 能力 | v1 | 当前 v2 | 判断 |
| --- | --- | --- | --- |
| 活动根模型 | `core.Activity`，生命周期和活动锁 | thin Activity + Definition Release + sessions | v2 更适合并行 capability，但要防 Activity 重新膨胀 |
| 报名/问卷 | singer-specific questionnaire/registration，Django forms/templates | generic registration/questionnaire/materials，冻结问卷、adoption、participant claim | v2 真泛化；v1 的成熟边界测试需持续迁移 |
| 文件/材料 | `files` app、受控下载、检查、EXIF/回滚等 v1 责任 | metadata + controlled media, legacy bridge, atomic replacement | v2 已覆盖主要 authority，但媒体运维复杂度上升 |
| 评审/评分 | singer contest round/judge/score，规则逻辑深且强 | competition/evaluation、panel snapshot、score facts、correction、ranking | v2 把比赛从 root 降为 capability，设计提升明显 |
| 大众投票 | voting app + ticket/session/records | voting + ticketing，valid ballot predicate、ticket-backed public page、result publishing | v2 组合和来源消费更严谨 |
| 结果发布 | public posts/result releases，staff workflows | publishing snapshot/release/revoke/public selector | v2 的“确认→发布→撤销”更统一 |
| 归档 | archive/export 相关 app/service | immutable archive package、SHA、受控下载、恢复证据 | v2 归档 authority 更清楚 |
| 实时 | Channels，通知而非 authority | protected realtime core、topic monopoly、HTTP recovery | v2 工程化更强，正确性原则与 v1 一致 |
| 活动现场 | tickets/entry/judge/live 组合，但没有通用 check-in capability | Live/评委/投票入口已覆盖，仍缺 generic check-in/offline scan | 两代都不是完整现场运营平台 |
| 任务/排期/资源 | 没有统一通用 capability，部分流程靠 staff/文档 | GOAL 已声明，但当前代码尚未实现 | v2 下一大块工作，不应伪装成已有能力 |
| 事件/复盘分析 | v1 有 benchmark/导出/部分运营数据，但无统一跨域投影 | 本轮新增 activity analytics read projection | v2 开始补上，但仍没有 check-in/参与画像数据源 |
| 组织/成员/人才库 | 非产品核心 | 非当前 v2 scope | 保持延后，先完成活动执行闭环 |

## 5. 相关项目研究：哪些功能值得吸收

以下不是把 ArtFlow 变成竞品复刻，而是比较“成熟系统把哪类问题当成独立能力”。

### 5.1 CampusGroups / Modern Campus Involve：参与与出席数据是独立产品面

CampusGroups 的公开资料把活动发现、注册、票务、签到、实时 attendance、报告作为一条链；它支持 QR/ID/manual check-in，并把每次活动参与沉淀成长期 engagement data。[CampusGroups event attendance tracking](https://connect.readyeducation.com/product/event-attendance-tracking/)

Modern Campus Involve 的官方支持文档明确把 analytics 与权限分离：默认按时间窗口看 attendance，可按组织、类别、活动、地点、标签和 demographics 聚合，并可下载 CSV；它还把 event registration form、approval、RSVP、waiver、check-in poll 作为活动管理的一部分。[Involve analytics](https://involve-support.moderncampus.com/hc/en-us/articles/17717208769421-Analytics-Overview) [Involve event management](https://involve-support.moderncampus.com/hc/en-us/articles/14706433663117-Event-Management)

对 ArtFlow 的直接启发：

- “跨活动统计”必须建立在明确的事实源上，不能从页面访问或临时日志推断参与；
- analytics 的权限是独立 read surface，不应因为能看某个报名表就能看所有活动数据；
- check-in 应能支持 QR、手工补录、撤销/重复扫描、出场/时间窗口和权限化导出；
- 需要把 demographic/participant identity 的隐私分层，先做 aggregate，再做个体画像。

### 5.2 Award Force：多种评审机制可组合，公众投票不是评审的替代

Award Force 把 qualifying、top pick、VIP numeric judging、public voting 视为不同 judging mode，可在同一 season 组合；公开投票又有身份、票数限制和防滥用策略。[Award Force judging modes](https://awardforce.com/wp-content/uploads/2023/06/Award-Force-judging-modes-transcript.pdf) [Award Force voting](https://awardforce.com/features/judging-suite-features/voting-software/)

对 ArtFlow 的启发：v2 把 `competition` 与 `publishing` 解耦、把 `voting` 作为 capability 是正确方向；下一步应补充 review assignment、blind review、异常分/漏评、评审 phase 和反馈可见性，而不是继续把所有规则塞进 singer pack。

### 5.3 pretalx：submission/review/schedule/release 是版本化的连续链路

pretalx 的官方文档显示，投稿、review phase、selection、schedule、schedule release 具有清晰的状态与版本边界；reviewer 访问依赖权限和当前 phase，公开端只看当前 public schedule，schedule 变更也需要发布新版本。[pretalx review documentation](https://docs.pretalx.org/user/review/) [pretalx concepts](https://docs.pretalx.org/developer/architecture/concepts/) [pretalx API resources](https://docs.pretalx.org/api/resources/)

对 ArtFlow 的启发：v2 的 Definition Release/Result Release 方向是对的；下一块 schedule capability 也必须拥有自己的 draft/confirmed/released snapshot，而不是直接改 Live projection。任务、排期、节目单都应沿用“draft → validate → freeze/release → read projection”的模型。

### 5.4 pretix：现场核验必须考虑重复、撤销、强制覆盖和设备边界

pretix 的 check-in API 把 revoked barcode、重复 check-in、required questions、force override 都作为显式语义，而不是简单把扫描当成一条 boolean。[pretix check-in API](https://docs.pretix.eu/dev/api/resources/checkin.html)

对 ArtFlow 的启发：未来 `check-in` capability 至少需要：

- credential resolve → locked fact recheck → record check-in 的服务级完整序列；
- 重复扫描和撤销票据的明确结果；
- offline/duplicate reconciliation 的命令与审计；
- staff 手工补签必须有理由和可追溯 actor；
- aggregate attendance 与原始 check-in record 分离，projection 不当 authority。

## 6. 当前 v2 的优势清单：必须保持

1. **Definition Release 不漂移**：正式 session 只使用启动时绑定的 release。
2. **Authority 与 projection 分离**：Live/realtime 只做失效提示，HTTP/DB facts 才是恢复权威。
3. **来源级消费**：结果只消费实际使用的 round/vote session，避免活动级粗粒度锁死。
4. **命令 idempotency + audit + OCC**：尤其是评分、投票、确认、发布、归档。
5. **凭证不出 durable payload**：ticket/judge/claim/supplement 的原始 token 不进 response、audit、outbox、archive。
6. **媒体字节的事务补偿方向正确**：新写入失败立即补偿；旧文件仅在 on_commit 后回收。
7. **backup/restore 有 immutable image identity 和逐表行数证据**：恢复不是“容器起来了”就算通过。
8. **只读历史导入和可运行 adoption 分离**：不把 v1 的结果伪装成 v2 的新权威。

## 7. 当前 v2 的警戒清单

### P0/P1：切换前不可放松

- schema drift：`types.ts` 与 `migrations.ts` 仍是独立事实；需要生成/校验或结构 gate。
- HTTP concentration：新增 capability 不得继续把所有 route 写进 `app.ts`。
- test thickness：每个 capability 必须补行为矩阵，尤其是 DB 并发、restore、浏览器和权限交叉。
- 自建 auth/CSRF/rate-limit：必须把 cookie、proxy identity、credential rotation、session invalidation 持续纳入回归。
- worker semantics：API/worker 分工、outbox retry/dead-letter、release provenance 要有运行态指标和告警。

### P2：下一阶段应补

- 通用 check-in/attendance capability；
- tasks/checklists/roles/shift；
- schedule/program release；
- incident/HOLD/recovery UI；
- activity/annual analytics 与权限化 CSV；
- public activity hub、program、media/showcase；
- feedback/retrospective，但要先定义留存和隐私策略。

### 反模式：不要做

- 不为了“平台化”提前做多租户、计费、开放插件市场；
- 不把签到、任务、排期直接塞到 `Activity` 大对象；
- 不把 analytics 统计值写回 capability authority 表；
- 不用 raw ballot/访问日志猜真实参与；
- 不为了追求 v1 数字而机械复制 202 个 migration 文件；
- 不以真实活动彩排作为验收前置条件；用自动化、隔离 Docker、可恢复 smoke 和 owner acceptance。

## 8. 本轮已实现：活动运营分析投影

### 8.1 API

```text
GET /api/activities/:id/operations/analytics
```

该 route 使用独立 `analytics` read surface。它返回：

- registration total/status counts；
- material check total/status/required-not-approved；
- roster status/approved count；
- competition round/performance/current-score/locked counts；
- voting session status 和 valid ballot count；
- stage-result/result-release status；
- archive version/current-package counts；
- stable attention code/severity/message。

返回值不含 participant answers、review/judge notes、credential、token、storage key、row-level identity 或 material bytes。

### 8.2 注意项的边界

attention 是 Ops 提示，不是 command gate。当前提示规则是：

- 有待审核报名；
- required material 未达到 approved；
- 启用报名且 roster 仍 unknown；
- formal vote session 仍 open；
- competition round 尚未 locked；
- result stage 未确认、已 stale 或缺少 active release；
- activity 已 closed 但没有 current archive。

真正的锁定、确认、发布、归档仍由各自 runtime service 的权威命令负责。分析端不能绕过这些服务，也不能用“ready”字段替代 closure resolver。

### 8.3 为什么先实现它

它是外部成熟项目共同存在的能力，也是 v2 现有事实最容易安全复用的部分：不需要先发明 check-in 数据模型，不需要迁移或变更 authority，能马上暴露跨 capability 的准备状态，并为后续 tasks/check-in/schedule 提供统一 read surface。

## 9. 后续实现顺序

### M15.1：Activity Analytics（已实现）

- 完成聚合 repository、runtime service、API、Ops card；
- 统计只读，valid ballot 复用唯一权威谓词；
- 加入权限、脱敏、跨 capability 数据契约测试。

### M15.2：Tasks / Checklist / Readiness

- 新 capability，拥有 draft/template、assigned、due、blocked、done 等自己的事实和命令；
- 任务完成不能直接修改比赛/投票/发布 authority，只能作为 readiness 输入；
- 支持活动模板生成“报名审核、材料、评审、投票、发布、归档”检查项；
- 每次完成/重开/转派有 actor、reason、revision、audit。

### M15.3：Check-in / Attendance

- QR/ticket/manual 三种入口；
- scan/redeem/duplicate/revoke/offline reconciliation 的明确状态；
- formal session/release 绑定；
- aggregate attendance 与 raw check-in fact 分离；
- 后续再做 CSV/年报，不先做个人画像。

### M15.4：Schedule / Program Release

- schedule draft → validate → freeze → release；
- room/resource/role conflict diagnostics；
- Live 使用 released schedule，不直接读 mutable draft；
- Portal 只暴露 public release。

### M15.5：Incident / Recovery / Feedback

- HOLD、暂停、设备故障、人员缺席和手工纠正使用独立 incident/recovery contract；
- 反馈在结果/归档之后进入 retained/non-retained policy；
- 反馈不得改变已经确认的结果，只能生成后续 improvement facts。

## 10. 最终判断

v2 的真正收益是“把 v1 已验证的规则冻结思想抽成可组合内核”，不是“所有技术都更先进”。v2 的真正风险是“把 Django 曾经免费的责任低估”，不是“Fastify/React/Kysely 本身不适合”。

在生产切换前，最重要的工程动作依次是：

1. 维持 release/provenance/authority/restore 的 fail-closed 优势；
2. 用 capability matrix 增厚测试，而不是用总行数自我安慰；
3. 补 schema drift gate，降低自建迁移器风险；
4. 拆 HTTP route 装配，防止 `app.ts` 成为新 staff_panel；
5. 按 tasks → check-in → schedule → incident 的顺序补 Ops/Live 真实缺口；
6. 继续只用自动化与隔离证据，不把真实活动彩排重新写成前置条件。

## 参考资料

- [Django migrations](https://docs.djangoproject.com/en/6.0/topics/migrations/)：model/migration state、`makemigrations`、迁移依赖与历史模型。
- [Django admin FAQ](https://docs.djangoproject.com/en/6.0/faq/admin/)：Django admin 与自定义 view 的责任边界。
- [Fastify validation and serialization](https://fastify.dev/docs/latest/Reference/Validation-and-Serialization/)：JSON Schema 校验/序列化和 content-type 边界。
- [Fastify Type Providers](https://fastify.dev/docs/latest/Reference/Type-Providers/)：TypeBox/JSON schema 与 handler 类型推导。
- [Kysely introduction](https://kysely.dev/docs/intro)：类型化 SQL builder 的可见列/结果类型优势与 escape hatch。
- [CampusGroups event attendance](https://connect.readyeducation.com/product/event-attendance-tracking/)：QR/ID/manual check-in、参与记录与报告。
- [Modern Campus Involve analytics](https://involve-support.moderncampus.com/hc/en-us/articles/17717208769421-Analytics-Overview)：按时间、组织、类别、地点、标签、demographics 聚合出席数据。
- [Modern Campus Involve event management](https://involve-support.moderncampus.com/hc/en-us/articles/14706433663117-Event-Management)：registration form、approval、RSVP、waiver、poll、check-in。
- [Award Force judging modes](https://awardforce.com/wp-content/uploads/2023/06/Award-Force-judging-modes-transcript.pdf)：qualifying/top-pick/VIP/public voting 组合。
- [Award Force public voting](https://awardforce.com/features/judging-suite-features/voting-software/)：公众投票身份与票数控制。
- [pretalx review](https://docs.pretalx.org/user/review/)：review phases、权限、blind review、评分与 selection。
- [pretalx concepts](https://docs.pretalx.org/developer/architecture/concepts/)：submission lifecycle、schedule version/release。
- [pretix check-in API](https://docs.pretix.eu/dev/api/resources/checkin.html)：重复、撤销、required question 与 force override 语义。
