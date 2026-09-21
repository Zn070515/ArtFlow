# M2-D2 结果公示 Release Authority 恶意彩排矩阵

本矩阵只允许在本机或专用隔离 Compose 环境执行。它验证应用层的结果公示 authority，
不是公网容量、WAF 或 volumetric DDoS 证明。彩排 fixture 在非 production 环境创建一组
正式生命周期但专属于演练的活动，脚本结束后只清理该 fixture；不得使用
`docker compose down --volumes`、重置源数据库或访问学校/公共地址。

## 放行不变量

| ID | 恶意动作 | 通过标准 |
| --- | --- | --- |
| RELEASE-01 | 仅把 `RESULT_PUBLICATION` 文章设为 `PUBLISHED` | 详情、结果列表、首页和受控媒体均不可见 |
| RELEASE-02 | 伪造 query 中的 `activity_id`/`stage_result_id` | path-owned post 与 service authority 不被 query 改写；跨活动 stage 返回拒绝 |
| RELEASE-03 | 重放 confirm/release | confirm 和 release 均幂等，不产生重复 active row 或重复 release audit |
| RELEASE-04 | active release 后编辑/换绑文章 | 返回拒绝，标题、版本、activity binding 不变化 |
| RELEASE-05 | revoke 后访问旧 URL/媒体 | 文章和媒体 fail closed，历史 `ResultRelease` 保留 |
| RELEASE-06 | revoke 后重新 release | 只有再次显式管理员操作后恢复可见 |
| RELEASE-07 | unlock 已公示 StageResult | active release 进入 `SUPERSEDED`，旧文章/媒体立即不可见 |
| RELEASE-08 | 扫描响应、归档索引和 inspector | 不出现 cookie、CSRF、token、完整 fingerprint、authority hash、评分或学生私密字段 |

## 运行边界与量化字段

`scripts/m2_d2_result_release_rehearsal.mjs` 只接受 `http://127.0.0.1`、`localhost` 或
`::1`，每个请求超时 5 秒，最多 32 个请求；fixture、session cookie 和 CSRF 值只从
600 权限临时文件读取，不能打印。报告必须记录：总请求数、2xx/3xx/4xx/5xx、timeout、
p50/p95/p99/max、release/revoke/supersede audit 数、历史行数、active 行数和每个检查结果。

预期的成功状态主要是：GET 私有边界返回 404、成功的 POST 返回 302、跨活动 stage 返回
404、active 编辑返回 403；任何 5xx、timeout、越权成功、旧 release 可见或 fixture 清理
失败均为 `FAIL`。本地 p95 只描述当前隔离服务，不外推学校公网容量。

## 2026-09-21 实测记录

Docker Compose PostgreSQL 本地隔离彩排通过：19 个请求，`2xx=5`、`3xx=6`、`4xx=8`、
`5xx=0`、超时 `0`，p50 `28 ms`，p95/p99 `200.65 ms`，最大 `200.65 ms`；19/19
检查通过。审计/历史检查为 `release=2`、`revoke=1`、`supersede=1`、历史 `2` 条、
active `0` 条，最终 stage 为 `READY_TO_CONFIRM`。fixture 清理后活动、规则集、版本、
管理员、文章、release 和专属审计均为零残留；源数据库和 volumes 未重置。该记录仅证明
应用层 release authority，不证明学校边缘容量、WAF 或 volumetric DDoS 防护。

## 生产/学校边界

应用 release audit 只证明 ArtFlow 内部的发布权威和历史可追溯性。学校 SSO、MFA、TLS、
trusted forwarded headers、WAF、连接数/慢连接限制、volumetric DDoS、保存期限、备份
责任和部署 ownership 仍必须由学校或部署方单独验收并保留证据；不得用本脚本替代这些项目。
