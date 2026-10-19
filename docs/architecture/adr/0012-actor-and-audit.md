# ADR-0012: ActorContext 与审计是 command 的标准副产物

状态：accepted（2026-10-19）

## 背景

M3 的 durable command 已经统一了写路径，但事件与回执没有 actor，也没有独立的审计记录。
原计划把 actor/authorization “留到 M8”。这会让 M4-M7 先写一批没有 actor 的 Registration /
Evaluation / Voting 命令，最后再做一次全量横向返工；而且 Definition of Done 已经要求
“错误码 / 审计 / 权限齐全”。

认证 provider（本地会话、SSO）可以后置；**Actor 与 Audit 的数据模型不能后置**。

## 决策

- 新增 `ActorContext`：
  ```ts
  type ActorType = "system" | "user" | "service";
  interface ActorContext {
    actorId: string;
    actorType: ActorType;
    roles: string[];
    permissions: string[];
    authContext?: string;
  }
  ```
- actor 由 transport 在命令入口注入，**绝不从请求 body 读取**。M3 没有登录，因此：
  - API 默认使用显式 `SYSTEM_ACTOR`；
  - 测试可以注入固定 actor；
  - M4 起由本地会话派生，M8 再替换为 SSO provider。
- `CommandMeta` 携带 actor；replay 时校验 receipt 上记录的 actor 一致，避免不同 actor
  复用同一 command 结果。payload hash 的格式保持不变，升级前写入的 receipt 仍可重放。
- 每个被接受的 command 在同一事务内写一条 `audit_entry`：
  `command_id / activity_id / capability / command_type / actor_id / actor_type / detail /
  created_at`。
  - replay 不重复写审计；
  - 被拒绝的命令随事务回滚，不留下“未发生”的审计（拒绝原因由领域错误码表达）。
- outbox 事件与 `command_receipt` 记录 `actor_id/actor_type`；事件 envelope 增加可选
  `actorId/actorType`，恢复/重放时能解释“谁做的”。
- worker 与 HTTP 使用同一套 actor/audit 规则（CONC-08）。

## 后果

- M4 的 Registration/Questionnaire/Materials 命令从第一天起就带 actor 与审计。
- 授权策略（谁能做什么）仍然在 M4/M8 实现；本 ADR 只固定数据形状与写路径。
- 审计表需要在保留/清理策略中处理（与 outbox 一起，M8 前补）。
- 客户端不能伪造 actor；伪造只可能来自部署或测试注入。

## 替代方案

- **M8 再统一加 actor**：M4-M7 的命令、测试、事件都要二次改写，否决。
- **信任 `X-Actor-Id` 请求头**：无认证时等于允许伪造，否决。
- **把审计做成异步投影**：审计是权威副产物，必须与命令同事务，否决。
