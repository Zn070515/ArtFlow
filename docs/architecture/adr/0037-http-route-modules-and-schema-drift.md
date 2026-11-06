# ADR-0037: HTTP route modules and the schema drift gate

- **Status**: accepted
- **Date**: 2026-11-06

## 背景

`plus/apps/api/src/app.ts` 在 2026-11-06 仍有 3,105 行、115 条路由，和 v1 的
`staff_panel/views.py` 属于同一类维护风险：权限、响应 schema、错误处理和
capability ownership 都堆在一个文件里。与此同时，`db/src/types.ts` 与
`db/src/migrations.ts` 是两份手写事实；TypeScript 只能证明查询符合类型，不能
证明类型符合真实 PostgreSQL。

## 决策

1. 路由按 surface 拆到 `plus/apps/api/src/routes/<surface>.ts`：system、auth、
   public、activity、tasks、registration、grouping、competition、voting、
   archive、publishing。每个模块导出 `registerXRoutes(ctx: ApiContext)`；
   `app.ts` 只保留构造、全局 hooks、CSRF、错误映射与 realtime server。
2. `http/context.ts` 定义 `ApiContext`；`http/schemas.ts` 与 `http/helpers.ts`
   承载共享 TypeBox schema 与无状态 helper。
3. `tests/gates/test_plus_route_modules.py` 阻断：`app.ts` 直接注册路由、未被
   调用的模块、注册数为零的模块、重复 method+URL、`app.ts` 超过 800 行、单模块
   超过 900 行。
4. `plus/packages/db/test/schema-drift.test.ts` 在真实 PostgreSQL 上对比
   `types.ts` 的表、列与可空性；`pnpm -C plus run schema:check` 与 Gates CI
   显式运行。`ColumnType<unknown, …>` 的可空性视为不可判定并跳过，列存在性仍然
   检查。
5. 两条规则写入 `CLAUDE.md` 与 `AGENTS.md`，避免后续 agent 把路由写回
   `app.ts` 或只改 migration 不改类型。

## 被替代的方案

- **一次性重写 app.ts**：没有可验证的中间边界，风险高于收益。拒绝。
- **只加行数告警**：告警不会阻止文件继续增长，也无法发现未注册模块。拒绝。
- **只在测试里查 schema 漂移**：没有明确的 `schema:check` 入口时，CI 步骤容
  易被删掉。采用独立脚本 + 显式 Gates 步骤。
- **让 types.ts 从 schema 自动生成**：长期更优，但需要引入 codegen 工具链；
  当前先用手写类型 + 阻断式对比，保留后续生成的空间。

## 后果

- `app.ts` 从 3,105 行降到 469 行；最大的 surface 模块 477 行。
- 首次运行 drift gate 发现 `registration.review_note` 在 `types.ts` 中声明为
  可空、真实 schema 为 `not null default ''`；已修正类型侧。
- 新增路由的默认落点是 `routes/` 模块，`app.ts` 不再接受新路由。
- 每次 schema 变更必须同时更新 `types.ts`，否则 `schema:check` 失败。
