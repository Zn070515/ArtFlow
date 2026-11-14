# 安全与压力加固记录（2026-11-14）

## 0. 范围

本记录对应一次本机授权的攻击/压力验证及其修复。目标是一套与生产同形的
`compose` 拓扑：PostgreSQL 18.6（`127.0.0.1:5433`）、Fastify API（`:3100`）、
Vite Web（`:4173`），使用一次性 schema `artflow_attack`。没有触碰生产数据。
浏览器为 6 个 headless Chromium，全部带 `--no-proxy-server`，避免本机系统
代理把回环请求变成 502。

验证结论：链路畅通，没有鉴权绕过、CSRF 绕过、IDOR、SQL 注入、路径穿越、
存储型 XSS、重复投票或并发崩溃。发现的是以下加固项。

## 1. 发现与修复

| # | 发现 | 修复 | 回归测试 |
| --- | --- | --- | --- |
| 1 | API 与边缘缺少 `X-Content-Type-Options`、`X-Frame-Options`、`Referrer-Policy`、CSP、HSTS | API `onSend` 统一设置基线头；`deploy/caddy/sites/v2.caddy` 设置完整 CSP + HSTS；Vite dev/preview 设置基线头 | `apps/api/test/read-surface.test.ts`、`tests/gates/test_deploy_security_headers.py` |
| 2 | 口令只校验 8-128 长度，`password` 可注册 | 注册口令改为 12-128，拒绝常见口令与“口令等于用户名”；契约与运行时双层校验 | `packages/runtime/test/auth.test.ts`、`apps/api/test/auth.test.ts` |
| 3 | 注册接口通过 `USERNAME_TAKEN` 暴露账号是否存在 | 增加每用户名 3/min 限流；保留 409 以维持可用性，彻底消除需要邮箱验证 | `apps/api/test/auth.test.ts` |
| 4 | `/api/public/activities/:publicCode` 没有公开限流 | 增加 120/min/IP 限流，与其他公开读一致 | `apps/api/test/public-vote.test.ts` |
| 5 | `/openapi.json` 匿名可读，暴露 121 条路径 | 改为 `operations` 读级别；匿名 401、参与者 403、组织者 200 | `apps/api/test/auth.test.ts`、`apps/api/test/http.test.ts` |
| 6 | E2E 期间出现 React duplicate key 警告（活动 id） | 未复现根因；在 `fetchOpsActivities` 读边界按 id 去重，避免投影重复时产生重复/遗漏卡片 | `apps/web/src/api/ops.test.ts` |
| 7 | CSP `font-src 'self'` 拦截内联 `data:` 字体 | 改为 `font-src 'self' data:` | 构建产物 + Caddy 实测，无 CSP violation；门禁断言该指令 |

第 7 项是在用生产构建产物和真实 Caddy 配置做 CSP 验证时发现的：`font-src
'self'` 会让设计 token 与图标字体被浏览器拒绝。只跑单元测试不会暴露这个问题。

## 2. 红绿顺序与验证证据

每项都先写失败测试并确认失败，再改实现：

- 运行时口令测试：`validateRegistrationPassword` 尚不存在，测试失败。
- API 响应头测试：`x-content-type-options` 为 `undefined`，测试失败。
- OpenAPI 测试：匿名请求返回 200，测试失败。
- 每用户名限流测试：第 4 次注册仍返回 409，测试失败。
- 公开活动读限流测试：第 1 次请求返回 200，测试失败。
- Web 活动列表去重测试：重复 id 原样返回，测试失败。
- Caddy 门禁：缺少全部安全头，测试失败。

修复后：

| 检查 | 结果 |
| --- | --- |
| `pnpm -C plus run check` | 全部 workspace 通过 |
| `pnpm -C plus run test`（`REQUIRE_DB=1`） | runtime 191、API 123、Web 273、worker 10、contract-tools 108，全部通过 |
| `uv run pytest tests/gates -q` | 29 passed |
| `caddy validate --config deploy/caddy/Caddyfile.plus` | Valid configuration |
| 生产构建 + 真实 CSP 的 headless 浏览器 | `/`、`/results/E2E-DEMO`、登录 → 工作台无 CSP violation |
| 修复后完整攻击探针 | 36/36 通过 |
| 修复项实机复验 | 12/12 通过（头、OpenAPI、口令、公开读限流、活动列表唯一） |
| 修复后浏览器 E2E（干净种子） | 19/19 通过（公开页、报名、工作台、Studio、Live、投票、恢复、分组、签到、模式隔离） |

## 3. 没有改的部分及原因

- **每用户名枚举仍会返回 409**：这是可用性选择。没有邮箱验证时，任何“用户名已存在”
  的反馈都能被枚举；当前用每用户名 3/min + 每 IP 5/min 限制成本。若后续引入邮箱
  验证，再把注册改为“已受理”统一响应。
- **内存限流器**：`selectRateLimiter` 在 `NODE_ENV=production` 下要求注入共享
  limiter，`apps/api/src/main.ts` 已使用 `PostgresRateLimiter`；内存实现只用于开发
  和测试，不是生产缺陷。
- **开发环境 cookie 不带 `Secure`**：`isProductionEnvironment()` 为真时才加；生产
  由 Caddy 终止 TLS，属于预期差异。
- **公开赛果显示内部 contestantId**：`selectPublicResults` 已投影
  `contestantName`，`ResultsView` 使用 `contestantName ?? contestantId`；没有新的
  内部 id 泄露问题。
- **单进程实时广播**：多实例需要 Redis/gateway；当前部署拓扑是单 API，HTTP 恢复
  仍是权威，不在本次范围。

## 4. 复现

```powershell
# 单元/集成测试
$env:ARTFLOW_PLUS_DATABASE_URL = "postgresql://artflow:artflow_dev@127.0.0.1:5433/artflow_plus"
$env:REQUIRE_DB = "1"
pnpm -C plus run test

# 结构门禁（含 Caddy 安全头）
uv run pytest tests/gates -q

# Caddy 语法
docker run --rm -e CADDY_SITE_ADDRESS=example.com `
  -v "${PWD}\deploy\caddy:/etc/caddy" caddy:2-alpine `
  caddy validate --config /etc/caddy/Caddyfile.plus
```
