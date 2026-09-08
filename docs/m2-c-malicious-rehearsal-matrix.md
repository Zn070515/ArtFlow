# M2-C 恶意彩排矩阵（Authority / 学校接入）

> 这是一份**授权、隔离、限时**的防御性测试矩阵。默认目标是本机或专用验收环境，不得对学校网络、公共域名、第三方服务或未经授权的地址施压。
>
> 入口：[`production-rehearsal-runbook.md`](production-rehearsal-runbook.md)。本矩阵补充事件日 runbook 的 13 个基础场景，专门覆盖绕过 authority、协议边界、并发竞态、资源消耗、学校身份接入和恢复证据。

## 1. 依据与测试边界

矩阵按以下官方资料组织，而不是只按 URL 逐个点测：

- [OWASP API Security Top 10 2023](https://owasp.org/API-Security/editions/2023/en/0x11-t10/)：对象/属性/函数级授权、认证、资源消耗、敏感业务流、SSRF、错误配置、库存和第三方 API。
- [OWASP Web Security Testing Guide](https://owasp.org/www-project-web-security-testing-guide/stable/)：认证、授权、会话、输入、业务逻辑、客户端和配置测试族。
- [OWASP ASVS](https://owasp.org/www-project-application-security-verification-standard/)：把 Web 控制要求转成可复核的验证项。
- [OWASP Session Management Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html)：token 生命周期、固定、过期、重认证、Cookie 和日志脱敏。
- [OWASP CSRF Prevention Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Cross-Site_Request_Forgery_Prevention_Cheat_Sheet.html)：所有状态改变请求的来源和 CSRF 防护。
- [OWASP SSRF Prevention Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Server_Side_Request_Forgery_Prevention_Cheat_Sheet.html)：只有存在服务端代取 URL、回调或 webhook 时才启用 SSRF 场景。
- [OWASP Denial of Service Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Denial_of_Service_Cheat_Sheet.html)：应用级资源边界和会话资源释放。
- [CISA DDoS Mitigations Guidance](https://www.cisa.gov/sites/default/files/2023-09/TLP%20CLEAR%20-DDOS%20Mitigations%20Guidance_508c.pdf)：大流量 DDoS 只能由部署方在已授权的边缘/供应商演练，不能用本地服务冒充公网 DDoS 证据。
- [NIST SP 800-63B](https://pages.nist.gov/800-63-4/sp800-63b.html)：学校身份绑定、受保护信道、重认证和会话控制。
- [NIST SP 800-61 Rev. 3](https://csrc.nist.gov/pubs/sp/800/61/r3/final)：检测、响应、恢复和证据留存闭环。

### 1.1 安全护栏

每次执行前记录 commit、数据库类型、环境、开始/结束时间和测试身份。测试数据必须可丢弃，并满足：

- 本地/隔离环境；最多 32 个并发客户端、单场景最多 2 分钟、单请求有超时；禁止无限循环、慢速连接和公网扫描。
- 不在 URL、Referer、HTML、浏览器 trace、截图、日志或报告中放原始 token/secret；只使用不可用的 canary marker 和 digest 前缀。
- 不使用 `docker compose down --volumes`、reset 或删除源数据库/源媒体卷。恢复只写入临时隔离目标。
- 发现可能的真实数据、真实学校身份或第三方服务后立即停止该场景并转为 HOLD；不继续“证明”漏洞。
- 大流量、真实 WAF/DDoS、真实 IdP/MFA、学校代理/TLS 和生产备份切换必须由部署方批准，在专门窗口按供应商 runbook 执行。

### 1.2 结果判定

每行记录 `PASS`、`FAIL`、`HOLD` 或 `N/A`，并附请求摘要、响应状态/原因码、状态计数前后差异、审计事件 ID、耗时和日志检索结果。以下是不变量：

1. 未授权、跨活动、跨轮次、跨座位、跨评委或跨来源请求不得写入任何 authoritative fact。
2. 已锁定或已消费的 score、criterion score、ballot、performance/group fact 不得通过直接 ORM、批量 ORM、管理后台或备用 endpoint 改写。
3. `StageAwardDecision` 仍只是候选；只有已确认的 `StageResult` 才能产生正式来源 Award。
4. 重试、并发、连接断开或恢复后重放最多产生一份事实；冲突必须拒绝或返回既有幂等结果。
5. 错误响应不泄露 token、secret、内部 traceback、数据库细节或不属于请求者的数据；审计仍保留可关联但脱敏的证据。

## 2. Authority 与授权绕过矩阵

优先级：`P0` 阻断发布，`P1` 阻断学校试点，`P2` 上线后硬化。`Existing` 表示仓库已有自动化覆盖；`Extend` 表示应在现有测试旁补充；`External` 表示必须在部署环境验证。

| ID | 优先级 | 攻击/绕过思路 | 执行与预期 | 覆盖 |
| --- | --- | --- | --- | --- |
| AUTH-01 | P0 | 跨 activity 的 singer、program、vote option、ticket、performance、round ID | 用同一角色替换每个 path/body ID；返回拒绝且两活动 authoritative 计数不变 | Existing + Extend |
| AUTH-02 | P0 | 跨 round/performance/seat/judge/panel 的合法 ID 拼接 | 让请求中的一个 ID 来自另一上下文；server 只使用已绑定 live context，拒绝混合上下文 | Extend |
| AUTH-03 | P0 | Judge token 访问 Staff、export、unlock、archive、vote、ticket 管理功能 | 逐 endpoint 做 method/role 矩阵；不得因已有 bearer 或可预测 URL 获得函数级权限 | Extend |
| AUTH-04 | P0 | Staff、Participant、Audience 伪造 judge header/body 字段 | 同时提供 `judge_id`、`seat_id`、`source`、`panel_id` 等冲突值；这些客户端选择值必须被忽略或拒绝 | Existing + Extend |
| AUTH-05 | P0 | 恢复已撤销、已过期、不同活动或不同轮次的 grant/session | 在页面打开后撤销/过期，再提交 context、score、terminal action；必须失败且无写入 | Existing + Extend |
| AUTH-06 | P0 | 一次性 QR/token 重放与跨窗口重放 | 两客户端同时 redeem；第一次成功后所有后续使用失败，不能创建第二个有效 session | Existing + PostgreSQL |
| AUTH-07 | P0 | 直接 ORM、`bulk_update`、`bulk_create`、delete、admin action 绕过 service | 在锁定/消费后对原始评分、criterion、ballot、performance/group fact 做每种写操作；必须抛出 authority guard 或无效化 | Existing + Extend |
| AUTH-08 | P0 | 错误来源冒充：DIRECT、STAFF_PROXY、PAPER_DR、import/test 混用 | 伪造 operator、judge、seat、paper reference、reason 或 source；必须拒绝，审计 provenance 不能被客户端决定 | Existing + Extend |
| AUTH-09 | P0 | Award 候选、旧 StageResult、旧 VoteSession 被当成正式 authority | stale/解锁/重新 resolve 后重复 confirm；旧候选和旧 Award 不得进入正式列表或导出 | Existing |
| AUTH-10 | P1 | 仅改一个边界字段：大小写、Unicode、前导零、重复 query key、数组/单值转换 | 对 activity/role/source/purpose 等枚举和标识符做规范化变体；canonicalization 前后权限结论必须一致 | Extend |
| AUTH-11 | P1 | 越权读而非越权写 | 交叉读取 context、审计、导出、受控文件、结果详情；不能用合法公共响应推断另一活动私有数据 | Extend |
| AUTH-12 | P0 | 代理头/Host 影响 authority | 变换 `Host`、`Origin`、`Referer`、`X-Forwarded-*`、scheme/port；未明确配置的代理身份不得改变用户、来源或权限 | Extend + External |

## 3. 认证、会话、CSRF 与泄露矩阵

| ID | 优先级 | 攻击/绕过思路 | 执行与预期 | 覆盖 |
| --- | --- | --- | --- | --- |
| SESS-01 | P0 | 空、截断、超长、错误 scheme、重复 bearer、大小写变体 | 对 judge/entry/ticket 认证入口发送有限变体；统一 401/400，不触发数据库写入和 traceback | Existing + Extend |
| SESS-02 | P0 | session fixation / privilege change reuse | 登录、角色提升、grant redeem、MFA 后比较 session/token 标识；高风险变化应新建或重新确认会话 | Extend + External |
| SESS-03 | P0 | idle/absolute timeout 与撤销竞态 | 过期、撤销、重新登录、浏览器回退、旧 tab 提交；服务端必须拒绝旧会话 | Extend + External |
| SESS-04 | P0 | raw token 进入 URL、Referer、redirect、HTML、trace、日志、审计 | 使用 canary 请求并扫描响应、测试产物和应用日志；只允许 digest/不可逆关联值 | Existing + Extend |
| SESS-05 | P0 | Cookie 属性与跨站提交 | 检查 `Secure`、`HttpOnly`、`SameSite`、Path/Domain、Cache-Control；跨 origin/null origin mutation 必须失败 | Existing + Extend |
| SESS-06 | P0 | CSRF token 缺失、错误、旧 token、双提交不一致 | 对每个 state-changing form/API 做四种请求；不得依赖 UI 隐藏按钮 | Existing + Extend |
| SESS-07 | P1 | 登录/兑换/评分错误的账号枚举和时序差异 | 以不存在、禁用、过期、已使用 token 做定长小样本比较；错误语义不泄露对象存在性 | Extend |
| SESS-08 | P1 | 重试/断线/重复点击 | 在提交后丢弃响应再重发相同和冲突 payload；返回幂等结果或明确冲突，不产生重复事实 | Existing + Extend |
| SESS-09 | P1 | 审计注入与日志污染 | 在可记录字段放换行、控制字符、Unicode confusable 和 canary；日志必须结构化、单事件可关联且不伪造新事件 | Extend |

## 4. 输入、解析器与属性级授权矩阵

| ID | 优先级 | 攻击/绕过思路 | 执行与预期 | 覆盖 |
| --- | --- | --- | --- | --- |
| INPUT-01 | P0 | JSON 为 scalar、array、空值、重复 key、错误 UTF-8 | 所有 JSON mutation 入口各测一组；400/415/413，0 partial mutation | Existing + Extend |
| INPUT-02 | P0 | criterion 重复、漏项、外来 criterion、超范围/负数/非整数 | 评分 payload 与 server rubric 比较；拒绝完整请求且不保存部分分数 | Existing |
| INPUT-03 | P0 | 客户端伪造 total、max、display、judge、source、context version | 删除或篡改每个派生字段；server 从 authoritative snapshot 重算，不能相信客户端总分 | Existing + Extend |
| INPUT-04 | P1 | `NaN`、`Infinity`、极大 decimal、负零、科学计数法 | 使用边界值和有限长度输入；拒绝非有限/溢出值，不让排序、导出或平均值污染 | Existing + Extend |
| INPUT-05 | P1 | 深层嵌套、巨大数组、超长 notes、重复字段 | 在 body cap 内外各测一次；在固定 timeout 内返回 4xx/413，不触发高 CPU/内存增长 | Extend |
| INPUT-06 | P1 | Unicode normalization/confusable/control chars | activity/role/purpose/reason/name 字段做 NFC/NFKC、控制字符和换行测试；显示安全且 authority 不混淆 | Extend |
| INPUT-07 | P1 | Content-Type、Content-Length、chunked/空 body 不一致 | 仅用本地短请求、有限 body；服务端拒绝歧义解析，不进入业务服务 | Extend |
| INPUT-08 | P1 | 文件名、MIME、扩展名和魔数不一致 | 上传受控小文件、双扩展名、不可读文件；受控文件访问不变成静态公开路径 | Existing + Extend |
| INPUT-09 | P1 | 导出筛选、分页、排序、limit/offset 边界 | 负数、超大值、重复筛选和跨活动筛选；响应有上限且不得越权或造成无界查询 | Extend |
| INPUT-10 | P2 | 浏览器草稿/本地存储恢复污染 | 恶意草稿放入错误 context、过期版本和 token-like 字段；客户端只显示草稿，不带 bearer、不自动提交 | Existing + Extend |

## 5. 工作流、竞态与事实生命周期矩阵

| ID | 优先级 | 攻击/绕过思路 | 执行与预期 | 覆盖 |
| --- | --- | --- | --- | --- |
| FLOW-01 | P0 | Panel HOLD/表演 HOLD 时评分 | HOLD 前后各提交一次；均不得产生 direct score receipt，恢复后只能按新 context 提交 | Existing + Extend |
| FLOW-02 | P0 | 表演切换与旧页面提交竞态 | 打开 performance A，切到 B，再提交 A；stale context 拒绝，不写入 B 或 A 的错误事实 | Existing |
| FLOW-03 | P0 | round/activity lock 与评分/投票/材料提交竞态 | 两事务固定顺序并发；锁定获胜时后续 mutation 失败，不能出现半锁定状态 | Existing + PostgreSQL |
| FLOW-04 | P0 | 两评委/两 tab/同 seat 同时提交同一 performance | 2、4、8 个有限并发提交相同和冲突 payload；唯一约束、锁和幂等结果一致 | Existing + PostgreSQL |
| FLOW-05 | P0 | 最低评委人数与最后一份分数同时到达 | 在 resolve/lock 边界并发；要么完整通过，要么安全 HOLD，不能生成缺分 READY | Extend + PostgreSQL |
| FLOW-06 | P0 | unlock → mutate → relock 的旧 context 重放 | 解锁后旧页面、旧候选、旧导出再次提交；必须要求新版本/新 fingerprint | Existing + Extend |
| FLOW-07 | P1 | 网络超时但事务已提交 | 模拟客户端超时后查询并重试；通过 command/idempotency key 找到唯一事实，不靠前端猜测 | Existing + Extend |
| FLOW-08 | P1 | 数据库/web 重启中提交 | 单次重启窗口内发有限请求；恢复后不出现半行、重复 receipt、错误锁状态 | PostgreSQL + External |
| FLOW-09 | P1 | 事件时间、服务器时区、NTP 漂移影响过期/锁定 | 固定时钟或隔离测试 clock；边界前后各执行，审计时间可排序且过期判断服务端一致 | Extend + External |

## 6. 资源消耗、自动化滥用与 DDoS 分层矩阵

本节只做**小规模应用级验证**。它不能证明抗公网 DDoS；公网容量、清洗、WAF、CDN、学校出口和供应商 SLA 只能由部署方另行验收。

| ID | 优先级 | 攻击/绕过思路 | 执行与预期 | 覆盖 |
| --- | --- | --- | --- | --- |
| DOS-01 | P0 | body/query/file 上限绕过 | 测边界值、超限值、不同 Content-Type 和压缩标记；413/400，内存和媒体卷无异常增长 | Existing + Extend |
| DOS-02 | P0 | token/IP/user/forwarded-header 维度轮换绕过限流 | 小规模轮换并比较 bucket；不可信任任意客户端 `X-Forwarded-For`，429 后 retry 不污染状态 | Existing + Extend |
| DOS-03 | P0 | 同一敏感业务流的低速自动化 | 兑换、投票、评分、confirm、导出各做受限重复；限流、幂等、业务配额同时生效 | Extend |
| DOS-04 | P1 | 并发兑换、投票、评分和导出 | 上限 32 客户端、固定窗口、短 timeout；记录 p95、错误率、DB connection 使用，不允许服务失活 | Existing + PostgreSQL |
| DOS-05 | P1 | 轮询/刷新/空请求制造热点 | 对 context、状态、健康和公共列表做短时轮询；匿名健康接口保持可用，业务接口有缓存/限流边界 | Extend |
| DOS-06 | P1 | expensive export/import/search 参数 | 只用小数据集和最大合法分页；响应时间、查询数量和结果大小有预算，超过预算拒绝 | Extend |
| DOS-07 | P1 | 资源耗尽后的恢复 | 结束限流场景后验证正常用户、数据库连接、锁、缓存和审计均能恢复；不接受“重启即修复”作为唯一答案 | Extend |
| DOS-08 | External | volumetric UDP/TCP/HTTP DDoS、slowloris、真实 WAF bypass | 仅在批准窗口由边缘/WAF/供应商执行，验收清洗、告警、联系人、RTO/RPO 和回切；本仓库本地结果标 `HOLD` | External |

## 7. 配置、端点库存与供应链矩阵

| ID | 优先级 | 攻击/绕过思路 | 执行与预期 | 覆盖 |
| --- | --- | --- | --- | --- |
| CFG-01 | P0 | DEBUG、开发密钥、宽 ALLOWED_HOSTS/CSRF origin、错误 proxy trust | 生产 manifest 缺项/占位/宽配置各跑 config/check；启动前失败，不泄露 traceback | Existing + External |
| CFG-02 | P0 | 方法/旧 URL/调试 endpoint 漏洞 | 从 URLConf、模板、JS 和文档生成 endpoint inventory；GET/HEAD/OPTIONS 不得触发 mutation，废弃入口明确 404/410/redirect | Extend |
| CFG-03 | P0 | 安全响应头和缓存错配 | 验证 HSTS、CSP/关键脚本策略、frame/referrer、nosniff、private/no-store；secret/私有文件不进入共享缓存 | Extend + External |
| CFG-04 | P0 | DB、Redis、Docker socket、media 直出或管理端口暴露 | Compose/运行容器端口与网络检查；只暴露 proxy 必要端口，私有文件只能走受控视图 | Existing + External |
| CFG-05 | P1 | 镜像、依赖、构建产物中的 secret | 在 image layers、环境快照、dist、coverage、Playwright trace 和 artifacts 做 secret-pattern 扫描；只接受测试 canary | Extend |
| CFG-06 | P1 | 容器权限与文件系统写入 | 检查非 root、只读路径、媒体目录隔离、临时目录上限和 healthcheck；异常写入不能修改源码或配置 | Existing + External |
| CFG-07 | P1 | 第三方 API/邮件/回调的失败或恶意响应 | 以本地 stub 返回超时、5xx、超大/畸形 JSON、重复响应；不能无限重试、信任未校验字段或放大成本 | Conditional |
| CFG-08 | P1 | SSRF/XXE | 只有代码引入服务端 URL fetch/XML parser 才执行；采用 allowlist、scheme/redirect/IP 解析验证和 egress 隔离，其他情况记录 N/A | Conditional |

## 8. 学校接入与身份治理矩阵

这些项不能由 SQLite 单测替代；至少要有测试 IdP、真实 TLS/反代和学校部署方签字的证据。

| ID | 优先级 | 攻击/绕过思路 | 执行与预期 | 覆盖 |
| --- | --- | --- | --- | --- |
| SCHOOL-01 | P0 | 用 email/name/学号变化冒充同一人，或 subject collision | 同一 IdP subject 改显示属性、两个 issuer 使用同名 subject；authority 绑定稳定 issuer+subject，不以展示字段授权 | External |
| SCHOOL-02 | P0 | SSO assertion issuer/audience/nonce/state/签名/时钟篡改 | 使用测试 IdP 的过期、重放、错误 audience、错误 issuer、nonce mismatch；全部拒绝并可审计 | External |
| SCHOOL-03 | P0 | MFA 缺失、降级、恢复码重放 | 对 unlock、panel 变更、导出、恢复、留存删除等高风险动作强制 MFA/重认证；普通浏览不应升级权限 | External |
| SCHOOL-04 | P0 | SSO 组/角色过度授予或撤销延迟 | 改组、删除组、禁用账号、转学/离职后重新请求；默认拒绝，旧 session 按约定失效 | External |
| SCHOOL-05 | P0 | 学校反代错误传递 scheme/host/client IP | 在 TLS termination、内网 HTTP、错误 proxy header 下检查 redirect、CSRF、审计来源和 rate limit；不能因伪造 header 升权 | External |
| SCHOOL-06 | P1 | 多租户/跨学校数据边界 | 组织、活动、导出、文件、审计和搜索全做 cross-tenant ID 交换；0 越权行、0 越权文件字节 | External |
| SCHOOL-07 | P1 | 导出最小化与 PII 泄露 | 按 Admin/Staff/Judge/学校联络人导出；默认最小字段，敏感字段有审批、审计和有效期 | Extend + External |
| SCHOOL-08 | P1 | retention/purge 与 legal hold 冲突 | 对过期、保全、删除、恢复和审计数据做小样本演练；legal hold 数据不能误删，删除要可证明且不可恢复 | External |
| SCHOOL-09 | P1 | 审计时钟、不可抵赖和证据链 | 校准时钟；验证 actor、subject、scope、reason、request/correlation ID、旧/新摘要和结果；原始 secret 不出现 | Extend + External |
| SCHOOL-10 | P0 | 学校网络断开、IdP 不可用、现场设备失效 | 按纸质评分、人工登记、离线核验、恢复后导入/复核路径演练；不得绕过 authority 直接 bulk 写正式事实 | External |

## 9. 监测、响应与恢复矩阵

| ID | 优先级 | 攻击/绕过思路 | 执行与预期 | 覆盖 |
| --- | --- | --- | --- | --- |
| REC-01 | P0 | 连续失败、跨对象扫描、重复 redeem 的告警缺失 | 触发少量可识别失败序列；能按脱敏 token digest、actor、scope 和 correlation ID 聚合，不能记录 raw secret | Extend |
| REC-02 | P0 | 告警风暴或审计写失败阻断主交易 | 审计存储异常/慢时验证 fail-safe policy：authority mutation 不得静默成功；用户错误不应泄露内部故障 | Extend + External |
| REC-03 | P0 | backup restore 后 authority/唯一约束/审计断裂 | 隔离恢复 dump/media/manifest；跑 migrations、check、事实计数、唯一性、审计抽样和受控登录，源库不变 | Existing + PostgreSQL |
| REC-04 | P1 | web/DB 重启、网络分区、重复消息 | 只在隔离栈注入一次故障；恢复后重试 command，不产生重复分数/票/award，健康检查和锁状态一致 | Existing + PostgreSQL |
| REC-05 | P1 | 事件证据被日志轮转、trace 或错误响应泄露 | 在报告中核对日志保留、访问权限、脱敏、时间线、事件 ID 和样本；保留 canary 证据而非真实 secret | Extend + External |
| REC-06 | P0 | “重启、删库、清卷”作为恢复方案 | 复核脚本和 runbook 不会 reset 源库/源卷；只能切隔离目标或纸质 Plan B，并要求 Admin 批准恢复流量 | Existing + External |

## 10. 执行顺序与放行门禁

### 10.1 本地第一轮（每次变更）

1. 先跑 authority/service 单测、HTTP reason-code 测试、entry/ticket/voting 测试和 `test_m2_c_gate_contract.py`。
2. 再跑 PostgreSQL 锁/并发测试；同一 fixture 重复至少两次，排除偶然通过。
3. 执行 AUTH-01/02/04/05/06/07/08/09、SESS-01/04/05/06/08、INPUT-01/02/03、FLOW-01/02/03/04/06、DOS-01/02/03/04 的 bounded rehearsal。
4. 扫描测试日志、Playwright trace、coverage/artifacts 和工作区，确认没有 raw secret/canary 回显；检查 authoritative 行计数、digest 和审计事件。

### 10.2 学校试点前

所有 `P0` 必须 `PASS`；`P1` 只能有明确 owner、截止时间和临时控制。SCHOOL-01 至 SCHOOL-06、SCHOOL-10、DOS-08、CFG-01/03/04/06 必须在部署方环境取得证据，不能用本地 PASS 替代。SSRF/第三方 API 若功能不存在，保留 `N/A + 代码证据`；功能一旦加入，必须转为 `P0/P1` 测试。

### 10.3 每场报告最小字段

除 `production-readiness.md` 的报告字段外，追加：

| 字段 | 要求 |
| --- | --- |
| 版本与范围 | commit、环境、数据库、是否容器、是否经过 proxy/WAF |
| 攻击集合 | ID、优先级、身份、并发数、body 上限、超时 |
| 结果证据 | HTTP 状态/原因码、耗时、状态计数、审计 correlation ID、日志检索摘要 |
| Authority 证明 | score/criterion/ballot/performance/group fact、StageResult、Award 前后 digest/计数 |
| 失败与处置 | 发现、是否回滚、临时隔离、owner、修复 commit、复测日期 |
| 外部 HOLD | IdP/MFA/TLS/WAF/DDoS/学校网络/留存责任方和签字人 |

