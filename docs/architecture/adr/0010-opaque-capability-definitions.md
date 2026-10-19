# ADR-0010: Capability 定义对 Activity 编译器是不透明的

状态：accepted（2026-10-19）

## 背景

M1 的第一版把 `CapabilityDefinition` 直接定义成比赛 DAG：

```ts
interface CapabilityDefinition {
  schemaVersion: 1;
  nodes: DefinitionNode[];   // roster/round/aggregate/output
  edges: DefinitionEdge[];
}
```

文档已经说“每个 capability 可以有自己的定义语言”，但代码仍是
`Capability → competition-shaped DAG`。Activity 编译器因此知道 `round`，无
法承载 Registration/Scheduling/Stage Show 等不同语言，也违背 GOAL §9/§12。

## 决策

- `CapabilityDefinition` 是**不透明、带版本**的 payload：
  ```ts
  interface CapabilityDefinition {
    schemaVersion: 1;
    payload: unknown;
  }
  ```
- 每个 capability 提供自己的 `CapabilityCompiler`：
  - 声明 `capabilityKey`；
  - 读取并校验自己的 payload；
  - 返回 `CompiledCapabilityPlan { capabilityKey, contentHash, artifact }`；
  - artifact 对 Activity 编译器不透明。
- Activity 编译器只做协调：
  - 为每个 capability 找到注册的 compiler；
  - 缺 compiler → `CAPABILITY_COMPILER_MISSING`；
  - 汇总诊断、校验 cross-capability bindings、计算 package hash。
- 第一个 capability 语言（比赛 DAG）移到
  `plus/packages/domain/src/capabilities/competition.ts`；Activity 编译器不导入
  它的节点类型。
- Activity 编译器不得根据 capability 类型做 `switch`；新增 capability 只需新增
  compiler 并注册。

## 后果

- 一个 Capability 可以自由定义自己的 DSL，而不需要修改 Engine。
- 缺少 compiler 会 fail closed，而不是把 payload 当通用图运行。
- 测试需要覆盖：缺 compiler、compiler key 不匹配、payload 无效、跨 capability
  binding 未知。
- Golden fixtures 与 API 只依赖 capability 的 command/query/事件契约，不依赖
  payload 结构。

## 替代方案

- **一个通用 DAG 贯穿所有 capability**：会把非比赛活动扭曲成比赛图，否决。
- **Activity 编译器按 capability 类型分支**：每加一个 capability 就要改 Engine，
  违背扩展模型，否决。
- **让 payload 保持强类型联合**：Engine 仍要知道所有 capability 语言，否决。
