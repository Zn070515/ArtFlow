# 变异审计结果（2026-11-11）

日期：2026-11-11。
命令：

```powershell
Set-Location plus
$env:ARTFLOW_PLUS_DATABASE_URL = "postgresql://artflow:artflow_dev@127.0.0.1:5433/artflow_plus"
pnpm --filter @artflow-plus/contract-tools run mutation:audit
```

实现：`plus/tools/contracts/src/audit/mutations.ts` 与 `mutation-cli.ts`。
每个变异临时修改一个关键保证，运行对应契约测试，随后在 `finally` 中恢复原文件；
目标文件有未提交改动时拒绝执行。

## 1. 结果

首次运行 **6/8 caught，2 survived**。补测试后 **8/8 caught**。

| 变异 | 保证 | 首次结果 | 修后 |
| --- | --- | --- | --- |
| `command.audit-removed` | receipt/audit/fact/outbox 同事务 | caught | caught |
| `command.receipt-removed` | 完成命令可从回执重放 | caught | caught |
| `registration.roster-start-removed` | roster final 冻结 start | caught | caught |
| `ticketing.judge-replay-removed` | judge claim 重放返回可用 token | caught | caught |
| `live.sticky-block-removed` | blocked 投影保持到显式 rebuild | caught | caught |
| `realtime.closed-checks-removed` | 异步订阅关闭不产生幽灵订阅者 | **survived** | caught |
| `ticketing.archive-revoke-guard-removed` | 归档活动不能撤销/轮换票据 | caught | caught |
| `material.extension-check-removed` | 不接受的材料扩展名被拒绝 | **survived** | caught |

## 2. 真实发现

### 2.1 材料扩展名校验没有测试

删除 `validateMaterial` 的扩展名判断后，所有测试仍然通过。说明测试只覆盖了正确
扩展名的上传路径，没有覆盖“错误的扩展名必须被拒绝”。

修复：在 `packages/runtime/test/registration-service.test.ts` 增加
`rejects a material whose extension is not accepted`，上传 `song.txt` 到只接受
`.mp3` 的音频题，断言 `MATERIAL_NOT_ALLOWED`。

注意：这仍然不覆盖 #56 的“文件内容不是音频、只靠扩展名”问题；内容 sniffing
仍是开放的产品缺口。

### 2.2 Realtime 关闭竞态只测了 authorize 阶段

最初变异只删除 `authorize` 后的一个 `closed` 检查；测试通过，因为后面还有
snapshot 后的检查和最终检查。这说明两件事：

1. 单点变异可能只是删掉了冗余防线，不能直接当成弱测试；
2. 测试只覆盖了“在 authorize 期间关闭”，没有覆盖“在 snapshot 期间关闭”。

修复：

- 变异改为删除 `connection.ts` 中全部 `if (this.closed) return;`，针对真正的
  保证边界；
- 新增 `does not re-add a subscription when the socket closes during snapshot`，
  用 deferred snapshot 精确控制关闭时机；
- 保留原有的 authorize 阶段用例。

## 3. 自测

`test/contracts/mutation-targets.test.ts` 遍历所有变异，断言：

- 目标文件仍包含 `find` 字符串（CRLF 归一化后）；
- 目标文件还没有包含 `replace` 字符串。

这样变异目标一旦被重构或改名，CI 会失败，而不是把变异静默 skip。首次实现曾因
CRLF 导致 3 个变异被 skip；现在脚本归一化换行，自测也会抓住目标漂移。

## 4. 运行边界

- 变异审计会临时修改工作树，因此**不放进 PR CI**；适合本地或夜间任务。
- 每个变异只跑聚焦测试，不跑全量，保持分钟级成本。
- 变异必须是关键、非冗余的保证；删掉三重防线之一不应被误报为弱测试。
- 存活变异要么补测试，要么明确记录为“该保证没有测试”，不能静默接受。

## 5. 当前状态

- 全量回归 **607 tests** 通过。
- 变异审计 8/8 caught。
- 下一步：把变异审计接入夜间任务；扩展 publishing 消费失效、Outbox relay、
  material content、mode 分区等变异；把 survivor 自动转成 issue 或报告。
