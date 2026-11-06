# ArtFlow-Plus M8b：参与者 + Ops 注册闭环

状态：范围已确认（2026-10-26）
范围：Cookie + CSRF 认证、参与者自助账号、公开码入口、已发布问卷填写/保存/提交、
Ops 活动列表/报名审核/名单定稿。
非目标：材料字节存储与下载、媒体审核、SSO、邮件验证/找回密码、Studio/Live、
账号管理后台。

## 1. 认证与会话

- 登录成功设置两个 cookie：
  - `artflow_session=<token>`：HttpOnly、SameSite=Strict、Path=/、Max-Age=8h，
    生产环境加 `Secure`；
  - `artflow_csrf=<csrf>`：非 HttpOnly、SameSite=Strict、Path=/、同 TTL。
- CSRF token = `HMAC-SHA256(credentialSecret, "csrf:" + sessionToken)` 的 hex；
  服务端从 session cookie 重新计算比较 `x-csrf-token` header。
- 统一 Fastify `onRequest` hook：对 POST/PATCH/PUT/DELETE：
  - 有 `Authorization: Bearer` → 跳过（API 客户端/现有测试）；
  - 路径为 `/api/auth/login`、`/api/auth/register`、`/api/auth/logout` → 跳过；
  - 有 `artflow_session` cookie → 必须带匹配的 `x-csrf-token`，否则
    `CSRF_INVALID`（403）；
  - 无 cookie 无 Bearer → 交给路由的认证返回 401。
- 新增/修改：
  - `POST /api/auth/login`：保留 `token`（API 客户端兼容）；另返回
    `{actor, csrfToken, expiresAt}` 并设置 cookie。
  - `POST /api/auth/register`：参与者自助账号；用户名 3–64（字母/数字/`_.-`），
    密码 8–128；actorId `participant:<uuid>`，roles `["participant"]`，无权限；
    限流 5/min/IP；重复用户名 `USERNAME_TAKEN`（409）。
  - `GET /api/auth/me`：Cookie 或 Bearer 解析 session；返回
    `{actor, csrfToken, expiresAt}`；未登录 401。
  - `POST /api/auth/logout`：撤销当前 session，清空两个 cookie；幂等。
- `requestActor` 优先读 `artflow_session` cookie，其次 Bearer；新增
  `resolveLocalSession`（返回 token/actor/expiresAt）供 `me`/CSRF 使用。
- 生产缺少 `ARTFLOW_PLUS_CREDENTIAL_SECRET` 时启动失败；开发保留现有 fallback。
- Web 不把 token 写入 localStorage/sessionStorage；所有请求同源代理。
- 新错误码在 `STATUS_BY_CODE` 中登记：`CSRF_INVALID` 403、`USERNAME_TAKEN` 409。

## 2. 新增读端点

| 方法 | 路径 | 权限 | 返回 |
| --- | --- | --- | --- |
| GET | `/api/public/activities/:publicCode` | 匿名 | `{id, publicCode, title, status, registrationOpen}` |
| GET | `/api/activities` | `registration.review` 或 `registration.manage` | 活动摘要列表（含 publicCode） |
| GET | `/api/activities/:id/registrations/mine` | 已登录 | 当前 actor 的报名或 404 |
| GET | `/api/activities/:id/registrations/:registrationId` | owner，或 `registration.review`，或 `registration.manage` | 报名详情 + 冻结问卷 + 材料 metadata |
| GET | `/api/activities/:id/registrations` | `registration.review`/`manage` | 报名列表（含 answers/status/revision） |
| GET | `/api/activities/:id/roster` | `registration.review` 或 `registration.roster.finalize` | `unknown` 或 `final` |

- 公开活动查询只返回公开字段；不返回定义、名单或报名数据。
- `registrations/mine` 必须先于 `registrations/:registrationId` 注册路由。
- 详情 DTO 不含 `schemaHash`、fingerprint、token 或内部存储路径。

## 3. 问卷详情 DTO

```ts
{
  activity: { id, title, status, publicCode },
  registration: {
    id, participantId, status, revision, answers,
    questionnaireVersion, questionnaireHash, reviewNote?
  },
  questionnaire: {
    version,
    questions: [{ key, label, type: "text"|"file"|"notice", required, file? }],
    fileSlots: [{ key, purpose, accepts, maxBytes? }]
  },
  materials: [{ id, questionKey, originalName, contentType, byteLength, status, revision }]
}
```

- 问卷来自报名冻结的 `questionnaireHash` 对应 release，不读当前活动；
  旧报名继续显示旧版问题。
- `file` 题必须用材料 metadata 回答；`notice` 不接受答案。
- 材料只有 metadata：name/contentType/byteLength；字节存储不在本轮。UI 必须显式
  标注“仅登记文件信息，字节存储将在媒体切片开放”。

## 4. 参与者流程

- `/login`：登录/注册切换；成功后回到 `next` 或按角色进入 `/join` 或 `/ops`。
- `/join`：输入活动公开码；`/join/:publicCode`：
  - 公开码不存在 → 404 文案；
  - 活动非 active → “报名未开放”；
  - 已登录：`GET registrations/mine`；404 则 `POST registrations` 创建草稿；
    然后加载详情。
- 表单：
  - `text` → 输入框/文本域；`notice` → 只读说明；`file` → 文件选择后只 POST
    metadata。
  - “保存草稿”：按当前 revision 顺序 PATCH 变更的文本答案；每次响应更新 revision。
  - “提交报名”：POST submit；服务端复核 required 文本与 required file metadata；
    失败显示字段错误。
  - `need_supplement` 显示审核意见并允许补充后再次提交；`submitted/approved/rejected`
    只读。
- 未登录访问 `/join/:publicCode` → 跳转 `/login?next=...`。

## 5. Ops 流程

- `/ops`：活动列表（staff）；链接到 `/ops/:activityId`。
- `/ops/:activityId`：
  - 报名列表：participantId、status、revision、reviewNote；
  - 名单卡：unknown/final、revision、approvedCount、finalizedAt；可定稿。
- `/ops/:activityId/registrations/:registrationId`：
  - 冻结问卷标签 + 答案 + 材料 metadata；
  - 批准 / 需补充 / 拒绝 + note；使用当前 revision；
  - 复核后刷新列表与名单计数。
- 权限由 API 判定；页面只做导航与禁用，不把前端当授权边界。

## 6. 数据与错误

- 无新迁移；复用 `local_session`、`registration`、`material`、`roster`。
- 新增错误码：`CSRF_INVALID`（403）、`USERNAME_TAKEN`（409）。
- 复用：`UNAUTHENTICATED`、`FORBIDDEN`、`NOT_FOUND`、`ACTIVITY_NOT_ACTIVE`、
  `STALE_REVISION`、`INVALID_INPUT`、`MATERIAL_NOT_ALLOWED`、`QUESTION_UNKNOWN`。
- 新增 DB 读函数：`listActivities`、`getActivityByPublicCode`；其余复用
  `getRegistrationByParticipant`、`listRegistrations`、`getRoster`、`listMaterials`、
  `findReleaseByQuestionnaireHash`。

## 7. 前端结构

```text
plus/apps/web/src/
├── api/{client,auth,activities}.ts
├── auth/{SessionProvider,RequireSession}.tsx
├── routes/{__root,index,login,join,joinActivity,ops,opsActivity,opsRegistration}.tsx
├── components/form/{QuestionField,AnswerField,FileMetadataField}.tsx
├── components/ops/{RegistrationTable,RosterCard,ReviewPanel}.tsx
└── styles/global.css
```

- 复用 M8a 的 Afterglow shell/token；表单区用更实的玻璃面板，保证可读性。
- `apiFetch` 自动加 `x-csrf-token`（读 `artflow_csrf` cookie）与
  `credentials: "same-origin"`；统一 `ApiError`（status/code/message）。
- TanStack Query：`me`、public activity、mine、detail、registrations、roster；
  登录/注册/登出后失效相关查询。
- 受保护路由：未登录跳 `/login?next=`；角色/权限只影响导航，不替代 API 校验。

## 8. 测试

- API：
  - login 设置 HttpOnly/SameSite cookie 并返回 csrfToken；me；logout 撤销；
  - 无 CSRF 的 cookie mutation → 403；带 header → 成功；Bearer 跳过 CSRF；
  - 自助注册、重复用户名、弱输入、限流路径；
  - public activity、mine、detail owner/staff、activity list 权限、
    registration list、roster；
  - 现有 Bearer 测试保持通过。
- Web 单元：auth client、ApiError、CodeEntry、QuestionField、FileMetadataField、
  ReviewPanel。
- E2E（同一 `artflow_e2e` schema，扩展 seed）：
  - seed 一个 active 活动 + 直接插入的 `definition_release`（compiled
    questionnaire/materials artifact，含 text/notice/file 题与 file slot）+
    Ops 管理员账号；
  - 参与者注册账号 → 输入公开码 → 填表 → 选文件（metadata）→ 保存 → 提交；
  - Ops 登录 → 打开活动 → 批准报名 → 定稿名单；
  - 断言状态与名单计数。
- CI 复用 `web-e2e` job；不需要新服务。

## 9. 安全与部署

- Cookie 依赖同源代理；Web 与 API 必须同源（Vite dev/preview proxy 或生产反代）。
- `SameSite=Strict` + 会话绑定 CSRF；生产必须配置
  `ARTFLOW_PLUS_CREDENTIAL_SECRET`。
- 开放自助注册是产品选择：限流、用户名/密码约束、审计；后续可加邀请码/邮箱验证。
- 内存限流器是单进程；多实例生产需要共享限流器。
- 材料只有 metadata，不得在 UI 或 API 暗示文件已安全存储；媒体切片再补字节与下载。

## 风险与开放项

- 报名开放/截止目前只由 activity.status=active 控制；没有独立报名窗口。
- 问卷答案包含参与者填写的个人信息；仅 owner/staff 可读，列表/详情不公开。
- 旧报名使用冻结问卷；Ops 详情按 registration 的 hash 读取，不跟随当前 release。
- 材料审核仍可对 metadata 进行，但没有字节可下载；媒体切片必须补齐。
