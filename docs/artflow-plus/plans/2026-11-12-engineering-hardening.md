# 工程加固：文件拆分、DB 生成链、L3/L4 测试与文档口径

日期：2026-11-12。
范围：`plus/` 与 `docs/`。
上游材料：[契约测试任务书](../specs/2026-11-11-contract-testing-program-design.md)、
[自审计测试体系设计](../specs/2026-11-11-self-auditing-test-system-design.md)。

## 1. 目标与边界

这一轮不新增产品能力，只处理持续维护成本：

1. 拆分超过约 900 行的单文件，保留公开 API 与行为；
2. 把数据库的“迁移 + 手写类型”双份维护改成生成链；
3. 按任务书补齐 L3（生成式/模型测试）与 L4（Journey runner）；
4. 统一文档口径：权威文档只描述 Plus 单线，历史文档显式标记。

不做：全仓拆分、重写测试框架、引入 Pact Broker、改写历史 ADR/计划文档。

## 2. 文件拆分

| 原文件 | 行数 | 拆分结果 |
| --- | ---: | --- |
| `apps/web/src/styles/global.css` | 2,477 | `base` / `forms` / `ops` / `studio` / `portal` / `console` 六个 partial；`console` 再分 shell 与 components |
| `packages/db/src/migrations.ts` | 1,743 | `src/migrations/0001..0024_*.ts` + 60 行有序索引 |
| `packages/runtime/src/voting-ticket-service.ts` | 952 | `voting-session-service` / `ticket-service` / `judge-entry-service` / `voting-ticket-shared`，原文件保留为 barrel |
| `packages/runtime/src/publishing-service.ts` | 900 | `publishing-service` / `result-candidate-service` / `publishing-shared` |

保留不变的边界：

- runtime 的公开导出仍由 `packages/runtime/src/index.ts` 提供；旧文件路径继续可导入。
- CSS 级联顺序由 `global.css` 的 `@import` 顺序固定；测试用 `readAllStyles` 递归读取
  partial，断言与打包结果一致。
- 拆分后最大的生产文件为 `tools/contracts/src/graph/build.ts`（879 行）与
  `competition-service.ts`（787 行），低于本轮阈值。

## 3. 数据库单一来源

```text
src/migrations/*.ts
        │  pnpm -C plus --filter @artflow-plus/db run schema:snapshot
        ▼
packages/db/schema.snapshot.json
        │  pnpm -C plus --filter @artflow-plus/db run schema:types
        ▼
packages/db/src/types.ts
```

- 迁移是唯一事实来源；快照由一次性 schema 迁移后从 `information_schema` 生成。
- 类型生成器只保留一张显式 override 表（JSON 列的 select 形态、bigint 序列、
  `never` 更新的时间戳等），其余按 SQL 类型与默认值推导。
- `schema:check` 同时运行：
  - `schema-drift`：`types.ts` 的表/列/可空性与真实 PostgreSQL 一致；
  - `schema-generation`：提交的快照等于迁移结果，`types.ts` 等于快照的生成结果。
- 新增列时只需改迁移（或新增迁移文件）并重新生成两个产物；手改 `types.ts` 会被
  `schema:check` 拒绝。

## 4. L3 / L4 测试

### L3 生命周期模型

`plus/tools/contracts/test/contracts/lifecycle-model.test.ts`：

- fast-check 生成 0–8 个 `answer` / `submit` / `review` 操作与任意 `expectedRevision`；
- 纯模型决定合法边、revision 单调性与 `submit` 的必答前置；
- 真实 Adapter 在 PostgreSQL 上执行，逐步比较状态与 revision；
- 非法操作必须返回 `STALE_REVISION` / `INVALID_TRANSITION` / `INVALID_INPUT` 之一。

### L3 随机命令序列

`plus/packages/runtime/test/registration-service.test.ts` 新增属性测试：

- 随机 `questionKey`、`value`（字符串/整数/null/对象）与 revision；
- 断言所有失败都是 `DomainError`，消息不得出现 SQLSTATE、`duplicate key`、
  `violates`、表名/列名；
- 确定性并发已有会话互斥、命令重试与并发 relay 用例，不重复新增。

### L4 Journey runner

- Spec 是数据：`plus/tools/contracts/journeys/singer-registration-roster.json`；
- 动作表在 `packages/contracts/src/journeys.ts`，spec 通过 TypeBox 校验；
- Runner 在 `apps/api/test/journey.test.ts`，用 `app.inject` 走真实 HTTP：
  organizer 创建 → 激活 → 编译 → 发布 → participant 报名/作答/提交 →
  审核 → 名单定稿；
- `tools/contracts/test/journeys.test.ts` 拒绝未知动作和缺少 `create-activity`
  的 spec。

## 5. 文档口径

- 权威文档清单：`README.md`、`AGENTS.md`、`CLAUDE.md`、`GOAL.md`、
  `docs/development-baseline.md`、`docs/deployment-production.md`、
  `docs/artflow-plus/README.md`、`docs/artflow-plus/roadmap.md`。
- `scripts/check_docs.ps1` 对权威文档禁止 `manage.py`、`Gunicorn`、
  `artflow-web`、`/register/admin/`、`ADMIN_ACCESS_KEY`、`scripts/deploy.sh`。
- v1 时代的运行手册与研究/审计文档在标题后加历史横幅，指向当前基线；
  ADR、按日期的计划/分析保留原文，作为历史证据。
- 当前命令、端口、schema、镜像名只在开发基线与生产部署文档中维护一份。

## 6. 验证

- `pnpm -C plus run check`
- `REQUIRE_DB=1 pnpm -C plus run test`
- `pnpm -C plus run schema:check`
- `pnpm -C plus run build:prod`
- `uv run pytest tests/gates -q`
- `uv run python tests/golden/validate_fixtures.py`
- `pnpm -C plus --filter @artflow-plus/contract-tools run audit:check`
- `pwsh -NoProfile -File scripts/check_docs.ps1`

任何一项失败都视为未完成；不得通过跳过数据库测试或放宽 baseline 获得绿色。

## 7. 存量缺口清理（2026-11-12 第一轮）

- Starter Pack readiness 从 3 条降到 **0**：
  - `stage-show` / `review-awards` 补 `voting` definition（browser identity）；
  - `review-awards` 增加默认启用的 `judge-entry`（ticketing）问题，使评委入口链接有凭证能力。
- 新增 `tools/contracts/api-only.json`：没有 Web 调用方的 mutation route 必须显式声明
  method、path、reason；`audit:check` 与 `graph:check` 都会校验声明仍对应真实路由，
  未知路由、空 reason、重复声明直接失败。
- 首批声明 5 条 API-only：`runtime-facts`（测试 seam）、4 条 legacy 兼容别名
  （rounds prepare、registration answer、materials upload/review）。
- 补齐 3 条真实 UI 路径：
  - Live「关闭评委入口」（带原因）；
  - Studio「重命名活动」；
  - Live/Ops「取消归档」。
- `gap-baseline.json` 从 **156 → 145**；`uiGaps` 从 26 → 18。
- 验证：641 tests、check、schema:check、build:prod、结构门禁 26、Golden、
  `audit:check`（145）、`graph:check`（0 unresolved）、`check_docs` 全绿。
