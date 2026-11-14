# ADR-0042: 授权读取账号当前状态，账号管理由 account.manage 收口

- **Status**: accepted
- **Date**: 2026-11-14

## 背景

登录时会把 roles/permissions 写入 `local_session` 快照，后续请求直接读这份快照。
于是管理员降权、停用或删除账号后，已登录会话仍持有旧权限，最长持续到 8 小时
session TTL。同时工作人员只能通过 CLI `create-account` 创建，缺少管理员自助的
账号生命周期：邀请、改角色/权限、停用、撤销会话。

这不是前端问题：授权判断本身使用了错误的数据源。

## 决策

1. `local_session` 只证明“曾经认证过”。每次请求 join `local_account`，要求
   `active = true`，并使用账号当前的 roles/permissions 作为授权依据。
2. `local_session` 的 roles/permissions 列保留为登录时刻的不可变审计记录，
   不再参与授权；同时删除只读快照的 repository 入口，避免重新引入。
3. 新增 `account.manage` 权限与管理 API：账号列表、创建、更新（角色、权限、
   启用状态、重置密码）、撤销全部会话。每次变更在同一事务写 `audit_entry`
   （`capability = account`）。
4. 停用与重置密码在同一事务撤销该账号的全部会话；权限编辑不撤销会话，因为授权
   已经读取账号当前状态。
5. 至少保留一个启用的 `account.manage` 账号；否则拒绝变更（`LAST_ADMIN`）。
6. Web 端新增 `/accounts` 页面，只对持有 `account.manage` 的账号可见。

## 替代方案

- **定时刷新会话快照**：仍存在窗口，且刷新频率只是把窗口变短，否决。
- **账号级 `auth_version`**：每次请求少一次 join，但多一份状态、迁移和比较逻辑；
  当前规模下一次主键 join 可接受，保留为未来优化。
- **继续只用 CLI**：无法满足管理员自助的账号生命周期，否决。
- **把账号管理并入 `operations` 读级别**：会把 studio/judge 读者一并带进来，
  权限过宽，否决。

## 后果

- 降权、停用、删除账号在下一次 HTTP 请求或下一次实时订阅时生效；已经打开
  的实时连接在最迟一个心跳内被关闭，不能继续订阅。
- `local_account(actor_id)` 是唯一索引，`local_session(actor_id)` 有索引：
  每请求的账号 join 不再扫描整张账号表。
- 账号编辑使用 `access_revision` 做 compare-and-set；并发编辑返回
  `STALE_REVISION`，不会把刚停用的账号静默改回启用。
- `permissions: ["*"]` 与 `account.manage` 等价，最后一个管理员判断同样识别通配符。
- scrypt 在事务外异步执行，不占用数据库连接或行锁。
- 账号列表默认排除参与者账号并分页；`includeParticipants=true` 才返回报名用户。
- 组织/活动级授权范围仍未建模，留到多租户设计阶段。
- 回归证据：降权后 403、恢复权限后 200、停用后 401、撤销会话后 401、
  最后一个管理员变更返回 `LAST_ADMIN`（409）、陈旧编辑返回 `STALE_REVISION`、
  通配符管理员受同等保护、撤销后的实时连接被关闭。
