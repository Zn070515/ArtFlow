# 生产部署说明

本文档说明 ArtFlow 的**生产**运行拓扑。它针对的是面向真实活动的部署；本地开发、Docker Compose 联调和 CI 见 [开发基线](development-baseline.md)。

## docker-compose.yml 不是生产部署文件

根目录的 `docker-compose.yml` 是**本地/联调 Compose**，只用于本机开发：

- `APP_ENV: development`、`DEBUG: "False"`、`ALLOWED_HOSTS: localhost,127.0.0.1`
- 数据库口令 `artflow-local-container-password` 是本地占位值
- 端口仅绑定 `127.0.0.1:8000`
- 没有 TLS、没有反向代理、没有持久化备份目标

**不要把它当作生产 manifest**。在它之上套 `.env.production` 也不能让它变成生产配置——Compose 里硬编码的 `environment` 值仍会生效。生产部署请按下面本节列出的要求单独搭建。

## 生产拓扑

```text
公网 / 局域网客户端
        ↓ HTTPS 443
TLS 反向代理（Nginx/Caddy，负责删除或覆盖客户端传入的 X-Forwarded-For）
        ↓ HTTP 内部网段
Gunicorn（workers 监听 127.0.0.1，不直接暴露公网）
        ↓
PostgreSQL（持久化）+ Media 持久化卷
```

关键约束：**Gunicorn 不能直接暴露给客户端**，必须经过一个可信反向代理。理由见「来源 IP 与 X-Forwarded-For」一节。

## 必填环境项（`.env.production.example` 字段清单）

以 `.env.production.example` 为字段清单，逐项替换为真实值，不能使用占位值（`change-me` / `set-a-` / `example.com` 等，`settings` 的 `validate_production_environment` 会拒绝）：

| 变量 | 作用 |
| --- | --- |
| `APP_ENV` | 必须是 `production` |
| `DEBUG` | 必须是 `False` |
| `SECRET_KEY` | 长随机密钥 |
| `ADMIN_LOGIN_KEY` | ArtFlow 管理员二次认证密钥 |
| `ALLOWED_HOSTS` | 真实主机名（含对外域名） |
| `CSRF_TRUSTED_ORIGINS` | 真实来源（如 `https://artflow.example.com`） |
| `DATABASE_ENGINE` | 必须是 `postgresql` |
| `POSTGRES_DB` / `USER` / `PASSWORD` / `HOST` / `PORT` | 生产数据库连接（口令不能是占位值） |
| `TRUST_X_FORWARDED_FOR` | 见下一节 |

`DATABASE_ENGINE=postgresql` 时生产者连接参数才会被读取；`SECRET_KEY`、`ADMIN_LOGIN_KEY`、`ALLOWED_HOSTS`、`CSRF_TRUSTED_ORIGINS` 和数据库口令在 `APP_ENV=production` 下都会被强校验。

## 来源 IP 与 X-Forwarded-For

应用只在 `TRUST_X_FORWARDED_FOR=true` 时读取客户端提供的 `X-Forwarded-For`。默认（`False`）一律使用 Gunicorn 看到的 `REMOTE_ADDR`。

- 若客户端能直接访问 Gunicorn，它就能伪造 `X-Forwarded-For`，导致审计、投票去重依赖的来源 IP 失真。
- 只有在**可信反向代理会覆盖**客户端传入的 `X-Forwarded-For`（追加/重写而非透传）时，才设置 `TRUST_X_FORWARDED_FOR=true`。
- 使用该设置时，确保代理用 `REMOTE_ADDR` 的真实客户端 IP 填充第一个条目，并丢弃客户端提交的任何值。

## 持久化要求

- **数据库**：使用持久化的 PostgreSQL 卷，不允许容器重建后数据丢失。
- **Media**：上传的文件、生成文档、导出档案存放在持久化卷，并纳入备份目标。
- **静态资源**：由构建产物（`collectstatic`）提供，不依赖运行时 Tailwind CDN。

## 备份目标

事件资产（数据库、Media 上传、生成文档）必须有独立于运行卷的备份目标，并完成恢复演练。见 [PostgreSQL 备份与恢复演练](postgres-backup-restore.md) 和 [生产准备演练](production-readiness.md) 的「PostgreSQL 恢复」场景。

## 健康检查与大小/超时

- 健康检查使用匿名 `GET /healthz/`，只返回通用状态，不泄露配置细节。
- 上传最大值按用途在 `files/services.py` 规定（伴奏/图片 10MB，伴奏音轨 100MB，背景/演出视频最高 500MB）。反向代理和 Gunicorn 的请求体上限、body 读取超时需足够容纳允许的最大上传；超过的请求应在到达应用前被拒绝。
- 视频导出、评分模板生成等耗时操作应配置足够的 worker 超时；不能静默吞掉超时错误。

## 发布门禁

上传前在本地跑完整门禁，见 [生产准备演练](production-readiness.md) 的「发布门禁」。部署用镜像安装 `production` extra。
