# Resources / 排练排期设计

状态：已完成（2026-11-18）

## 目标

为 Stage Show 等场景提供场地、设备、人员的**规划资源**与**排练/使用预约**：

- 定义随 Activity Definition Release 冻结；
- 预约有明确生命周期与冲突规则；
- 与 schedule 解耦：预约只占用资源，不改变执行会话或公开节目单；
- 所有变更走单写路径、审计与 OCC。

## 领域模型

### 资源定义（release 内）

```ts
{
  schemaVersion: 1,
  resources: [
    { key: "main-hall", name: "主礼堂", kind: "venue", capacity: 800, notes: "" },
    { key: "piano", name: "三角钢琴", kind: "equipment", notes: "需提前调音" },
    { key: "stage-crew", name: "舞台组", kind: "staff", capacity: 12, notes: "" }
  ]
}
```

- `kind`: `venue` | `equipment` | `staff`
- key 唯一、`[a-z0-9-]{1,80}`；capacity 可选正整数。
- compiler 拒绝重复 key、未知 kind、非法 capacity。

### 预约（活动事实）

`resource_booking`：

- `activity_id`, `resource_key`, `resource_name`（创建时快照）
- `title`, `note`
- `starts_at`, `ends_at`（必须 ends > starts）
- `status`: `draft` | `confirmed` | `cancelled`
- `revision`, `created_by`, `created_at`, `updated_at`
- `cancelled_at`, `cancel_reason`

预约不进入 execution session，不按 mode 分区；它是活动级规划事实。

## 生命周期与冲突

```text
draft ──confirm──> confirmed ──cancel──> cancelled
  └────────cancel────────────────────────┘
```

- **draft**：可自由编辑/删除时间；允许重叠。
- **confirm**：在 `(activity, resource)` advisory xact lock 内检查同资源、非 cancelled
  预约的时间重叠；重叠返回 `RESOURCE_CONFLICT`。
- **update**：draft 直接更新；confirmed 更新后重新做冲突检查（排除自身）。
- **cancel**：必须带非空 reason；终态不可再改。
- 所有更新携带 `expectedRevision`，失败 `STALE_REVISION`。

## 权限与读面

- 写：`resources.manage`
- 读：`resources.manage` 或 `studio.manage` 或 `schedule.manage`
- Ops 卡片展示资源与预约；Live 不消费（资源不是现场执行权威）。
- 公开面不暴露资源预约。

## Archive

第一期不把预约并入归档包；归档闭包不依赖资源预约。后续如需要，在
`archive-package` 增加 `resources.json`/CSV，并保持 release 资源定义与预约快照分离。

## Test architecture

- **Contracts / capabilities touched**：新增 `resources` capability；复用 descriptor /
  authorization / idempotency / transaction 契约，不新增业务契约。
- **Consumers**：Ops 资源卡片、API 读面；无公开读、无实时 topic。
- **生命周期 / 终态**：draft → confirmed → cancelled；cancelled 只读；OCC 冲突；
  跨活动 resourceKey 不共享。
- **Adapter**：新增 `resources` contract adapter（construct booking、execute command、
  read state、declare conflicts），跑共享生命周期模板；不复制模板。
- **故障注入**：两个连接同时 confirm 同一资源重叠预约，只有一个成功；cancel 后
  冲突释放；confirmed 更新到冲突区间被拒。
- **Fault/恢复**：advisory lock 在事务结束自动释放；命令失败无半写入。
- **Anti-bloat**：只新增一个 capability 测试族 + 一个双连接并发用例；不复用
  schedule 的 UI 测试。
- **Focused gates**：domain/runtime/api/web test、全量 test、schema:check、
  graph:check、结构门禁、Golden、check_docs、build:prod、Web E2E（Ops 卡片）。

## 非目标

- 资源库存/成本/外部供应商；
- 自动排程求解；
- 资源预约进入公开节目单；
- 多活动共享资源池（同一活动内才检查冲突）。
