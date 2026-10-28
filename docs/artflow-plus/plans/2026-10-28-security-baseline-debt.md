# P0 安全基线还账计划

状态：**第一项待实现**（2026-10-28）  
前置：`artflow-plus` 已建立干净 baseline；不安排真实活动或真实角色彩排。

## 目标

把 v2 当前分散在 API、runtime、DB 和 public credential 服务中的安全约束，整理成一份可
阻断 CI 的安全基线。目标不是换回 Django，也不是一次性重写认证，而是让每个安全断言都有
明确 owner、自动化回归和失败出口。

## 当前已有能力

| 边界 | 当前实现 | 现有证据 |
| --- | --- | --- |
| 本地账号 | scrypt 密码摘要、异步验证、active 检查 | API auth tests、runtime auth service |
| Web session | HttpOnly cookie、SameSite、过期时间、logout 撤销 | `auth.test.ts`、`cookies.test.ts` |
| CSRF | session 派生 HMAC token；cookie 写请求校验；bearer 请求不走 cookie CSRF | API auth/claim tests |
| 读权限 | GET 路由启动期必须声明 `config.access` | API read-surface tests、route hook |
| Public credential | claim/judge/ticket 过期、撤销、重放和 token redaction 已有多处服务测试 | participant/judge/ticket tests |
| 上传 | raw body transport ceiling + capability/material policy | registration/material tests |
| 限流 | 可替换 `RateLimiter`，默认 memory 实现有 sweep | proxy-boundary/rate-limit tests |
| 审计 | command receipt、audit、fact、outbox 同事务 | runtime command tests |

## 逐项出口

### 1. Session / cookie / CSRF 生命周期（第一笔）

- 统一 cookie 序列化，不让 `cookies.ts` 与 `app.ts` 各自维护属性；
- 覆盖登录、注册、logout、过期 session、session rotation、CSRF 缺失/错误/正确、bearer
  请求和 cookie 请求的矩阵；
- 明确生产 `Secure`、`HttpOnly`、`SameSite`、`Path`、Max-Age 和 logout 清理必须一致；
- 禁止响应、receipt、audit、错误日志和前端 JSON 泄漏 session secret。

出口：API focused security tests 通过，且可证明 cookie 与 bearer 两种入口的权限语义一致。

### 2. Credential lifecycle

- claim、judge entry、ticket、supplement 分别记录签发、消费、过期、撤销、重发和跨活动拒绝；
- 对“解析成功后立即 rotate/revoke”的并发窗口做双连接测试；
- 所有一次性原文只存在于成功响应或 URL fragment 的短暂边界，不进入数据库或日志。

出口：每类 credential 都有生命周期矩阵和至少一条并发/重放回归。

### 3. Upload / rate-limit / error surface

- 验证 transport ceiling 与 capability policy 不冲突，失败替换不破坏旧 current；
- 明确 memory limiter 只能用于单进程开发/E2E，多实例生产必须配置共享实现；
- 统一 401/403/404/429/CSRF 错误的可见信息，避免通过错误差异泄漏资源存在性；
- 检查敏感 header、cookie、credential、raw upload 不进入日志和 trace。

出口：安全错误矩阵、生产配置 fail-closed 和上传 redaction 回归通过。

## 执行纪律

每一小项独立分支、独立提交；先写 RED 测试，再实现，合并后在干净 `artflow-plus` 复跑
受影响门禁。任一小项未闭合，不开始下一小项；不混入 schema drift、HTTP route 拆分或 UI
改动。所有运行时证据使用隔离 PostgreSQL、fixture、自动化 smoke 和备份恢复，不依赖真实活动。

