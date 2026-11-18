# ADR-0044: 多副本、S3 存储、CNPG/PITR、MFA/OIDC 与邮件找回

- **Status**: accepted
- **Date**: 2026-11-18

## 背景

ADR-0043 关闭了现场运行 blocker 后，仍缺五项交付能力：

1. 应用只有单副本，媒体/归档依赖本地卷，数据库没有高可用或 PITR；
2. 没有 MFA/SSO，正式活动管理员仍只有密码；
3. 参与者忘记密码只能由管理员重置；
4. 备份没有定时/异地编排；
5. 没有正式 release 流程。

## 决策

### 多副本与存储

1. API、worker、web 在 HA overlay 中运行 2 副本，并配置 PDB。会话、限流桶、
   receipt、outbox 全部在 PostgreSQL，任何副本都能服务任意请求。
2. 实时通道不需要 Redis：每个副本独立轮询同一个 outbox 并向自己的连接广播
   失效消息；重复消息是幂等的，HTTP 仍是恢复权威。
3. 新增 S3 兼容存储驱动（`ARTFLOW_PLUS_STORAGE_DRIVER=s3`），媒体与归档使用
   同一个 bucket 的不同前缀。本地卷驱动保留给单机部署和测试。
4. 多副本要求 S3（或等价共享对象存储）；本地卷仍是单节点形态。

### 数据库高可用与 PITR

5. `deploy/k8s/cnpg/` 提供 CloudNativePG 三实例集群参考：S3 WAL/数据归档、
   30 天保留、PodMonitor。
6. PITR 采用“恢复到新集群”流程，验证后再切连接串；不在原集群上原地恢复。
7. Compose 仍是单节点权威部署；HA 是 k8s reference，不改变本地/单机路径。

### 账号安全

8. 每个账号可选绑定 TOTP。登录在密码正确后返回短期签名 challenge，验证
   6 位码后才签发会话；challenge 不落库。
9. 通用 OIDC 适配器：授权码 + PKCE + state/nonce；ID token 用 JWKS 验证
   issuer/audience/nonce。已绑定 `(issuer, subject)` 的账号直接登录；已验证
   邮箱与现有账号匹配时自动绑定；否则只有 `OIDC_AUTO_PROVISION=1` 才创建
   participant，绝不通过 IdP claim 授予 staff 权限。
10. 管理员可通过 `account.manage` 清除某账号的 MFA（丢失验证器时的恢复出口）。

### 密码找回

11. `local_account.email` 可选；注册、管理员开户与邀请均可设置。找回接口
    无论账号是否存在都返回同一结果，避免枚举。
12. 重置 token 只存 SHA-256 摘要，30 分钟有效、一次性；消费 token、更新密码、
    撤销全部会话在同一事务内完成。
13. 邮件通过通用 SMTP（`ARTFLOW_PLUS_SMTP_URL` + `ARTFLOW_PLUS_MAIL_FROM`）；
    未配置时找回接口仍返回成功但不发信。

### 发布

14. `release-readiness.yml` 是手动 dry-run：跑 gate 和 `build:prod`，不创建 tag、
    不推送镜像。真正发布仍由维护者签名 tag 触发 `publish.yml`。

## 替代方案

- **Redis 广播**：每副本轮询 outbox 已能正确工作，单活动规模下没有收益，否决。
- **把媒体迁到数据库或 NFS**：S3 是更通用的多节点共享存储，且天然支持 Range，
  否决。
- **CNPG 原地恢复**：会覆盖现有集群，无法先验证，否决。
- **只做 SSO 不做 TOTP**：没有 IdP 的部署仍需第二因素，否决。
- **找回密码用管理员重置代替**：无法自助，且管理员看不到明文密码，否决。

## 后果

- 多副本下迁移可能在滚动更新时由新 Pod 执行；Kysely migrator 的锁会让另一个
  副本等待，但迁移期间旧代码仍可能在线。破坏性迁移仍需单独窗口。
- OIDC 的 IdP、S3 bucket、CNPG operator 都是部署输入；仓库只能验证配置形状与
  单元行为，不能替代真实环境的端到端验收。
- 邮件未配置时，用户看到“已发送”但收不到；部署 readiness 必须检查 SMTP。
- TOTP 为可选；未启用 MFA 的账号仍可用密码登录。
