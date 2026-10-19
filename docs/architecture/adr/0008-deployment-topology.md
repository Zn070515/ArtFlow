# ADR-0008: 单来源、不可变镜像、web/media/realtime 分层

状态：proposed（2026-10-19）

## 背景

v1 的现场部署经验：浏览器必须只看到一个 origin；慢媒体下载会占满应用 worker；
静态卷可能让新镜像继续服务旧资产；可选 Redis 不应拖垮整站。

## 决策

- **一个公开来源**：反向代理（Caddy）是唯一入口；`/media/*` 转到 media
  worker，`/ws/*` 转到 realtime，其余转到 web。
- **镜像不可变**：版本 tag/digest 部署；启动时校验 baked SHA 与主机配置一致。
- **静态产物**：构建时生成/收集，部署时替换而非叠加；所有渲染进程共享同一份
  manifest。
- **worker 池**：web（业务）、media（流式下载）、realtime（WebSocket）同镜像、
  不同进程；media/realtime 不发布 host 端口。
- **可选依赖**：Redis 仅用于实时广播；故障时降级到 HTTP 轮询，不影响评分/
  发布/归档。
- **健康检查**：liveness 与 readiness 分离；可选依赖不参与 readiness。
- **发布**：只有显式版本 tag 触发镜像发布；生产锁版本或 digest。

## 后果

- 部署脚本与契约测试需要覆盖上述不变量；
- 现场只暴露一个端口，防火墙与 TLS 配置简单；
- 媒体带宽与 worker 数量的关系仍需在真实网络下演练。

## 替代方案

- **多端口直连**：浏览器 WebSocket URL 会指向错误进程，静默退化为轮询，否决。
- **CDN/对象存储**：可作为后续增强，但不是 v2.0 的必需依赖。
