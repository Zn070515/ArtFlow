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
| [`result-release-lifecycle.json`](result-release-lifecycle.json) | RES-01…RES-06 | 确认 → 发布 → 冻结编辑 → 撤销 → 再发布 → 解锁 |
| [`duplicate-score-fact.json`](duplicate-score-fact.json) | SCOR-01、SCOR-02、SCOR-06 | 快速录分后代录同一席位被拒绝；编辑原分数成功；陈旧上下文被拒绝 |
| [`capability-reissue-close.json`](capability-reissue-close.json) | TICK-01…TICK-03、TICK-06 | 无凭证被拒；重签失效旧码；关闭入口只拒绝新 claim |
| [`unknown-roster.json`](unknown-roster.json) | LIFE-07、CONC-01 | 名单未定时冻结成功（DEFERRED）、执行失败；名单确定后执行通过 |
| [`static-artifact-identity.json`](static-artifact-identity.json) | DEPL-02、DEPL-04 | 新镜像静态产物替换旧卷；media worker 必须能渲染 404 |
| [`archive-identity.json`](archive-identity.json) | RES-06、RES-07、LIFE-05 | 活动改名后归档仍导出冻结标题；legacy 行留空；不导出 fingerprint |

格式见 [`SCHEMA.md`](SCHEMA.md)。校验（不需要 Django）：

```powershell
uv run python tests/golden/validate_fixtures.py
```

## v1 适配器

[`v1_adapter.py`](v1_adapter.py) 把 `result-release-lifecycle` 的稳定事实映射到
v1 的 Django 对象，调用真实的 `release_result_post` / `revoke_result_release` /
`unlock_stage_result`，再按 fixture 的期望比较。拒绝步骤用 `GoldenRejected`
返回原因码，并断言读模型没有变化。

[`test_v1_fixtures.py`](test_v1_fixtures.py) 运行已适配的 fixture；尚无适配器的
fixture 在 `V1_COVERAGE` 里记录对应的 v1 套件，保证“还没适配”是可见状态，而
不是被跳过。

```powershell
uv run python manage.py test tests.golden
```

## 规则

1. 每个真实事故在 v1 修复后，追加一个 fixture；失败输入和期望拒绝原因都要
   写清楚。
2. fixture 中的 ID 使用稳定的业务键，不使用数据库自增 ID。
3. 时间、随机数和指纹通过显式字段给出，避免“跑两次结果不同”。
4. 期望拒绝时，必须同时断言原因码和“没有产生副作用”。
