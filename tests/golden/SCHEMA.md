# Golden fixture schema (`artflow.golden.fixture.v1`)

每个 fixture 是一个 JSON 对象，描述“初始事实 → 一串领域命令 → 期望结果”。
它不引用数据库自增 ID、Django model 或 TypeScript 类型。

```json
{
  "schema": "artflow.golden.fixture.v1",
  "id": "stable-kebab-case-id",
  "invariants": ["RES-02", "AUTH-04"],
  "description": "一句话说明这个场景在证明什么",
  "facts": { "...": "初始业务事实，使用稳定业务键" },
  "steps": [
    {
      "step": 1,
      "command": "command_name",
      "actor": "admin:fixture-admin",
      "input": { "...": "命令输入" },
      "expect": {
        "outcome": "accepted",
        "events": ["DomainEventName"],
        "read_model": { "...": "可选的期望读模型" }
      }
    },
    {
      "step": 2,
      "command": "command_name",
      "actor": "staff:fixture-staff",
      "input": { "...": "命令输入" },
      "expect": {
        "outcome": "rejected",
        "reason": "REASON_CODE",
        "side_effects": "none"
      }
    }
  ]
}
```

## 字段

| 字段 | 说明 |
| --- | --- |
| `schema` | 固定 `artflow.golden.fixture.v1` |
| `id` | 文件名去掉 `.json`，全局唯一 |
| `invariants` | 本文档中真实存在的编号，如 `SCOR-01`；运行器会校验存在性 |
| `facts` | 初始状态。使用业务键（`activity.key`、`stage.key`、`seat.key`），不使用自增 ID |
| `steps[].command` | 领域命令名，使用小写 snake_case |
| `steps[].actor` | `role:stable-name`，角色为 `admin` / `staff` / `judge` / `participant` / `system` |
| `steps[].input` | 命令输入；时间、随机数、指纹必须显式给出 |
| `expect.outcome` | `accepted` 或 `rejected` |
| `expect.events` | accepted 时必须出现的领域事件（顺序即因果顺序） |
| `expect.read_model` | accepted 后必须成立的读模型断言（部分匹配） |
| `expect.reason` | rejected 的原因码；必须与 `outcome=rejected` 同时出现 |
| `expect.side_effects` | rejected 时固定 `none`：不得产生事实/事件/审计以外的副作用 |

## 运行规则

1. 每一步只执行一个命令；命令之间不共享实现细节。
2. rejected 步骤必须同时断言 `side_effects: "none"`；运行器比较执行前后的
   事实快照。
3. `read_model` 是部分匹配：只断言列出的键，其余键不参与比较。
4. fixture 里的时间、版本、指纹是显式输入，运行器不得使用当前时间补齐。
5. v1 适配器把 `facts` 映射到 Django 对象；Plus 适配器映射到自己的领域对象。
   两边跑同一份 fixture，比较的是同一组期望。
