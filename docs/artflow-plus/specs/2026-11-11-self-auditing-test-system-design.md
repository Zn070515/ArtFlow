# 自审计测试体系设计

状态：提案，2026-11-11。
目标：不依赖外部审核，测试体系自己发现“能力存在但产品路径不连通”“契约没有执行
证据”“测试没有真正失败”的问题。

## 1. 问题

外部审核发现的 15 条 Issue 说明：测试数量不是核心问题，**测试没有覆盖产品路径
之间的连接**才是。能力级测试可以全绿，同时出现：

- API route 没有 Web 调用方；
- Starter Pack 启用了能力却没有可用定义；
- 读模型返回了事实，但页面只显示内部 ID；
- 文档和部署清单描述已删除的版本；
- API 边界把 SQLSTATE 原样返回；
- 默认 mode 把彩排写进 formal。

如果每次都要靠外部审核才能发现，测试体系就只是“局部实现检查器”，不是工程保障。

## 2. 设计原则

1. **从源模型派生检查**：Capability Manifest、Pack、路由、Web API、文档、部署
   清单都是可投影的数据；测试从这些数据生成闭合检查，而不是从实现反推。
2. **默认失败，例外显式**：没有消费者的 route、没有定义的 Pack、没有测试的
   不变量，默认是缺口；只有显式声明为 `apiOnly` / `internal` / `notApplicable`
   才豁免。
3. **缺口棘轮（gap ratchet）**：当前修不完的缺口进入受控 baseline；**新增缺口
   失败，修复后 baseline 条目必须删除**。这样 CI 今天可以绿，但不会继续腐烂。
4. **自测门禁**：每个门禁都要有正例和反例 fixture，证明它真的会失败；不能只用
   真实树跑出绿色。
5. **生成式探索**：状态机、命令序列、并发交错用 fast-check / 模型测试生成，
   不只枚举手写样例。
6. **变异审计**：定期删除关键保证（审计写入、回执、guard），确认测试会失败；
   存活的变异就是弱测试。
7. **不制造第二套业务系统**：诊断只读源模型和真实数据库，不复制业务规则。

## 3. 分层结构

```text
L0 源模型（机器可读）
  capability manifests / packs / routes / web api / docs / deploy manifests
        ↓
L1 闭合检查（秒级，CI 阻塞）
  route closure / pack closure / manifest closure / read-model closure /
  doc closure / deploy closure / invariant-test closure
        ↓
L2 缺口棘轮（秒级，CI 阻塞）
  baseline 只允许已接受的缺口；新增失败；修复后必须删条目
        ↓
L3 契约与生成式测试（分钟级，CI 阻塞）
  executeCommand contract / lifecycle model / command sequence fuzz /
  deterministic concurrency / read-model differential
        ↓
L4 产品旅程（分钟级，CI 阻塞或 nightly）
  organizer journey / participant journey / judge journey，由 journey spec 驱动
        ↓
L5 变异审计（夜间，非阻塞/自动开 issue）
  删除关键保证，确认至少一个测试失败；存活变异进入清理 backlog
```

## 4. L1 闭合检查

### 路由闭合检查

每个 mutation route 必须满足至少一项：

- 有 Web/Portal 调用方（Consumer Graph `consumes-route`）；
- 在 `api-only.json` 显式声明，并写明原因（例如 judge 入口、公开投票）；
- 有对应的 journey step。

每个 route 还必须有：

- 权限声明与至少一个拒绝测试；
- 如果写入事实，必须有幂等/回执契约测试。

### Pack 闭合检查

每个 Pack 必须满足：

- `definitions.materials` → questionnaire 至少一个 `type: "file"` 题；
- `definitions.competition` → ticketing 或显式声明“无评委入口”的替代路径；
- 暴露 voting → 显式 voting definition 与 identity policy；
- 每个启用能力有对应的 UI/API 读面。

### Manifest 闭合检查

- 每个 command 有 `executeCommand` provider；
- 每个 command/event 至少被一个 capability manifest 声明；
- 每个 event 有 producer，并有 consumer 或显式 `noConsumer` 声明；
- 每个 query 有 read surface。

### Read-model 闭合检查

每个 API/读模型字段必须满足至少一项：

- 被 Web 消费；
- 显式标记 `internal`（例如 storage key、内部 revision）；
- 是审计/恢复必需但不对 UI 暴露。

### Doc / deploy 闭合检查

- 活跃文档中的命令、页面、镜像名必须存在于当前树；
- Compose、k8s、开发基线的 PostgreSQL 18 挂载路径必须一致；
- 每个部署变量都在 `.env.production.example` 中有说明；
- 每个 runbook 命令都有对应的脚本/入口。

### Invariant-test 闭合检查

`docs/invariants/` 的每个 ID（AUTH/LIFE/GRP/CONC/SCOR/RES/TICK/ATT/DEPL/RT）
必须至少被一个测试文件引用；没有引用的 ID 进入缺口 baseline。

## 5. L2 缺口棘轮

### 5.1 数据形状

`plus/tools/contracts/gap-baseline.json`：

```json
{
  "version": 1,
  "accepted": [
    {
      "id": "ui-route:POST /api/activities/:id/tasks/sync",
      "reason": "Ops sync button not built yet",
      "issue": "#61"
    }
  ]
}
```

`id` 必须稳定：用 kind + 规范化的 subject，不使用行号或随机值。

### 5.2 门禁规则

- `audit:check`：
  - 计算当前缺口；
  - 当前有、baseline 没有 → **失败**（新增缺口）；
  - baseline 有、当前没有 → **失败**（已修复条目未删除，防止 baseline 腐烂）；
  - 两者一致 → 通过。
- `audit --update`：只允许人工运行，写回当前缺口；PR 必须说明新增条目。
- baseline 条目必须带 reason；已知 Issue 的带 issue 编号。

### 5.3 为什么不是直接全红

当前树有真实缺口，直接全红会让 CI 长期不可用，最终被绕过。棘轮的效果：

- 今天：已知缺口显式登记，CI 绿；
- 下一次新增无消费者 route / 无定义 Pack / 无测试不变量：CI 红；
- 修复一个缺口：必须删 baseline 条目，否则 CI 红；
- 缺口数量和类型成为可追踪指标。

## 6. L3 生成式测试

### 6.1 Lifecycle model

用 fast-check 生成命令序列，和纯模型比较：

- 合法边、非法边、revision 单调性；
- 终态写保护；
- 重复 commandId 重放；
- 跨聚合前置条件。

模型只描述规则，不复制服务实现；Adapter 执行真实命令。

### 6.2 Command sequence fuzz

随机 command + 随机 payload + 随机 actor：

- 不允许 500；
- 不允许 SQLSTATE / 表结构信息泄漏；
- 所有失败都必须是领域错误码；
- 不产生半写状态。

### 6.3 Deterministic concurrency

固定交错：两个连接、同一 expectedRevision、同一 commandId、不同 commandId；
断言一个成功、一个领域错误、没有重复事实。

### 6.4 Read-model differential

命令序列后比较：

- 权威事实 vs 公开读模型；
- 读模型 vs Web 显示字段（姓名/学号/曲目，不是 UUID）；
- 投影 block 时读面必须 stale。

## 7. L4 产品旅程

Journey spec 是数据，不是手写脚本：

```json
{
  "id": "singer-organizer",
  "actor": "organizer",
  "steps": [
    { "action": "create-activity", "pack": "singer-competition" },
    { "action": "publish-definition" },
    { "action": "register-participant" },
    { "action": "finalize-roster" },
    { "action": "open-judge-entry" },
    { "action": "submit-score" },
    { "action": "resolve-round" },
    { "action": "recompute-podium" },
    { "action": "confirm-result" },
    { "action": "publish-result" },
    { "action": "close-activity" },
    { "action": "archive-activity" }
  ]
}
```

Runner 复用 API client；关键步骤再用 Playwright 验证页面。新 Capability 要么加入
journey，要么显式声明 `notInJourney`。

## 8. L5 变异审计

对关键文件定义变异：

- 删除 audit 写入；
- 删除 receipt 写入；
- 删除 roster final guard；
- 删除 `onReplay`；
- 删除 live projection block 检查；
- 删除 realtime `closed` 检查。

流程：

1. 在临时副本应用一个变异；
2. 运行相关测试；
3. 测试必须失败；存活变异进入 backlog；
4. 恢复副本，不污染主工作树。

已自动化：`mutation:audit` 通过临时修改 + `finally` 恢复运行 8 个关键变异。
首次运行 6/8 caught，发现材料扩展名没有测试、Realtime 只测了 authorize 阶段关闭；
补测试后 8/8 caught。详见
[变异审计结果](../analysis/2026-11-11-mutation-audit-findings.md)。

## 9. 已实现与下一步

已实现：

- Consumer Graph + `consumes-route`；
- `findUnreferencedMutationRoutes`；
- `checkPackReadiness`；
- 本地缺口报告（本轮改为 baseline 棘轮）；
- 契约 harness（P2）；
- 六个已知缺陷的回归测试（P3）；
- `audit:check` 已接入 CI（L1/L2）；
- 变异审计 `mutation:audit`（L5）：8 个关键变异，首次跑出 2 个测试缺口，
  补测后 8/8 caught。

下一步：

1. fast-check lifecycle model、随机命令序列、确定性并发（L3）；
2. Journey spec runner（L4）；
3. 把变异审计接入夜间任务，扩展 publishing/outbox/material/mode 变异（L5）；
4. 逐步清理 baseline：先修 P0 产品缺口，再收紧对应类别的 `--strict`。

## 10. 验收标准

1. 新增一个无 Web 消费者的 mutation route，CI 失败；
2. 新增一个 materials 但无 file question 的 Pack，CI 失败；
3. 修复一个 baseline 缺口但不删条目，CI 失败；
4. 删除 audit/receipt/guard，至少一个测试失败；
5. 随机命令序列不产生 500 或 SQLSTATE 泄漏；
6. Organizer journey 在 CI 跑通；
7. 缺口 baseline 的数量只减不增（除非 PR 明确说明新增）。
