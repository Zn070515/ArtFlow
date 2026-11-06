# ArtFlow-Plus M8e-3：入口切换与回滚

状态：已确认（2026-10-26）
范围：v2 生产镜像与 Compose profile、Caddy 主域名整体切换、只读 smoke、cutover
runbook、回滚边界。
非目标：参与者账号迁移/认领、v2→v1 数据回放、双写、三类活动验证（M8e-4）、
DNS/TLS 申请。

## 决策

- **主域名整体替换**：v2 与 v1 不按活动混跑；切换是 Caddy 主站点的上游替换。
  两套会话/路径不共存。预演在 non-public 环境完成。
- **回滚边界 = 首次 v2 正式写入前**。切换后 v1 保持只读；在 v2 产生第一笔正式
  写入前，把上游换回 v1 即完整回滚。之后进入“只前进”，回滚只能人工重建数据，
  不在本 slice。
- **首个 cutover 在报名截止后**：v2 接管 Ops/Studio/Live/公开赛果；参与者只读。
  导入的报名仍可被 staff 查看；参与者账号认领留给后续 slice。
- **数据独立**：Plus 使用独立 PostgreSQL 库 `artflow_plus`（同主机、独立卷），
  不与 v1 共库；v1 数据库与 media 在切换前完整备份。
- **v1 保留一个完整活动周期**（Q10）：切换后 v1 容器/数据/media 不删除，作为
  回滚与历史查证来源。
- **技术栈**：Plus API 用 esbuild 打成单文件 Node bundle（现有 tsc 产物不能加载
  workspace TS 包）；Plus Web 用 Vite 构建后由 nginx 统一提供静态文件并反代
  `/api`；Caddy 只认一个上游 `plus-web:8080`。

## 部署拓扑

```text
Internet → Caddy (443, 主域名)
             ├─ /healthz → 当前上游
             ├─ v1 profile → web:8000 (+ media:8002, realtime:8001, db, redis)
             └─ v2 profile → plus-web:8080
                              ├─ /api → plus-api:3000
                              └─ SPA 静态文件
                            plus-api → plus-db (artflow_plus)
                            plus-worker → plus-db (outbox relay)
```

- 两个 profile 同时留在 `deploy/compose.production.yml`；v2 服务加
  `profiles: ["plus"]`，v1 服务不受影响。
- Caddy 配置拆成主文件 + `sites/{v1,v2}.caddy`，由
  `ARTFLOW_SITE_PROFILE` 选择；切换 = 改环境变量 + `docker compose up -d proxy`。
- v2 站点不代理 `/ws/*` 与 `/media/*`；媒体字节仍由 v1 提供（窗口内只用于查证）。

## Plus 生产镜像

`deploy/plus/Dockerfile` 多目标：

- `build`：Node 24 + pnpm，安装 workspace，构建 web（`vite build`）、API 和 worker
  （均为 Node 单文件 bundle）。
- `api`：只含 `main.cjs`，`CMD ["node","main.cjs"]`；启动时 `migrate()`。
- `worker`：只含 worker `main.cjs`，启动 250ms outbox relay 与 pg-boss 分钟级
  backstop；生产 API 不开启 inline relay。
- `web`：nginx:alpine + web dist + `deploy/plus/nginx.conf`；SPA fallback，
  `/api` 反代 plus-api，SSE 关闭 buffering，`/healthz`、`/readyz` 透传。

新增 API 脚本 `build:bundle`；根 `plus` 增加 `build:prod`（web + API bundle），
CI 的 gates job 增加该构建步骤，防止部署产物腐烂。

## Compose 变更

`deploy/compose.production.yml` 新增（`profiles: ["plus"]`）：

- `plus-db`：postgres，独立库/卷/凭据。
- `plus-api`：`ARTFLOW_PLUS_API_IMAGE`，env：`NODE_ENV=production`、`APP_ENV=production`、
  `ARTFLOW_PLUS_DATABASE_URL`、`ARTFLOW_PLUS_CREDENTIAL_SECRET`、`PORT=3000`、
  `ARTFLOW_PLUS_TRUST_PROXY`、`ARTFLOW_PLUS_ARCHIVE_DIR`、`ARTFLOW_PLUS_INLINE_RELAY=0`；healthcheck `/readyz`。
- `plus-worker`：`ARTFLOW_PLUS_WORKER_IMAGE`，只连接 `ARTFLOW_PLUS_DATABASE_URL`，负责
  relay；worker 不存在时 `/api/operations/outbox` 会显示未发布 head/pending。
- `plus-web`：同一镜像 target `web`，内部 8080，healthcheck `/healthz`。

`proxy` 服务增加 `ARTFLOW_SITE_PROFILE`（默认 `v1`）与 `./caddy/sites` 只读挂载；
configs 指向新的 `deploy/caddy/Caddyfile.switch`。原 `deploy/Caddyfile` 移动到
`deploy/caddy/sites/v1.caddy`，内容不变；新增 `v2.caddy`。

`.env.production.example` 增加 Plus 变量：
`ARTFLOW_PLUS_API_IMAGE` / `ARTFLOW_PLUS_WORKER_IMAGE` / `ARTFLOW_PLUS_WEB_IMAGE`、`PLUS_POSTGRES_DB`、`PLUS_POSTGRES_USER`、
`PLUS_POSTGRES_PASSWORD`、`ARTFLOW_PLUS_CREDENTIAL_SECRET`、
`ARTFLOW_PLUS_ARCHIVE_DIR`、`ARTFLOW_PLUS_TRUST_PROXY`、`ARTFLOW_SITE_PROFILE`。

## Cutover 流程（runbook）

1. **Preflight**：报名已截止；v1 停止写入（关闭报名/评分入口）；v1 数据库与
   media 备份；`export_plus_bundle`；v2 `import:legacy`（非 dry-run）并核对报告；
   provision staff 账号（`seed_dev_admin` + 权限）；构建/固定镜像 digest。
2. **Bring-up**：`docker compose --profile plus up -d`；内部 smoke（不经公网）。
3. **Switch**：`.env.production` 设 `ARTFLOW_SITE_PROFILE=v2`；`up -d proxy`；
   外部 smoke；观察 15 分钟。
4. **Commit point**：记录第一笔 v2 正式写入的时间与操作；此后回滚窗口关闭。
5. **Rollback（仅 commit 前）**：设回 `v1`、`up -d proxy`、外部 smoke、解除 v1
   只读。v2 在窗口内的写入需在 v1 手工补录（首个 cutover 只允许 staff 小写入）。
6. **Post**：v1 保留一个活动周期；备份策略覆盖 plus DB；监控与告警。

## Smoke

`scripts/cutover-smoke.mjs`（Node 24，无依赖）：

- `GET /healthz` 200；
- `GET /api/public/results/<canary>` 200 且含预期标题；
- 匿名 `GET /api/activities` 401；
- 可选 staff 登录：`POST /api/auth/login` → `GET /api/activities` 200 → cookie
  生效；
- operational profile 还检查 `/api/operations/outbox` 的 relay head 已追平；
- 任一失败退出码 1，输出逐项 PASS/FAIL。

## 测试与验收

- `pnpm -C plus run build:prod` 通过；bundle 能在本地启动并响应 `/healthz`。
- 现有全量 tests + E2E 保持通过。
- `docker compose -f deploy/compose.production.yml --profile plus config` 在提供
  占位 env 时通过；Caddy `validate` 在 runbook 中执行。
- runbook 完成一次 v1→v2→v1 回滚演练（非生产或窗口内）。
- 文档：ADR-0023、roadmap、README、review checklist、KB。

## 边界

- 不做参与者账号迁移/认领；切后参与者只读。
- 不做 v2→v1 双写/回放；commit 后只前进。
- 不做 DNS/TLS 申请、WAF/DDoS、三类活动验证。
