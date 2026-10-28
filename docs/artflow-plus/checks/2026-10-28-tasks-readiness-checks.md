# M15.2 Tasks / Readiness 自建检查文档

状态：设计阶段；M15.2 完成前必须逐项取得证据。  
范围：独立 `tasks` capability、task authority、readiness read model、Ops UI。  
明确排除：真实活动彩排、签到、排期、资源预约、班次和 incident。

这份文档把“自建责任”变成可执行检查。文档本身不是通过证据；每一项都必须由指定测试、门禁或审阅命令产生结果后再勾选。

## 检查项

| ID | 自建责任 | 必须证明的事实 | 证据位置/命令 | 状态 |
| --- | --- | --- | --- | --- |
| `TASK-DEF-01` | 定义编译与 release 冻结 | 模板 key 唯一、source capability 已启用、编译结果 deterministic/deep-frozen；运行中不读当前 registry | `plus/packages/domain/test/tasks.test.ts`；`pnpm -C plus --filter @artflow-plus/domain test -- tasks.test.ts` | [ ] |
| `TASK-AUTH-01` | capability authority 边界 | task 命令只写 `task_item`、receipt、audit、outbox，不直接修改报名/材料/比赛/投票/发布/归档事实 | `plus/packages/runtime/test/tasks-service.test.ts`；结构搜索与事务测试 | [ ] |
| `TASK-DB-01` | schema 与类型同步 | `task_item` migration、`TaskItemRow`、repository DTO 同一变更；空库迁移可重复 | `plus/packages/db/test/tasks-repository.test.ts`；`pnpm -C plus --filter @artflow-plus/db check` | [ ] |
| `TASK-DB-02` | 版本化同步幂等 | 同一 activity/release/template 只生成一行；重试不覆盖已有状态、负责人、截止时间或理由；不同 release 可产生新版本 | `tasks-repository.test.ts` 的 sync/unique cases；PostgreSQL `REQUIRE_DB=1` | [ ] |
| `TASK-CONC-01` | OCC 与锁顺序 | mutation 按 Activity → task 加锁并锁后重读；旧 revision 返回 `STALE_REVISION` 且无副作用 | `tasks-service.test.ts` 的 stale/concurrency cases；双连接 PostgreSQL test（适用时） | [ ] |
| `TASK-IDEM-01` | receipt 幂等与审计 | 相同 command id 重放原响应；payload 冲突被拒绝；receipt、audit、fact、outbox 同事务 | runtime/API command tests；`command_receipt`/`audit_entry`/outbox assertions | [ ] |
| `TASK-STATE-01` | 显式状态机 | 只允许 spec 定义的 transition；block/complete/reopen reason 非空；非法 transition 不改变行 | `plus/packages/domain/test/tasks.test.ts` 与 runtime focused tests | [ ] |
| `TASK-READ-01` | 自建读权限 | 每个 GET 明确声明 `config.access`；无任务读取权限返回 403；不存在 activity 返回 404 | `plus/apps/api/test/tasks.test.ts`；`pnpm -C plus --filter @artflow-plus/api test -- tasks.test.ts` | [ ] |
| `TASK-READ-02` | 读模型最小暴露 | task/readiness 响应不含 source capability 私有答案、评审备注、token、storage key 或内部凭证 | API response assertions；TypeBox response schemas | [ ] |
| `TASK-READY-01` | readiness 不成为第二 authority | readiness 只聚合 task rows；不会因源事实变化自动关闭任务，也不阻断源 capability command | runtime readiness tests；不变量审阅 | [ ] |
| `TASK-UI-01` | Ops 操作面权限与冲突 | 无 `tasks.manage` 不显示 mutation controls；empty/blocked/overdue 可见；stale mutation 不静默覆盖用户状态 | `plus/apps/web/src/components/ops/TasksCard.test.tsx`、route test、Playwright smoke | [ ] |
| `TASK-RT-01` | realtime 只做失效通知 | task mutation 通过 outbox 发 `tasks.changed`；feature code 不直接打开 socket；HTTP 可独立恢复 | outbox/realtime topic test；`GATE-REALTIME-CORE-01` | [ ] |
| `TASK-MIG-01` | migration 与恢复安全 | migration 前进、重启、备份恢复保留 task rows；不执行 destructive reset 或 source volume 删除 | DB migration test；Plus backup/restore contract gates | [ ] |
| `TASK-DOC-01` | 自建责任可追溯 | spec、roadmap、README、检查文档记录 authority、权限、非目标和验收证据 | `scripts/check_docs.ps1` 与文档审阅 | [ ] |

## 固定执行命令

实现阶段至少执行以下命令；DB 相关命令必须设置 `REQUIRE_DB=1`，使用 Docker
PostgreSQL，并保留源数据库和 volume：

```powershell
$env:ARTFLOW_PLUS_DATABASE_URL = "postgresql://artflow:artflow_dev@127.0.0.1:5433/artflow_plus"
$env:REQUIRE_DB = "1"

pnpm -C plus --filter @artflow-plus/domain test -- tasks.test.ts
pnpm -C plus --filter @artflow-plus/db test -- tasks-repository.test.ts
pnpm -C plus --filter @artflow-plus/runtime test -- tasks-service.test.ts
pnpm -C plus --filter @artflow-plus/api test -- tasks.test.ts
pnpm -C plus --filter @artflow-plus/web test -- TasksCard.test.tsx
pnpm -C plus run check
pnpm -C plus run build
pnpm -C plus run test
uv run pytest tests/gates -q
pwsh -NoProfile -File scripts/check_docs.ps1
git diff --check
```

## 完成判定

只有以下条件同时成立，M15.2 才能在 roadmap 标记完成：

1. `TASK-DEF-01` 至 `TASK-DOC-01` 全部有测试或门禁证据；
2. Plus 全量测试在 PostgreSQL 下运行，没有因数据库不可达而 skip；
3. 没有新增结构门禁 allowlist 例外；
4. 没有真实活动彩排前置条件；
5. `git status --short --branch` 干净，提交已推送到 `artflow-plus`。
