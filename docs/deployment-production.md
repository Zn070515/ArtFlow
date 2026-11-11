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
  └── plus-worker outbox relay（不发布端口）
        ↓
plus-db（PostgreSQL 18，持久卷 plus_postgres_data）
```

三个 Plus 镜像（`artflow-plus-api`、`artflow-plus-worker`、`artflow-plus-web`）必须
来自同一个 `v*` release，并在 `.env.production` 中用 `@sha256:...` digest 固定。
`GET /healthz` 匿名可用且只返回通用状态。

## 启动前

1. 从 `.env.production.example` 复制 `.env.production`，替换所有 `replace-me` /
   `set-a-` 占位值。
2. 为 `plus-db` 设置强数据库口令；`ARTFLOW_PLUS_CREDENTIAL_SECRET` 至少 32 字节，
   不要复用数据库口令或 v1 密钥。
3. 三个 Plus 镜像、PostgreSQL 和 Caddy 都必须是 digest 引用；`ARTFLOW_RELEASE_SHA`
   与镜像的 OCI revision 一致。
4. `CADDY_SITE_ADDRESS` 的 DNS 必须已经指向本机，并允许 ACME 流量。
5. `ARTFLOW_PLUS_MEDIA_DIR` 和 `ARTFLOW_PLUS_ARCHIVE_DIR` 指向持久卷；不要把它们
   暴露为静态目录，私有材料只能经 Plus 受控 API 读取。

## 启动

```powershell
docker compose -f deploy/compose.production.yml --env-file .env.production up -d --wait
```

如果部署环境启用了 Compose profile，按环境文档追加 `--profile plus`。只通过
`proxy` 访问服务；`plus-api`、`plus-worker`、`plus-db` 不发布主机端口。

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

生产环境对生产库执行同一命令，口令由密钥管理提供；不要复用开发库口令。重复执行会
更新同一用户名。默认权限覆盖 Studio、报名审核、名单定稿、比赛、评委入口、票据、
投票、结果、归档、材料和签到；需要收窄时用 `--permissions a,b`。

## 发布与升级

- 发布只由 `v*` tag 触发；普通 push 不构建生产镜像。
- 升级前先按 [备份与恢复](artflow-plus/backup-restore.md) 生成 Plus 备份。
- 三个镜像必须来自同一个 tag，并在 `.env.production` 中同时替换 digest 和
  `ARTFLOW_RELEASE_SHA`。
- 不要用根目录的本地 Compose 管理生产卷；不要执行会删除 `plus_postgres_data`、
  `plus_archive_data` 或 `plus_media_data` 的命令。

## 运行约束

- `plus-api` 的 `ARTFLOW_PLUS_INLINE_RELAY=0`；outbox 由 `plus-worker` 消费。
- 只有 `proxy` 发布端口；内部服务只在 `artflow_internal` 网络。
- `ARTFLOW_PLUS_TRUST_PROXY` 只填写直接反向代理的可信 IP/CIDR，默认留空。
- 私有媒体和归档包只能经 `/api/.../materials/.../content`、归档下载等受控路由读取。
