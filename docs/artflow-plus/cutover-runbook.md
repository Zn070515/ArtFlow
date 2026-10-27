# ArtFlow-Plus 入口切换 Runbook（M8e-3）

适用范围：把一个已彩排的 v2 活动接到正式主域名，v1 保留为回滚与历史查证来源。
本文只覆盖**主域名整体替换**；不包含参与者账号迁移、双写或 v2→v1 回放。

## 0. 前提

- 报名已截止，v1 没有进行中的评分/投票/审核写入。
- v2 已在该活动上完成彩排（Studio/Ops/Live/公开赛果各走通一次）。
- 源 SHA 在 `artflow-plus` 上的 Gates（Structural and golden gates + Web public
  journey）为绿；生产镜像只从该 SHA 构建。
- 已构建并固定镜像 digest：`ARTFLOW_PLUS_API_IMAGE`、`ARTFLOW_PLUS_WEB_IMAGE`。
- 域名/TLS 不变；Caddy 仍以 `CADDY_SITE_ADDRESS` 为唯一入口。
- 操作人与观察人明确；回滚决定由现场负责人做出。

## 1. Preflight（v1 仍对外）

1. **冻结 v1 写入**：关闭报名/评分入口；staff 只做只读查证。记录冻结时间。
2. **备份 v1**：按 `docs/postgres-backup-restore.md` 完成数据库备份；备份
   `media/`、`staticfiles/` 与部署 `.env`。备份完成前不得继续。
3. **导出 bundle**（v1 仓库）：
   ```powershell
   uv run python manage.py export_plus_bundle --activity <public_code> --output .\legacy-bundle.json
   ```
4. **构建工具镜像**（同一 Dockerfile 的 build 阶段，含 tsx/workspace）：
   ```powershell
   docker build -f deploy/plus/Dockerfile --target build -t artflow-plus-tools:<sha> .
   ```
5. **接管 Plus**（先 dry-run，再正式；需要 Plus DB 已由 compose 启动）：
   ```powershell
   $network = docker network ls --format "{{.Name}}" | Select-String artflow_internal | Select-Object -First 1
   # 当前活动（决赛尚未开始）：运营接管，生成真正的 Plus Release
   docker run --rm --network $network -e ARTFLOW_PLUS_DATABASE_URL="postgresql://<user>:<pass>@plus-db:5432/artflow_plus" -v "${PWD}\legacy-bundle.json:/bundle.json:ro" artflow-plus-tools:<sha> pnpm --filter @artflow-plus/api import:legacy -- /bundle.json --mode adoption --pack singer-competition --dry-run
   docker run --rm --network $network -e ARTFLOW_PLUS_DATABASE_URL="..." -v "${PWD}\legacy-bundle.json:/bundle.json:ro" -v "${PWD}\import-report.json:/report.json" artflow-plus-tools:<sha> pnpm --filter @artflow-plus/api import:legacy -- /bundle.json --mode adoption --pack singer-competition --report /report.json
   ```
   - **历史活动**用默认 `--mode historical`，只做只读快照；**当前接管**必须用
     `--mode adoption --pack <packId>`，否则导入的 release 不能执行任何命令。
   - 目标能力用 `--enable`/打包问题裁剪；院十佳通常需要
     `voting` 与 `ticketing`，至少确认 `competition`、`registration`、
     `publishing` 已启用。
   - 要求：报告 `checks` 全部 `ok`、`rehearsalReady=true`、`capabilities` 符合
     预期；`warnings` 中列出的历史分数/选票/结果已由负责人确认留在 v1。
6. **Provision staff 账号**：
   ```powershell
   docker run --rm --network $network -e ARTFLOW_PLUS_DATABASE_URL="..." -e ARTFLOW_PLUS_ACCOUNT_PASSWORD="<password>" artflow-plus-tools:<sha> pnpm --filter @artflow-plus/api create-account -- --username <ops> --roles admin
   ```
   每个现场 staff 一个账号；不要把密码写进 shell history（用环境变量或临时文件）。
7. **记录基线**：bundle hash、import 报告路径、v1 备份路径、镜像 digest、当前
   `ARTFLOW_SITE_PROFILE`（应为 `v1`）。

## 2. Bring-up（公网仍走 v1）

```powershell
docker compose -f deploy/compose.production.yml --env-file .env.production --profile plus up -d
docker compose -f deploy/compose.production.yml --env-file .env.production ps
```

内部 smoke（不经过公网域名，直接打 plus-web）：

```powershell
$env:CUTOVER_BASE_URL="http://<host>:<internal-port>"
$env:CUTOVER_PUBLIC_CODE="<canary-code>"
$env:CUTOVER_EXPECTED_TITLE="<活动标题>"
$env:CUTOVER_STAFF_USER="<ops>"
$env:CUTOVER_STAFF_PASSWORD="<password>"
# 当前活动接管用 operational；历史活动验证用 historical（默认）
$env:CUTOVER_PROFILE="operational"
$env:CUTOVER_REQUIRED_CAPABILITIES="competition,registration,publishing"
node scripts/cutover-smoke.mjs
```

全部 PASS 才能进入切换；任何 FAIL 都先修复，不要切换。

## 3. Switch

1. 在 `.env.production` 设 `ARTFLOW_SITE_PROFILE=v2`。
2. 重建 proxy：
   ```powershell
   docker compose -f deploy/compose.production.yml --env-file .env.production up -d proxy
   ```
3. 等 Caddy 健康检查通过，然后对公网域名跑同一个 smoke（`CUTOVER_BASE_URL=https://<domain>`）。
4. 观察 15 分钟：Caddy 5xx、plus-api `/readyz`、plus-web 日志、公开赛果页。

## 4. Commit point

**第一笔 v2 正式写入**（例如 staff 批准报名、Studio 发布、Live 开表演）发生后，
回滚窗口关闭。负责人记录：时间、操作、账号、activity id。

此后只允许向前修复/热修；不得切回 v1 假装无事发生。

## 5. Rollback（仅 commit 前）

1. `.env.production` 设 `ARTFLOW_SITE_PROFILE=v1`。
2. `docker compose ... up -d proxy`。
3. 公网 smoke 确认 v1 恢复；解除 v1 只读。
4. 记录 v2 在窗口内产生的写入（应只有少量 staff 操作）；在 v1 手工补录或明确
   放弃，二者都要写入事件记录。
5. Plus 服务可以保留运行（不回滚数据），等待下一次窗口。

不要在 commit 后回滚；需要时应启动一次新的、带数据重建方案的 cutover。

## 6. Post-cutover

- v1 容器、数据库、media 保留至少一个完整活动周期；期间只读。
- 备份策略覆盖 `plus_postgres_data` 与 `plus_archive_data`；验证一次恢复。
- 监控：Caddy 5xx、plus-api `/readyz`、数据库连接、公开结果页可用性。
- 记录本次切换的 bundle hash、报告、commit 时间与回滚窗口结果。

## 7. 演练

正式活动前至少完成一次：

1. v1 → v2 → v1（在未写入阶段）；
2. 断开 plus-api，确认 plus-web 重启后仍能解析上游；
3. 用过期/错误 staff 密码跑 smoke，确认 FAIL 可读；
4. 从 v1 备份恢复一次到临时库，确认备份可用。

## 8. 明确不做

- 不按活动路由混跑 v1/v2；不共享 cookie/会话。
- 不做 v2→v1 双写或回放；commit 后只前进。
- 不迁移参与者账号；切后参与者只读公开赛果，报名/编辑留给后续 slice。
- 不把 `/media/*` 或 `/ws/*` 暴露到 v2 站点；v2 无对应网关。
