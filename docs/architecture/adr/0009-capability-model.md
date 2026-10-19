# ADR-0009: Capability 是模块边界，Activity 是薄容器

状态：accepted（2026-10-19）

## 背景

v1 以 Django app 为代码边界（singer_contest、ruleset、public_portal…），但业务
上反复出现的边界是“报名、评分、投票、票据、发布、归档”这些能力，而不是表或
页面。GOAL 把 Capability 定义为功能增长的主单位，要求每个权威事实只有一个
owning capability。若 v2 继续按 v1 app 切分，会再次产生跨模块直接查表与
多 selector。

## 决策

- **Capability 是业务所有权与代码模块的边界**；每个 capability 拥有自己的事实、
  命令、查询、事件、定义语言、权限与产品面贡献。
- **Activity 是薄根容器**：身份、粗生命周期（DRAFT→ACTIVE→CLOSED→ARCHIVED）、
  enabled capabilities、active definition release、公共身份；不积累 capability
  内部状态。
- **Activity Definition Package** 由 manifest + 各 capability 定义 + policies +
  cross-capability bindings 组成；每个 capability 可以有自己的编译器，Activity
  编译器负责协调与跨 capability 校验。
- **Activity Pack** 是 opinionated 的 capability 组合与默认值，不是 Activity
  子类；用户可以在兼容范围内启用/禁用/定制。
- **Execution Session** 绑定 activity + definition release + scope + mode；
  一个 activity 可以有多个并行 scope，冲突由 capability 组合声明。TEST/REHEARSAL
  与 FORMAL 不得在冲突 scope 上重叠。
- **产品面**（Studio/Ops/Live/Portal）只组合 capability 的公开 contract，不持有
  独立事实。

## 后果

- 需要 capability 注册表（identity/version/dependencies/conflicts/definition
  contract/commands/queries/events/permissions/surfaces）。
- 需要结构门禁检查：capability 不导入其他 capability 的 persistence；不复制
  其他 capability 的 selector。
- Golden fixtures 按 capability 组织；一个 Activity 场景可以组合多个 capability
  的 fixture。
- 验证抽象是否足够通用：至少一个 judged singing competition、一个 stage show、
  一个结构不同的比赛/复杂活动；第三个不需要重写内核才算成立。
- v1 的 app 目录只是历史证据，不是 v2 的模块划分。

## 替代方案

- **按 v1 app 切分**：会把表结构当边界，重演跨模块读写与 selector 漂移，否决。
- **一个通用 workflow DAG**：会把非比赛活动扭曲成比赛图，且无法表达 capability
  自有语言，否决。
- **Activity 携带所有状态**：形成巨型聚合，并发与演进都不可控，否决。
