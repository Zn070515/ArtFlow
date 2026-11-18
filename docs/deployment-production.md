# 生产部署说明（ArtFlow-Plus）

本文档只描述当前 `main` 上的 **ArtFlow-Plus（v2）** 生产拓扑。1.x Django 源码已从
`main` 删除，保存在 tag `v1.0.2`；不要把本文档当成 v1 部署说明。

本地开发、Docker 联调和 CI 见 [开发基线](development-baseline.md)。备份与隔离恢复见
[Plus 备份与恢复](artflow-plus/backup-restore.md)。

## 拓扑

```text
客户端
  ↓ HTTPS 443
proxy（Caddy，唯一发布主机端口的服务）
  ↓ artflow_internal
  ├── plus-web   静态前端 + /api 反向代理（不发布主机端口）
  ├── plus-api   Fastify HTTP + WebSocket（不发布主机端口）
  ├── plus-worker outbox relay（不发布端口）
  └── plus-export 可选 export profile；只渲染 DOCX/XLSX（不发布端口、无数据库凭证）
        ↓
plus-db（PostgreSQL 18，持久卷 plus_postgres_data）
```

四个发布镜像（`artflow-plus-api`、`artflow-plus-worker`、`artflow-plus-web`、
`artflow-plus-export`）必须来自同一个 `v*` tag，并在 `.env.production` 中用
`@sha256:...` digest 固定。`plus-export` 是可选 profile：启用时只做文档渲染，
不接数据库、不发布端口；不启用时 API 仍提供 CSV，DOCX/XLSX 返回 503。
`GET /healthz` 匿名可用且只返回通用状态。

## 启动前

1. 从 `.env.production.example` 复制 `.env.production`，替换所有 `replace-me` /
   `set-a-` 占位值。
2. 为 `plus-db` 设置强数据库口令；`ARTFLOW_PLUS_CREDENTIAL_SECRET` 至少 32 字节，
   不要复用数据库口令或 v1 密钥。
3. 四个 Plus 镜像、PostgreSQL 和 Caddy 都必须是 digest 引用；`ARTFLOW_RELEASE_SHA`
   与镜像的 OCI revision 一致。
4. `CADDY_SITE_ADDRESS` 的 DNS 必须已经指向本机，并允许 ACME 流量。
5. `ARTFLOW_PLUS_MEDIA_DIR` 和 `ARTFLOW_PLUS_ARCHIVE_DIR` 指向持久卷；不要把它们
   暴露为静态目录，私有材料只能经 Plus 受控 API 读取。

## 启动

```powershell
docker compose -f deploy/compose.production.yml --env-file .env.production up -d --wait
```

如需 DOCX/XLSX 导出，追加 `--profile export` 启动 `plus-export`；其余服务不需要
profile。只通过 `proxy` 访问服务；`plus-api`、`plus-worker`、`plus-db`、`plus-export`
不发布主机端口。

检查：

```powershell
docker compose -f deploy/compose.production.yml --env-file .env.production ps
curl --noproxy "*" --fail https://<CADDY_SITE_ADDRESS>/healthz
```

## 第一个组织者账号

`/login` 的注册只创建参与者，不能进入 Studio、Ops 或 Live。数据库迁移完成后，
用 API 包里的开户命令创建组织者：

```powershell
$env:ARTFLOW_PLUS_DATABASE_URL = "postgresql://<user>:<password>@<host>:5432/<db>"
$env:ARTFLOW_PLUS_ACCOUNT_PASSWORD = "<强口令，不要提交>"
pnpm --filter @artflow-plus/api create-account --username organizer
```

生产环境也可以直接在 API 容器内执行同一条命令，无需源码树：

```powershell
docker compose -f deploy/compose.production.yml --env-file .env.production \
  exec plus-api node /app/create-account.mjs --username organizer
```

口令由密钥管理提供；不要复用开发库口令。重复执行会更新同一用户名。默认权限覆盖 Studio、报名审核、名单定稿、比赛、评委入口、票据、
投票、结果、归档、材料、签到；Tasks、Schedule、Incident 需要显式追加
`tasks.manage`、`schedule.manage`、`incident.manage`。需要收窄时用 `--permissions a,b`。

## 发布与升级

- 发布只由 `v*` tag 触发；普通 push 不构建生产镜像。
- 升级前先按 [备份与恢复](artflow-plus/backup-restore.md) 生成 Plus 备份。
- 四个镜像必须来自同一个 tag，并在 `.env.production` 中同时替换 digest 和
  `ARTFLOW_RELEASE_SHA`。
- 不要用根目录的本地 Compose 管理生产卷；不要执行会删除 `plus_postgres_data`、
  `plus_archive_data` 或 `plus_media_data` 的命令。

## 运行约束

- `plus-api` 的 `ARTFLOW_PLUS_INLINE_RELAY=0`；outbox 由 `plus-worker` 消费。
- 只有 `proxy` 发布端口；内部服务只在 `artflow_internal` 网络。
- Compose 网络固定为 `172.28.0.0/16`；链路是 Caddy → nginx → API，因此
  `ARTFLOW_PLUS_TRUST_PROXY` 必须覆盖**两跳**（模板默认 `172.28.0.0/16`）。
  留空会让所有公共访客共用 nginx 地址。
- 公共读取按浏览器 `x-artflow-visitor` 计数；写请求另有每 IP 上限
  （`ARTFLOW_PLUS_PUBLIC_IP_CEILING_MULTIPLIER`，默认 200），以适配场馆 NAT。
- 资料上传的传输上限、领域上限和 nginx/Caddy 上限统一为 **600 MiB**；
  旧活动 release 中的较小 `maxBytes` 仍然有效。
- `ARTFLOW_PLUS_METRICS_TOKEN` 设置后，`GET /metrics`（请求头
  `X-Artflow-Metrics-Token`）暴露 Prometheus 文本；未设置时返回 404。
- API 日志级别由 `ARTFLOW_PLUS_LOG_LEVEL` 控制；Compose 的 json-file 驱动
  已配置 50 MiB × 5 轮转。
- 私有媒体和归档包只能经 `/api/.../materials/.../content`、归档下载等受控路由读取。
