# 重构前待决问题

这些问题不影响 M0/M1 的文档与领域内核，但会在对应 slice 开始前需要决定。
每项都要以 ADR 或 roadmap 更新收口，不能停留在口头。

| # | 问题 | 影响 | 建议 |
| --- | --- | --- | --- |
| Q1 | 学校 SSO / 统一身份是否可用？协议（CAS/OAuth2/OIDC）？ | 认证适配器、账号映射 | 先做本地账号 + 适配器接口；SSO 作为 M8 前置 |
| Q2 | 实时通道选 WebSocket 还是 SSE？是否需要 Redis 广播？ | realtime 进程、降级策略 | WebSocket + 轮询兜底；Redis 只做增强（ADR-0008） |
| Q3 | 媒体/附件存本地卷还是对象存储？ | media 模块、备份、签名 URL | v2.0 本地卷 + 存储适配器；对象存储作为可选 |
| Q4 | 历史数据迁移范围：只迁当前活动，还是全部历史？ | 导入命令、对账、存储 | 先迁当前活动 + 一个历史活动做验证 |
| Q5 | 是否保留 v1 的 XLSX 导出格式？ | 归档/运营习惯 | 保留人读 XLSX + 增加机器可读 JSON |
| Q6 | capability 的 scope 冲突策略由谁声明、如何版本化？（已决，2026-10-19） | execution session、Live 调度 | 每个 capability 在注册时声明 `scopeConflicts`；`validateComposition` 合并参与组合的能力；内核只执行策略 |
| Q11 | Activity Pack 的依赖/冲突/兼容规则如何表达与校验？（已决，2026-10-19） | Studio 引导、capability 注册表 | `CapabilityManifest` 显式声明依赖/冲突；`createCapabilityRegistry` 在组装期校验，`instantiateActivityPack` 在实例化期返回带 code/path 的诊断（M2） |
| Q12 | 第三个“结构不同的活动”选什么来验证抽象？ | 成功标准 §27 | 选一个非比赛/非演出的复杂活动（如评审+颁奖或赛事 bracket）做 slice |
| Q7 | 离线/弱网现场的最低保证？ | 前端缓存、提交重试 | 关键写操作幂等 + 本地待提交队列；不承诺完全离线 |
| Q8 | 可观测性后端（日志/指标/追踪）？ | 部署、运维 | 先结构化日志 + `/healthz`/指标端点；外部后端可选 |
| Q9 | 打印/二维码的正式域名与 HTTPS 由谁提供？ | 现场物料、Caddy/TLS | 学校域名 + 证书；未定前只做彩排码 |
| Q10 | v1 代码删除时间点与保留窗口？ | 仓库结构、CI | cutover 后至少保留一个完整活动周期 |

## 决策纪律

- 每个问题的答案必须落到 ADR/roadmap，而不是只存在于聊天记录。
- 如果决定改变已有不变量，先改 `docs/invariants/` 并说明理由，再改实现。
- 任何“为了赶时间”的临时方案都要标注过期条件与移除计划。
