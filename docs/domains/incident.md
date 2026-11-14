# Incident / Recovery

## 目的

给现场问题一个明确的领域对象：谁发现的、影响哪个节目/选手/回合、谁在处理、
何时解决、为什么重开。任务与审计可以间接记录，但组织者在现场需要一条清晰的
“当前事故”视图；`incident` capability 把这条路径做成可授权、可审计的事实。

## 实体

| 实体 | 关键字段 |
| --- | --- |
| `Incident` | `id`、`activity_id`、`mode`、`severity`、`category`、`status`、`title`、`detail`、`location`、`related_type`/`related_id`、`assignee_id`、`resolution`、`opened_by`、`revision`、`created_at`/`updated_at` |

固定枚举：

- `severity`：`low`、`medium`、`high`、`critical`；
- `category`：`participant`、`judge`、`stage`、`technical`、`safety`、`other`；
- `status`：`open`、`acknowledged`、`resolved`；
- `related_type`：`schedule_entry`、`performance`、`round`、`registration`。

`incident` 没有可配置定义，`emptyDefinition` 为 `{ schemaVersion: 1 }`；分类
由能力固定提供，避免每个活动自定义一套事故词表。

## 生命周期

```text
open ──acknowledge──▶ acknowledged ──resolve──▶ resolved
  │                                                │
  └──────────────resolve───────────────────────────┘
                                                   │
                                    reopen ◀───────┘
```

- `open`：title 非空，severity/category/mode 合法；`relatedType` 与
  `relatedId` 必须同时提供或同时为空。
- `acknowledge`：仅 `open → acknowledged`，写入 `assigneeId`。
- `resolve`：`open` 或 `acknowledged → resolved`，`resolution` 必填；resolved
  是终态，普通更新被拒绝。
- `reopen`：仅 `resolved → open`，`reason` 必填；历史审计保留。

## 不变量

- 所有命令要求 `incident.manage`，活动必须 `active`。
- `acknowledge`/`resolve`/`reopen` 携带 `expectedRevision`；不匹配返回
  `STALE_REVISION`。`open` 创建新行，不参与 OCC。
- mode 在命令输入校验，读面按 mode 过滤；test/rehearsal 事故不进入 formal 视图。
- 事故只做观测与恢复记录，不改变其他 capability 的 gate。
- 所有变更走 `executeCommand`：receipt + audit + fact + outbox 同一事务。
- Portal 无公开面；事故只在 Ops/Live 内部可见。

## 领域事件

`IncidentOpened`、`IncidentAcknowledged`、`IncidentResolved`、`IncidentReopened`。

## v1 证据

v1 没有独立事故对象；现场问题散落在任务备注、群消息和事后复盘里，无法查询
“当时谁在处理、影响了哪个节目、何时解决”。这属于 v2 新增能力，不是 v1 迁移。

## Plus 要求

- 独立 `incident` capability，不塞进 `tasks`；任务仍负责准备清单。
- Ops 提供 `IncidentCard`（打开/确认/解决/重开），Live 提供只读
  `IncidentSummary`。
- Stage Show / Singer / Review Pack 提供可选开关“是否需要现场事故记录？”，
  默认关闭；启用后 Ops 才出现卡片。
- 事件必须在 `dynamic-dependencies.json` 声明为 Ops 读模型消费边。

## 待决问题

- post-event feedback（活动后反馈）是同一 milestone 的后续 slice，尚未实现。
- 事故与任务/诊断之间只通过 `related_type`/`related_id` 弱关联，不建立级联。
- 未解决事故是否阻塞活动关闭/归档尚未定义；当前只做观测，不设 gate。
