# Tasks / Readiness

## 目的

给 Ops 一个持久、可审计的准备清单：谁负责剩余工作、何时到期、为什么阻塞、是否被
显式重开。`tasks` 只拥有任务事实与任务命令；它可以引用其他 capability 作为来源，
但绝不修改报名、材料、比赛、投票、发布、归档或活动生命周期。

## 实体

| 实体 | 关键字段 |
| --- | --- |
| `TasksDefinition`（Studio） | `schemaVersion`、`templates`（key/title/sourceCapability/sourceKey/required） |
| `task_item` | activity、definition version、template key、status、assignee、dueAt、blockedReason、completionReason、revision |

模板随 Activity Definition Package 冻结；任务实例绑定创建它的 released definition
version。任务能力是可选的，Pack 显式启用。

## 生命周期

```text
(none) ──sync──▶ pending ──start──▶ in_progress ──complete──▶ done
                    │                    │                         │
                    └──block──▶ blocked ─┘                         │
                                              reopen ◀─────────────┘
```

- `tasks.sync` 按模板幂等创建缺失实例，不覆盖既有状态、负责人、截止时间或理由。
- `tasks.assign` / `start` / `block` / `complete` / `reopen` 携带 `expectedRevision`，
  过期返回 `STALE_REVISION`。
- 重开保留历史审计；完成原因与阻塞原因必填。
- readiness 只聚合 task rows，不把其他 capability 的当前状态推断成完成。

## 不变量

- 所有写命令要求 `tasks.manage`，活动必须 `active`。
- 任务命令不写任何 source capability 的事实；模板引用的 source capability 必须在
  同一 Definition Package 中启用（由 tasks compiler 校验）。
- `done` 是终态，普通更新被拒绝；`reopen` 是唯一出口。
- 空模板、阻塞、逾期与 stale revision 都有明确状态，不伪造完成。
- 所有变更走 `executeCommand`：receipt + audit + fact + outbox 同一事务。

## 领域事件

`tasks.changed`（同步、分配、开始、阻塞、完成、重开共用，payload 区分动作）。

## v1 证据

v1 没有独立的任务对象；准备事项散落在 staff 面板备注、群消息和纸质清单里，无法回答
“谁负责、何时到期、为什么卡住”。这属于 v2 新增能力。

## Plus 要求

- 独立 `tasks` capability，不塞进 Activity 或其他 capability。
- Ops 活动详情提供任务清单与准备度卡片；只有 `tasks.manage` 显示 mutation controls。
- 任务事件进入 Consumer Graph；Realtime 只发失效通知，HTTP 仍是恢复权威。
- 默认 organizer 权限不含 `tasks.manage`；启用任务时需显式授予。

## 待决问题

- 任务评论、附件、通知、重复任务与提醒不在当前 slice。
- 任务到期是否升级为事故或阻塞活动关闭尚未定义。
