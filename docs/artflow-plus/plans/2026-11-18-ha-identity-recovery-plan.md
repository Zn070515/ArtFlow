# 2026-11-18 HA、身份与找回实施计划

状态：已完成（2026-11-18）

范围：ADR-0044 的五项交付能力——多副本/S3、CNPG/PITR 参考、TOTP/OIDC、SMTP
密码找回、手动 release readiness。Compose 单节点权威拓扑不变。

## 目标

1. API/worker/web 可运行多副本；媒体/归档使用 S3 共享存储；会话、限流、
   outbox 不依赖进程内存。
2. 提供三实例 CloudNativePG + S3 WAL/数据归档参考，以及恢复到新集群的 PITR
   流程。
3. 账号可绑定 TOTP；支持通用 OIDC 登录与已验证邮箱自动绑定。
4. 账号可选邮箱；忘记密码通过一次性 token + SMTP 自助重置。
5. 发布只准备手动 readiness workflow，不创建 tag、不触发 publish。

## 非目标

- 真实 IdP、真实 S3 bucket、真实 CNPG operator 的端到端验收（需要部署环境）。
- 多集群跨区、bucket 不可变性、密钥轮换自动化。
- Compose 多节点/故障切换。

## 实施

1. 迁移 0036：`local_account` 增加 email、mfa_secret/mfa_enabled、
   oidc_issuer/oidc_subject；新增 `password_reset_token`。重新生成 snapshot/types。
2. `auth-service`：TOTP challenge、登录/验证、enroll/confirm/disable、管理员清
   MFA、找回 token 的签发/消费。
3. `oidc-service`：discovery、授权码 + PKCE、state/nonce/JWKS 校验、账号
   绑定/自动开户。
4. `mail-service`：通用 SMTP，未配置时禁用。
5. `s3-storage`：媒体/归档的 S3 实现与 `ARTFLOW_PLUS_STORAGE_DRIVER` 选择。
6. Web：登录 MFA 步骤、邮箱字段、忘记/重置页、个人中心安全卡。
7. k8s：HA overlay（2 副本 + PDB + S3），CNPG 集群/PITR 参考。
8. 发布：手动 `release-readiness.yml` + release-process 文档。

## Test architecture

- **Capabilities touched**：account/auth（不新增业务 capability）、materials/
  archive 的存储适配器。复用现有 authorization/idempotency/recovery 契约。
- **Consumers**：登录页、个人中心、管理员账号页、公开/受控媒体下载、归档下载。
- **Lifecycle edges**：重置 token 一次性/过期；MFA challenge 5 分钟；OIDC
  state 10 分钟；关闭 MFA 需要密码 + 当前验证码；管理员清 MFA 是独立恢复出口。
- **Adapters**：存储层用 S3 假客户端测试对象读写/Range/删除；SMTP 用注入的
  Mailer 测试 token 生命周期；OIDC 用 stub discovery 测试 URL/state 结构。
- **Fault injection**：无 SMTP 时找回仍返回成功但不发信；无 OIDC 配置时 404/
  disabled；无邮箱账号不生成 token；重复使用 token 拒绝。
- **Anti-bloat**：扩展 auth 测试文件，不新增按端点的矩阵；S3 用内存假客户端，
  不把云 SDK 行为复制成契约。
- **Gates**：`pnpm run check`、全量 test、`schema:check`、`graph:check`、结构
  门禁、Golden、`check_docs`、`build:prod`、Web E2E。

## 证据

- `runtime/test/totp.test.ts`：RFC 6238 向量 + 时钟窗口。
- `runtime/test/oidc.test.ts`：配置开关、授权 URL、state 校验。
- `runtime/test/mail-service.test.ts`：SMTP 配置开关。
- `runtime/test/s3-storage.test.ts`：写入/读取/Range/删除/归档 key 白名单。
- `apps/api/test/identity.test.ts`：找回 token 一次性、旧密码失效、新密码登录、
  TOTP 登录 challenge/验证、OIDC disabled。
