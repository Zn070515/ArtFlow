# ArtFlow-Plus 架构复盘：保留优势与警惕债务

状态：**架构护栏草案**（2026-10-28）  
范围：对 ArtFlow 1.x 与 ArtFlow-Plus v2 的架构收益、迁移代价和下一阶段护栏做记录。

## 1. 结论先行

ArtFlow-Plus 不是一次全面的“技术升级”，而是一次方向正确、收益集中、债务也集中的重构：

- 真正的核心收益是把 v1 已验证的“定义 → 编译 → 冻结 → 执行”机制，从赛制能力泛化为
  capability 内核；它和共享 contracts、fail-closed 权限、durable command/outbox 一起，形成
  了可审计的执行基础。
- 最大的工程风险不在 domain 方向，而在边缘和基础设施：HTTP 路由仍集中在
  `plus/apps/api/src/app.ts`（当前约 2,962 行）、迁移与 Kysely 类型是两份事实、认证/CSRF/
  cookie/限流等责任由应用自行承担、行为测试厚度仍低于 v1 的长期积累。
- 下一阶段不应继续以“再加一个 capability”作为唯一进度指标。优先把 HTTP 分层、schema
  漂移、安全回归、v1/v2 行为对照和迁移演练做成门禁，再决定哪些产品能力值得继续扩张。

这份文档的决策原则是：保留已经证明能降低事故概率的机制；对尚未证明能回本的换装设护栏；
不因为 v2 更现代，就自动否定 v1 已经承担的框架能力。

## 2. 必须保持的真实优势

### 2.1 capability-agnostic 的编译与冻结链条

v1 的 `ruleset/compiler.py` 已经提供了 `content_hash`、`ValidationReport`、`ExecutionPlan`
和 freeze 语义。v2 的价值不是重新发明这些概念，而是把它们抽象成所有 capability 可复用的
内核：`packages/domain/src/compiler.ts` 计算 capability definition hash 和 activity
definition package hash，release 冻结组合后的语义，execution session 再冻结 scope、mode
和 release。

这条链必须保持为所有新 capability 的默认入口：

```text
draft definition
  → capability validation / compile
  → activity definition package
  → immutable release
  → scoped execution session
  → command / fact / projection / archive
```

不能为了赶页面而新增“直接读当前活动配置”的旁路。新增 capability 的出口至少应证明：

1. 定义可独立校验且 hash 稳定；
2. release 冻结后执行语义不随当前 release 漂移；
3. replay、stale release、mode 和 scope 冲突有回归测试；
4. 归档和公开结果使用同一份冻结来源。

### 2.2 纯领域层

`packages/domain` 保持零 IO、零数据库、零 Web 框架依赖，只允许少量确定性计算依赖（当前为
`decimal.js`）。这比 v1 的 `ruleset/compiler.py` 直接导入 Django 异常更干净，也让领域测试
不需要 Django settings 或数据库。

该边界是架构资产，不应为“方便复用错误类”而向 domain 引入 Fastify、Kysely、TypeBox 或
React。跨边界数据用纯值对象、诊断码和 contracts 表达；持久化、权限和副作用留在 runtime/API。

### 2.3 启动期 fail-closed 权限与 release 语义冻结

`plus/apps/api/src/app.ts` 的 `onRoute` 检查把 GET 路由访问面变成启动期契约：未声明
`config.access` 的路由不能启动。这个默认拒绝机制必须继续保持，不能退化成“靠 review 记得
补权限”。

同样要保持 `command-scope` 的 release 绑定：飞行中的 formal session 使用创建时冻结的
release，而不是活动当前 release。它是 v1 活动级锁之外的真实语义提升，直接防止规则换版后
旧 session 被悄悄解释成新规则。

新增路由或命令的最低要求：

- GET 明确声明 read surface；
- command handler 自己检查 actor、permission、activity、release、scope 和 mode；
- 测试覆盖“未声明 / 未授权 / stale / replay / 已关闭”路径；
- realtime 断开不能改变 authority 结果。

### 2.4 共享 contracts 与 durable execution

`packages/contracts` 同时被 API 和 Web 使用，字段变更能够在编译期穿透前后端；receipt、audit、
fact、outbox 同事务，以及 worker 的重试/死信/投影重建，则把 v1 同步路径中容易遗漏的异步
边界显式化。

这些机制应继续作为“业务功能完成”的一部分，而不是基础设施附加项。一个新命令没有完整的
contract、receipt/audit、outbox/replay 和 HTTP 恢复路径，就不应被视为完成。

## 3. 必须警惕的架构债务

### 3.1 HTTP 边缘仍是单文件单体

`app.ts` 目前承载约 110 条路由和大量认证、查询、命令编排。它与 v1 的
`staff_panel/views.py` 属于同一类可维护性风险：领域层分层了，但 HTTP 边界仍按时间堆积。
集中式 `onRoute` 很强，却不能替代模块边界；文件继续增长会让权限、响应 schema、错误处理和
capability ownership 难以局部审查。

护栏与行动：

- 下一次新增 capability 前，先按 `public / session / ops / studio / live / judge` 和
  capability 拆出 route module；`app.ts` 只保留插件注册、公共 hooks 和启动检查。
- 每个模块导出明确的 `registerXRoutes(app, deps)`，禁止模块直接创建数据库连接或绕过 runtime
  command handler。
- 保留全局 onRoute fail-closed 检查，并新增“每个 route module 都被注册、没有重复 method+url”
  的结构测试。

这不是为了追求文件数量，而是为了让一次权限审查、一次 capability 变更和一次错误处理变更都能
在局部完成。

### 3.2 框架能力被应用代码重新实现

v2 放弃 Django admin、auth、CSRF、ORM migration、forms 和 i18n 后，session cookie、CSRF、
上传校验、错误映射、管理界面和迁移正确性都变成项目自己的长期责任。`cookies.ts` 很小并不
代表安全面很小；手写迁移器达到约 1,488 行也意味着 schema 变更的回滚和审查成本是真实的。

警惕点：

- cookie 属性、session rotation、logout/revocation、CSRF origin/token、重放和权限降级必须
  有独立安全回归，而不能只由业务 E2E 间接覆盖；
- 每个 public credential、claim link、judge link、ticket 和 session 都要记录 threat model、
  过期/撤销/重发语义；
- 表单/上传/错误响应不要在 route 中重复实现，统一进入 contracts、validation 和审计服务；
- 管理界面继续自建可以，但要承认它是产品面，不是“没有 admin 成本”。

当前建议不是立刻退回 Django，而是建立一份 v2 security baseline，并把其中的高风险项变成
阻断测试；只有当维护成本持续超过交互收益时，才评估在局部引入成熟组件。

### 3.3 Kysely 类型与迁移是两份事实

`plus/packages/db/src/types.ts` 与 `migrations.ts` 分别描述数据库。TypeScript 只能证明查询
符合手写类型，不能证明手写类型与实际数据库一致；因此“能编译”不能替代“schema 真实匹配”。

优先级最高的补强是 schema drift gate：

1. 在干净 PostgreSQL 中执行全部迁移；
2. 从数据库元数据生成 canonical schema snapshot；
3. 将 snapshot 与 `db/types.ts` 或生成的类型产物对比；
4. 在 CI 中对新增/删除列、nullable、enum、唯一约束、索引和外键给出可读 diff；
5. 对破坏性迁移要求显式标注 expand/contract、回滚和备份恢复证据。

长期更优的是让类型从 schema 生成，把 `types.ts` 变成产物；在此之前，漂移检查必须是阻断
门禁，而不是开发者自觉。

### 3.4 测试数量与行为厚度不能只看编译器补偿

v2 的编译期约束、golden fixture 和结构门禁确实替代了一部分重复测试，但它们主要回答“形状
和边界是否正确”，不等价于 v1 多年积累的权限、并发、锁定、审计、文件访问、导出和破坏性
数据行为回归。不能用“domain 很纯”或“TypeScript 能编译”解释行为测试缺口。

下一阶段用行为矩阵管理风险，而不是用测试总数追赶 v1：

- 每个 capability：happy path、拒绝路径、锁定/关闭、stale/replay、并发、审计、恢复；
- 每个 public credential：未授权、过期、撤销、重发瞬间、跨活动、泄漏后的最小权限；
- 每个 authority fact：锁前可写、锁后拒绝、显式 unlock、派生结果不可冒充事实；
- 每个迁移：空库、已有数据、重启、失败中断、备份恢复；
- 每个公开读面：selector fail-closed、缓存/撤销、来源一致性、无 session 时的最小信息。

v1 的回归用例应按不变量迁移为 Plus golden/contract/integration/concurrency 测试，而不是
机械复制 Django 测试文件。

### 3.5 SPA、PostgreSQL-only、realtime 和 three.js 都是有条件的选择

这些选择不应被描述成无条件升级：

- React/TanStack 对评委终端、Live 控制、投票交互有收益；公开结果、登录和简单报名页的
  SSR/传统表单可能更便宜。以后新增页面按交互密度、可分享性、首屏预算选择，不要默认 SPA。
- PostgreSQL-only 消除了 SQLite/PG 语义差异，是正确性收益；代价是本地启动、CI 和贡献门槛。
  Docker Compose、健康检查、备份恢复 rehearsal 和清晰的开发脚本必须持续维护。
- realtime core 的正确边界是“失效提示 + HTTP 恢复”，不是把权限或最终状态搬进 WebSocket。
  多实例广播、权限实时撤销只有出现明确部署需求才扩展，且必须保留 HTTP 完成路径。
- three.js/R3F 只服务 Portal 装饰，不贡献业务正确性。必须保持 lazy load、reduced-motion、
  无 WebGL fallback 和首屏性能预算；不能让视觉依赖进入 Console 或关键流程。

## 4. 风险优先级与出口

| 优先级 | 风险 | 现在的护栏 | 下一出口 |
| --- | --- | --- | --- |
| P0 | auth/CSRF/credential 自建安全面 | cookie、权限和 capability 检查分散在 API/runtime | security baseline + 定向攻击回归 + credential 生命周期矩阵 |
| P1 | HTTP route monolith | onRoute 缺权限启动即失败 | capability/表面 route modules + route registry gate |
| P1 | migrations/types 漂移 | TypeScript 编译、REQUIRE_DB 测试 | PostgreSQL schema snapshot/drift gate |
| P1 | v1 行为边界未完全迁移 | golden、domain tests、结构门禁 | capability 行为矩阵和并发/恢复证据 |
| P2 | 手写迁移回滚与恢复风险 | module-owned migrations、backup rehearsal | expand/contract 规范、shadow DB、恢复演练 |
| P2 | SPA/three/realtime 成本扩大 | Portal/Console 分壳、realtime core gate | 页面预算、部署规模触发条件、HTTP fallback 回归 |
| P2 | worker 覆盖面偏窄 | outbox relay、pg-boss、dead letter | 按任务价值扩展，并为每类任务定义 idempotency/SLO |

P0/P1 在 production cutover 前必须有证据；P2 可以按真实流量和业务需求排期，但不能被包装
成已经解决的问题。

## 5. 后续工作顺序

### 5.1 先补护栏，再扩 capability

1. 建立 security baseline：认证、CSRF、session rotation、public credential、上传、限流和
   audit 的最小攻击回归集。
2. 建立 schema drift gate：迁移到真实 PostgreSQL、snapshot、类型对比、破坏性迁移流程。
3. 开始 HTTP route module 拆分，保留现有 `onRoute` fail-closed 作为全局最后防线。
4. 将 v1 不变量映射成 capability 行为矩阵，补齐高风险并发、恢复和拒绝路径。
5. 重新评估 cutover readiness；只有高风险证据稳定后，才继续添加低优先级产品能力或视觉换装。

### 5.2 明确不做的事

- 不把 v1 机械 merge 到 v2；按不变量、golden 和新边界重新实现。
- 不因为 app.ts 大就进行一次无测试的大重写；先建立 route module 的可验证边界。
- 不因为 Django 有免费能力就立刻全面回退；先测量 v2 自建安全/运维成本，再按局部问题引入
  成熟组件或服务。
- 不把 `daybreak / ember / quiet` 或更多 three.js 视觉开发置于 P0/P1 护栏之前。

## 6. 保持与变更的决策表

| 结论 | 处理 |
| --- | --- |
| 编译/冻结/校验、纯 domain、release-scoped command、共享 contracts | 保持为 v2 核心身份，并为每个新 capability 复用 |
| fail-closed route access、HTTP 权威、outbox/replay、Decimal 精度语义 | 保持为不可回退的正确性基线 |
| Fastify/TypeBox、Kysely、React/TanStack、PostgreSQL-only | 视为有条件的工程选择，用门禁和指标证明，不作意识形态承诺 |
| 自建 auth/CSRF/migrations/admin | 视为债务与责任，建立安全、漂移、恢复和审计护栏 |
| app.ts 单文件、测试厚度、worker 覆盖面 | 视为明确的 P0/P1/P2 维护队列，不用“架构已现代化”掩盖 |
| three.js、主题扩展、更多 realtime | 限定在真实产品收益出现后再扩大 |

