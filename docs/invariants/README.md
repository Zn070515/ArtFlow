# ArtFlow 领域不变量

这些文档把 v1（`v1.0.0`）在 497 条 fix 中反复验证的规则，提炼成 ArtFlow-Plus
必须满足的领域不变量。v1 的 Django 实现是证据，不是规范；Plus 可以用不同的
架构满足同一条规则。

## 编号与使用

| 前缀 | 文档 | 范围 |
| --- | --- | --- |
| `AUTH-` | [authority.md](authority.md) | 写权限、所有权、媒体访问、清理 |
| `LIFE-` | [lifecycle.md](lifecycle.md) | 状态机、冻结、解锁、纠错、归档 |
| `GRP-` | [lifecycle.md](lifecycle.md#grp-0109-分组赛段) | 分组赛段：四态、成员完整性、来源指纹、组数、消费保护 |
| `CONC-` | [concurrency.md](concurrency.md) | 锁、OCC、幂等、并发证据 |
| `SCOR-` | [scoring.md](scoring.md) | 评分事实、评委组、评分门 |
| `RES-` | [results.md](results.md) | 结果快照、公示、撤销、归档 |
| `TICK-` | [tickets.md](tickets.md) | 票据、凭证、访问、限流 |
| `DEPL-` | [deployment.md](deployment.md) | 发布产物一致性与部署边界 |
| `RT-` | [realtime.md](realtime.md) | 实时核心：通知-only、版本、鉴权、有界资源、核心独占 |

每条不变量的格式：

- **规则**：一句话，必须能写成测试断言。
- **为什么**：对应的真实事故或反复出现的 fix。
- **必须攻击的形状**：至少这些反例要被测试覆盖。
- **Plus 要求**：新实现需要提供的能力，不规定具体技术。

## 使用纪律

1. 每条不变量至少有一个 **golden fixture** 和一个 **反例测试**（contract 或
   property test）。只有 happy path 的测试不算覆盖。
2. 新功能如果与某条不变量冲突，先改不变量文档并说明理由，不能只改代码。
3. 生产事故先修 `main`；如果暴露的是领域规则，再同步到这里，用 Plus 自己的
   实现重新满足。真实活动不作为彩排或 cutover 验收前置。
4. 编号永不复用。废弃的规则保留并标注 `DEPRECATED`，说明被哪条取代。
