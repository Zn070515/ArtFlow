# ADR-0002: TypeScript 全栈（Fastify + Drizzle + React/Vite）

状态：proposed（2026-10-19）

## 背景

v2 需要：类型化的领域内核、可共享的请求/响应契约、现代前端（工作台与手机
页面）、以及一个不把领域规则埋进框架装饰器的后端。团队已经维护 TypeScript
前端（rapid score、问卷、Live）。

## 决策

- **领域内核**：纯 TypeScript，无框架依赖（已在 `plus/packages/domain` 起步）。
- **HTTP**：Fastify + Zod（或 TypeBox）做输入校验；插件按模块组织。
- **数据库**：PostgreSQL；Drizzle 负责 schema 与迁移，Kysely 作为备选。
- **前端**：React + Vite + TanStack Query/Router；工作台与现场页面分离。
- **测试**：Vitest 做单元/契约，Playwright 做关键 E2E，`node:test` 可作为
  零依赖的领域测试补充。
- **运行时**：Node 22 LTS（与 CI 一致）。

## 理由

- 领域内核与 HTTP 框架解耦，规则可以单独测试和属性测试；
- Fastify 的插件模型足够表达模块边界，又不要求装饰器/DI 容器；
- Drizzle 让 schema 与迁移显式，便于审查“这次改了什么表”；
- React/Vite 与现有前端资产、Tailwind 经验连续。

## 后果

- 需要一套新的 Node 构建/测试/部署流水线；
- 团队需要维护 Python（v1）与 TypeScript（v2）两套工具链直到 cutover；
- v1 的 Django 模板不会迁移到 v2；页面按 slice 重写。

## 替代方案

- **NestJS**：DI/装饰器带来更多框架耦合；领域内核会依赖框架元数据，否决。
- **Kysely**：更贴近 SQL，但缺少 schema-first 迁移体验；保留为备选。
- **Django + React**：后端仍受 Django ORM/权限模式约束，无法实现“表不共享”
  的模块边界，否决。
