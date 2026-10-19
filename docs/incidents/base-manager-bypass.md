# 事故：`_base_manager` 与批量写路径绕过 authority guard

## 现象

模型的 `objects` manager 已经拒绝直接写，但仍可通过 `_base_manager.update()`、
raw delete 或 `bulk_create(update_conflicts=True)` 改写受保护行；公开结果、
媒体、票据因此能被绕过 service 修改。

## 触发条件

- 守卫只挂在默认 manager 的 `update/delete` 上；
- `base_manager_name` 没有指向同一个受保护 manager；
- 只检查了 `objects` 路径，没有覆盖 bulk/conflict/raw/Admin。

## 根因

把“权限检查”写在了某一条写路径上，而不是把它变成聚合的写入口。Django 提供
多条等价写路径，任何一条漏掉都等于没有守卫。

## v1 修复

- 受保护模型统一 `base_manager_name = "objects"`；
- QuerySet guard 覆盖 `update/delete/bulk_create/bulk_update/conflict upsert`；
- `AuthorityQuerySetMixin` 纳入 `_raw_delete`；
- 新增 authority matrix 测试，逐条攻击所有入口。

## 不变量

- AUTH-01：一个聚合只有一个写命令；
- AUTH-02：受保护写必须有显式 scope；
- AUTH-04：私有媒体不能通过旁路写改变可见性。

## 门禁

- `tests/gates/test_authority_gate.py`：受 guard 的 `objects` 必须是 base
  manager；scope 必须注册；
- 5 个 v1 遗留模型显式列为 debt，新模型不允许加入。

## Plus 要求

- 仓储不暴露通用 `save/update/delete`；
- 所有写经过 command，command 内部做授权与 OCC；
- 数据库约束作为最后一道防线，不是唯一防线。
