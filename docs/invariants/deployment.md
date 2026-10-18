# DEPL — 发布产物一致性与部署边界

**原则**：部署不是“容器起来了”。镜像、静态资产、配置、数据库和入口必须
能证明它们属于同一个版本；任何一处不一致都算失败。

v1 证据：69 条部署/环境类 fix，高频词 `production 23`、`restore 14`、`gate 20`。

---

## DEPL-01 运行时版本必须与镜像内烘焙的版本一致

**规则**：生产容器启动时比较 `ARTFLOW_RELEASE_SHA` 与镜像内
`/app/ARTFLOW_RELEASE_SHA`；不一致直接拒绝启动。发布 workflow 用 tag
commit 作为 build arg。

**为什么**：v1 的 entrypoint 在 APP_ENV=production 下强制这条；发布流程把
`github.sha` 烘进镜像，避免“部署的是 1.0.0，跑的是别的代码”。

**必须攻击的形状**：

- 配置 SHA 与镜像不一致；
- 空白/占位 SHA；
- 重新打 tag 后旧镜像被复用；
- 开发环境误用生产校验。

**Plus 要求**：版本信息进入镜像元数据与启动检查；发布产物不可变；tag、
source、digest、runtime SHA 四层可互相验证。

---

## DEPL-02 客户端产物必须与服务器版本一致

**规则**：静态资产由镜像内的源码生成/收集，并在每次启动时与镜像一致；
collectstatic 必须清理旧目标；所有 Django 进程都能解析 static manifest。

**为什么**：v1 的持久化 `STATIC_ROOT` 让新镜像继续服务旧 JS（ArrowUp 不
生效）；`media`/`realtime` 未挂载 manifest，导致 404 被渲染成 500。修复为
`collectstatic --clear` + 只读挂载 static 卷。

**必须攻击的形状**：

- 重建镜像后引用旧哈希资产；
- 静态卷比镜像新；
- 错误页在没有 manifest 的进程里渲染；
- 只读 worker 无法读取收集结果。

**Plus 要求**：构建产物版本化；部署时替换而不是叠加；所有渲染进程共享同一
份 manifest；页面能证明它加载的 bundle 与服务器版本一致。

---

## DEPL-03 文档化的配置必须真的被转发

**规则**：`.env.*` 模板里记录的每个 settings knob，必须在对应 manifest 的
environment 中出现；模板、manifest 和 settings 三处集合相等。

**为什么**：v1 的 event compose 有 11 个 knob 既没文档也没转发，写了也不
生效；production 有测试专门比较 settings 与 manifest。

**必须攻击的形状**：

- 模板有、manifest 没有；
- manifest 有、settings 不读；
- 不同服务（web/media/realtime）转发不一致；
- 占位值被生产接受。

**Plus 要求**：配置 schema 是单一来源；部署 manifest 由 schema 生成或校验；
启动时拒绝未知/缺失的关键配置。

---

## DEPL-04 一个公开来源，内部进程不发布端口

**规则**：浏览器只看到一个 origin；`/media/*` 和 `/ws/*` 由同一来源代理到
专用 worker；web/media/realtime/db 不直接发布 host port。

**为什么**：v1 的 event profile 只发布 proxy；否则页面会从 8000 拼 WebSocket
URL 去连 Gunicorn，实时协作静默退化为轮询。

**必须攻击的形状**：

- 多端口/多 origin；
- 直接访问内部 worker；
- WebSocket 指向错误的进程；
- cookie/CSRF 作用域不一致。

**Plus 要求**：边缘只有一个入口；内部服务只在内网；代理按路径路由；前端
所有 URL 从同源推导。

---

## DEPL-05 liveness 与 readiness 分离，可选依赖不得拖垮主站

**规则**：liveness 只证明进程活着；readiness 证明数据库/迁移等关键依赖可用；
Redis/realtime 是可降级依赖，不得让整个 HTTP 站点不可用。

**为什么**：v1 的 event compose 曾因 Redis 不健康导致 proxy 永远不启动，
整站不可用；修复为 `service_started` + HTTP fallback。

**必须攻击的形状**：

- Redis 挂掉导致整站 502；
- 数据库短暂抖动导致容器被重启；
- health 检查执行昂贵查询；
- readiness 通过但迁移未完成。

**Plus 要求**：健康检查分层；可选依赖降级有明确行为；边缘等待关键服务，
不等待增强服务。

---

## DEPL-06 备份/恢复必须验证数据库引用的每个文件

**规则**：备份清单枚举数据库实际引用的文件字段；恢复演练必须证明每个
路径存在、可读、哈希一致；不得只验证“目录树自洽”。

**为什么**：v1 的恢复 walk 曾是手写三模型列表，漏掉 cover/media/
derivative/export；manifest 计数不完整。

**必须攻击的形状**：

- 数据库引用但磁盘缺失；
- 磁盘有但数据库不引用；
- 哈希不匹配；
- 恢复后权限/属主错误。

**Plus 要求**：文件清单从 schema 派生；恢复是自动化契约测试；备份/恢复
不包含 secrets；演练有可审计报告。

---

## DEPL-07 发布是 tag 驱动的，生产锁版本或 digest

**规则**：只有显式版本 tag 触发镜像发布；生产部署使用版本 tag 或 digest，
不使用 `latest`；镜像带 source/revision OCI label 与 provenance。

**为什么**：v1 的 `publish.yml` 只响应 `v*`；GHCR 同一 digest 发布
`1.0.0/1.0/1/latest/sha-*`；生产建议锁 `1.0.0` 或 digest。

**必须攻击的形状**：

- main push 自动发镜像；
- 生产拉 latest；
- tag 与 digest 不一致；
- package 缺少 source label/provenance。

**Plus 要求**：发布流水线 tag-only；产物不可变；部署清单记录 digest；
回滚按 digest。

---

## DEPL-08 事件/生产 profile 的卷与网络语义必须显式

**规则**：每个 profile 声明数据库是否发布、静态/媒体/备份卷如何共享、哪些
服务只读挂载；配置不能靠“默认行为”。

**为什么**：v1 的 event profile 数据库不发布、proxy 唯一端口、static 只读
挂载到 media/realtime；这些都在事故后写成了契约。

**必须攻击的形状**：

- profile 之间卷语义不同但未记录；
- 数据库意外发布；
- 只读挂载被写；
- 媒体卷与静态卷混用。

**Plus 要求**：部署 profile 是显式配置对象；卷的读写角色有契约测试；生产
与彩排的差异被文档化。

---

## DEPL-09 部署是可在本机复现的，不是“只在学校机器上能跑”

**规则**：CI 与本地使用同一组 Compose/配置契约；关键部署路径（Compose
config、静态构建、镜像构建、迁移）在本地可执行、可验证。

**为什么**：v1 的 compose 契约测试、event runtime 契约、静态构建门禁都在
本机/CI 双跑；部署事故大多先在本地发现。

**Plus 要求**：部署脚本有 smoke test；本地能起“完全体”；CI 验证同一份
manifest；不在生产机器上手工修配置。
