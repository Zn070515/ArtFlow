# ADR-0002: TypeScript 技术栈 Baseline

状态：accepted（2026-10-19）

## 背景

v2 需要类型化领域内核、可共享的契约、现代前端、透明的事务/SQL 语义，以及
一个不把领域规则埋进框架装饰器的 HTTP 层。技术选型在 GOAL 与 Capability 模型
稳定后正式封板；后续替换单个库属于新的 ADR，不再重新讨论基础方向。

## 决策

| 层 | 选型 |
| --- | --- |
| Runtime | **Node.js 24 LTS** |
| Language | **TypeScript 7.x，strict** |
| Workspace | **pnpm workspaces**（M2 引入；M1 bootstrap 仍用根 npm 脚本） |
| 架构 | **Modular Monolith**（ADR-0001） |
| HTTP | **Fastify 5**，薄 adapter + composition root |
| API Schema | **TypeBox / JSON Schema**（运行时校验、TS 推断、序列化、OpenAPI） |
| API 文档 | OpenAPI / `@fastify/swagger` |
| Database | **PostgreSQL** |
| DB access | **Kysely**（type-safe SQL，保留显式 `FOR UPDATE`/CTE/事务） |
| Migrations | 显式 module-owned migrations（Kysely Migrator） |
| Async | **Transactional outbox + pg-boss**（ADR-0003） |
| Frontend | **React 19 + Vite 8** |
| Server state | **TanStack Query** |
| Router | **TanStack Router** |
| E2E | **Playwright** |
| Unit / contract | **Vitest + fast-check**（M1 用 `node:test` 完成 bootstrap，M2 收敛） |
| Realtime | HTTP authority + realtime projection；SSE/WS 细节后定（ADR-0008） |

## 理由

- **Fastify 而不是 Nest**：ArtFlow 已经主动建立 Domain/Application/Capability
  边界，不需要再引入一套与之重叠的 DI/module abstraction。Fastify 更薄，适合
  作为 HTTP adapter 与 composition root。（修正旧稿：不是“Nest 会让领域依赖
  decorators”，而是重复抽象。）
- **TypeBox 而不是 Zod**：Fastify 原生运行在 JSON Schema/Ajv 上；TypeBox 同时
  提供运行时校验、TS 推断、Fastify 序列化、OpenAPI 与 contract test。HTTP
  Schema ≠ Domain Model；中间必须有一次显式 mapper。
- **Kysely 而不是 Drizzle**：ArtFlow 大量依赖 PostgreSQL 明确语义（行锁、OCC、
  唯一约束、CTE、snapshot、outbox、projection）。Kysely 不隐藏 SQL，核心包零
  依赖；Drizzle 的 schema-first DX 不是当前最重要的收益。
- **Node 24 LTS**：新项目没有理由锁在更老的 22；pg-boss 要求 Node 22.12+，
  Node 24 完全覆盖。
- **pnpm workspaces**：`apps/` 与 `packages/` 需要统一依赖与脚本；Nx 会引入
  第二套架构规则来源，故不采用，架构门禁由 ArtFlow 自己掌握。
- **Vitest + fast-check**：领域单元/contract/属性测试统一；`node:test` 只作为
  M1 零依赖 bootstrap，M2 迁移后退出。

## 后果

- M1 的 `plus/packages/domain` 继续用根 `npm` + `tsc` + `node:test`；M2 引入
  `pnpm-workspace.yaml`、`apps/api`、`packages/db`、Vitest/fast-check。
- Domain 类型与 API Schema 分离；HTTP 层通过 TypeBox 校验后映射到领域命令。
- Kysely 的 migration 由模块自己拥有；禁止跨模块表访问。
- 任何基础选型变更必须新增 ADR，并说明对 ADR-0001/0003/0005 的影响。

## 替代方案

- **NestJS**：DI/module 抽象与自建边界重叠，否决。
- **Zod**：需要额外桥接 JSON Schema/OpenAPI；TypeBox 更贴合 Fastify，否决。
- **Drizzle**：schema-first 好，但隐藏 SQL 的倾向与 authority-heavy 场景不符，
  否决；Kysely 保留为唯一 DB access。
- **Node 22**：更旧且无收益，否决。
