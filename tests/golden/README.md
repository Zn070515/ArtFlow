# Golden fixtures

本目录存放从 v1 提炼的、与实现无关的业务样例。每个 fixture 描述：

```text
输入事实（活动、赛制、报名、评分、票据……）
→ 执行一个领域命令
→ 期望的领域事件 / 拒绝原因 / 读模型
```

fixture 不绑定 Django、TypeScript 或数据库；v1 的回归测试和 Plus 的 contract
test 都消费同一份输入/期望。这样“旧实现”和“新实现”验证的是同一条规则，而
不是两套各自为政的测试。

## 第一批 fixture

| 文件 | 覆盖不变量 | 场景 |
| --- | --- | --- |
| `result-release-lifecycle.json` | RES-01…RES-06 | 确认 → 发布 → 冻结编辑 → 撤销 → 再发布 → 解锁 |
| `duplicate-score-fact.json` | SCOR-01、SCOR-06 | 快速录分后代录同一席位被拒绝；编辑原分数成功 |
| `capability-reissue-close.json` | TICK-02、TICK-03 | 重新签发/关闭入口与 claim 的并发窗口 |
| `unknown-roster.json` | LIFE-07 | 报名未定时冻结成功、执行失败；名单确定后执行通过 |
| `static-artifact-identity.json` | DEPL-02 | 新镜像的静态产物必须替换旧卷内容 |
| `archive-identity.json` | RES-07 | 活动改名后归档仍导出冻结标题；legacy 行留空 |

## 规则

1. 每个真实事故在 v1 修复后，追加一个 fixture；失败输入和期望拒绝原因都要
   写清楚。
2. fixture 中的 ID 使用稳定的业务键，不使用数据库自增 ID。
3. 时间、随机数和指纹通过显式字段给出，避免“跑两次结果不同”。
4. 期望拒绝时，必须同时断言原因码和“没有产生副作用”。
