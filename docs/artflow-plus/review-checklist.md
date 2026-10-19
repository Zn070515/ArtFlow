# ArtFlow-Plus PR 审查清单

每个 PR 在合并前逐项确认。不能确认的项要写明原因，并由 reviewer 决定是否
接受例外；例外需要跟进项。

## 领域规则

- [ ] 改动对应的不变量编号（`docs/invariants/`）已列出；没有新增隐式规则。
- [ ] 改动属于一个明确的 capability；没有把 capability 状态塞回 Activity。
- [ ] 写路径只有一个 command；没有跨 capability 直接读写表。
- [ ] Activity 仍保持薄容器（身份/粗生命周期/enabled capabilities/active release）。
- [ ] Definition 改动走 Package + 对应 capability compiler + cross-capability
      binding 校验；没有把 package 当成一个通用 workflow 图。
- [ ] Execution Session 带 scope 与 mode；并行/冲突策略由组合声明；TEST/REHEARSAL
      与 FORMAL 不在冲突 scope 上重叠。
- [ ] Studio/Ops/Live/Portal 消费同一 authority；没有哪个面自行解释事实。
- [ ] 新增/修改的状态迁移在显式状态机表中；没有 `save(status=...)`。
- [ ] OCC token 是必填；缺 token/旧 token 被拒绝。
- [ ] 错误是带 code 的领域错误，消息可执行；没有裸异常/堆栈。

## 数据与并发

- [ ] 唯一性由数据库约束 + command 双重保证。
- [ ] 锁顺序固定；锁后重新读取；没有 `.get()` 假设行仍存在。
- [ ] 幂等键/receipt 与事实同一事务。
- [ ] 依赖锁的路径有真实 PostgreSQL 双线程测试（如适用）。

## 公开出口

- [ ] 公开事实只来自 snapshot/read model；没有页面自行拼业务条件。
- [ ] 私有媒体只经受控网关；没有静态 media 路由。
- [ ] 撤销/替代/归档后旧 URL、媒体、列表、PDF 都失效。
- [ ] 无 snapshot 的历史保持空白/legacy，不伪造。

## 测试与门禁

- [ ] 领域单元 + 至少一个反例；适用的 golden fixture 已更新并通过。
- [ ] `npm run check:plus` / `test:plus` 通过。
- [ ] `uv run pytest tests/gates -q` 通过；没有新增 allowlist 例外。
- [ ] 结构/类型检查清单没有新增遗漏（pyright/ruff/mypy/tsconfig/Tailwind）。

## 部署

- [ ] 迁移可前滚/回滚；没有不可逆的数据改写。
- [ ] 配置新增项在模板与 manifest 中都出现；没有“写了但不生效”。
- [ ] 静态/媒体/缓存版本与镜像一致；没有依赖旧卷。
- [ ] 生产锁版本或 digest；没有 `latest`。

## 文档

- [ ] domain/ADR/roadmap 已更新（如决策变化）。
- [ ] 事故如果暴露了新规则，已写入 `docs/incidents/` 并加 golden/门禁。
- [ ] 没有把一次性补丁写成永久规则；临时方案有过期条件。
