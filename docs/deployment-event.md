# ArtFlow 现场事件部署

本文是面向购买者的本机现场运行路径。它适合一台 Windows 主机运行 Docker Desktop，工作人员在这台主机上操作；如需让同一私人 Wi-Fi/LAN 中的手机访问，再显式启用 LAN 模式。

公网 HTTPS 部署不使用本文件的事件 Compose，而使用 [`deploy/compose.production.yml`](../deploy/compose.production.yml) 和 [生产部署说明](deployment-production.md)。事件启动壳不提供 TLS、公网入口或 DDoS 防护。

## 首次准备

在仓库目录执行：

```powershell
Copy-Item .env.event.example .env.event
```

编辑未提交的 `.env.event`，至少替换：

- `SECRET_KEY`
- `ADMIN_LOGIN_KEY`
- `POSTGRES_PASSWORD`

可以设置 `ARTFLOW_ORGANIZATION_NAME` 作为页面和导出文件的展示名称。它只影响展示，不参与 authority、权限、租户或赛制。

不要把 `.env.event`、密码、数据库文件、媒体或导出文件提交到 Git。

## 本机模式（默认）

默认只允许这台主机访问，端口为 `8000`：

```powershell
pwsh -NoProfile -File scripts/start-event.ps1
```

启动壳会：

1. 检查 Docker Desktop、`.env.event` 和 Compose 文件；
2. 以 `127.0.0.1:8000` 启动事件 Compose；
3. 等待 web/PostgreSQL 健康；
4. 在容器内运行只读 `manage.py doctor`；
5. 检查 `/healthz/`；
6. 输出工作人员访问地址。

它不会删除卷、重置数据库或创建管理员。

## LAN 模式（明确选择）

手机和主机连接同一个私人网络时，显式运行：

```powershell
pwsh -NoProfile -File scripts/start-event.ps1 -Lan
```

启动壳会检测一个有默认网关的非 loopback IPv4 地址，使用 `0.0.0.0` 发布 web 端口，并只把检测到的地址加入 `ALLOWED_HOSTS`。输出中的 LAN URL 才是手机访问地址。

电脑有多个网卡时，显式指定地址：

```powershell
pwsh -NoProfile -File scripts/start-event.ps1 -Lan -HostAddress 192.168.1.27
```

端口可以在 `1024` 到 `65535` 之间调整：

```powershell
pwsh -NoProfile -File scripts/start-event.ps1 -Lan -Port 18180
```

脚本不会自动创建 Windows Firewall 规则。如果 Windows 弹出 Docker Desktop 网络访问提示，只允许 Private networks；不要为此打开 Public networks。若网络仍不可达，先检查主机和手机是否在同一私人网络、是否启用了客户端隔离，以及 Windows Firewall 的 Private 网络规则。

LAN 模式不是公网部署：不要把端口转发到 Internet，不要为它配置公网 DNS，也不要把它当作 DDoS/WAF/TLS 方案。

## 首个管理员

Compose 首次启动只会迁移数据库，不会自动创建管理员。确认启动壳输出的 `doctor` 和健康检查正常后，在本机浏览器打开启动壳输出的：

```text
http://127.0.0.1:8000/setup/
```

如果使用了 `-Port`，将 `8000` 替换为实际端口。填写管理员用户名、密码、确认密码，以及 `.env.event` 中的 `ADMIN_LOGIN_KEY` 作为初始化密钥。该入口使用 CSRF、共享限流和一次性安装状态保护；成功后会自动进入工作人员后台，之后 `/setup/` 不再可用。

不要把初始化密钥当作管理员密码，也不要把任一密钥或密码写入截图、日志、导出文件或聊天记录。若页面提示密钥未安全配置，先替换 `.env.event` 中的 `change-me` 占位值并重新启动服务。

技术人员需要在无浏览器环境中操作时，可以使用一次性命令作为后备路径：

```powershell
docker compose --env-file .env.event -f deploy/compose.event.yml exec web python manage.py provision_first_admin --username event-admin
```

密码会隐藏式读取。该操作只允许成功一次，不支持 reset/force，不创建 Django superuser；密码不能放在命令行参数、`.env.event`、镜像、审计记录或日志中。

## 故障排查

重复运行启动壳是安全的：它只执行 Compose 的启动/等待、只读诊断和健康检查。

- `Missing .env.event`：从 `.env.event.example` 复制并替换占位值。
- Docker Desktop 检查失败：启动 Docker Desktop 后重试。
- `doctor` 失败：按输出修复配置、迁移、数据库或 `static/media` 目录问题，再重试。
- `/healthz/` 失败：查看 `docker compose --env-file .env.event -f deploy/compose.event.yml logs web`，不要把日志直接公开。
- LAN 手机访问失败：确认使用了 `-Lan`，并使用脚本打印的 LAN URL，而不是 `localhost`。

不要使用 `docker compose down --volumes` 排查问题；它会删除本地 PostgreSQL、静态文件和媒体卷。销毁数据必须是单独、明确且已备份的操作。

## 停止与备份

停止服务但保留卷：

```powershell
docker compose --env-file .env.event -f deploy/compose.event.yml down
```

事件资料必须纳入备份，并完成恢复演练。参见 [PostgreSQL 备份与恢复演练](postgres-backup-restore.md)。生产部署另见 [生产准备演练](production-readiness.md)。
