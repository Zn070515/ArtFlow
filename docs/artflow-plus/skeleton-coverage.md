# v1 → v2 功能覆盖审计

状态：执行基线（2026-11-06）。本文回答一个问题：**在删除 1.x Django 源码之前，
Plus 是否已经覆盖了 v1 的真实功能？** 结论用于外部审核与删除门槛，不是"v1 功能
必须逐行移植"的清单；v2 以 capability 组合实现同一业务事实。

## 覆盖结论

| v1 功能 | v1 证据 | v2 capability / 表面 | 状态 |
| --- | --- | --- | --- |
| 活动创建/生命周期/锁定/归档 | `core/`、`common/business_rules` | Engine、`archive` | 已覆盖 |
| 报名 DRAFT→OPEN→REVIEW→FINAL | `singer_contest/` | `registration` | 已覆盖 |
| 问卷版本与文件槽位 | `questionnaire/` | `questionnaire` + Studio | 已覆盖 |
| 材料上传/审核/补交 | `files/` | `materials`、supplement capability | 已覆盖 |
| 名单 FINAL/UNKNOWN | `singer_contest` roster | `registration` | 已覆盖 |
| 赛制/轮次/席位 | `ruleset/`、`singer_contest` | `competition` | 已覆盖 |
| 评委评分/快速录分/代录/纠错 | `singer_contest`、`judge_*` | `competition` | 已覆盖 |
| 观众投票 | `voting/` | `voting` | 已覆盖 |
| 票据/入场/签到 | `tickets/`、`entry_access/` | `ticketing` | 已覆盖 |
| 结果候选/核定/发布/撤销 | `public_portal/services.py` | `publishing` / Results | 已覆盖 |
| 归档包 | `archive/` | `archive` | 已覆盖 |
| Live 状态/断线恢复 | `realtime/`、`public_portal/live_state.py` | `@artflow-plus/realtime` + HTTP 恢复 | 已覆盖 |
| 测试/正式隔离 | `core/lifecycle.py` | Engine + mode 分区 | 已覆盖 |
| 分组合唱赛段 | `singer_contest.GroupStage` | `grouping` | 已覆盖 |
| 投票结果公示 | v1 投票结果导出 | `publishing`（vote source） | 已覆盖 |
| 观众投票入口 | v1 投票页/二维码 | `/vote/<sessionId>` + Ops 二维码 | 已覆盖 |
| 实时通道 | v1 Channels | 单一 WebSocket 核心 | 已覆盖 |
| 运营分析 | v1 staff 统计页 | `analytics` + Ops | 已覆盖 |
| 任务/准备清单 | v1 无对应 | `tasks` | v2 新增 |

## 仍缺口的 v1 功能

| 缺口 | v1 证据 | 影响 | 计划 |
| --- | --- | --- | --- |
| 公开公告 / 往届风采 / 活动文章 | `public_portal/` 的 `PublicPost` 类型与页面 | Portal 只有活动结果与报名入口 | 新 capability 或扩展 `publishing` 的非结果内容 |
| 舞台类节目单公开页 / 节目顺序 | `farewell_show/` 的 `Program` 与 order | 观众看不到节目安排 | 新 capability 或 `publishing` 的非比赛 stage |
| XLSX 导出 | `exports/`、`staff_panel` 导出 | 运营无法导出报名/评分/投票表格 | 独立导出模块，不塞进 capability |
| Word / 微信推文生成 | `exports/` 的 `ArticleTemplate`、`GeneratedDocument` | 无法一键生成推文 | 独立内容生成模块 |
| bracket / 对阵 / 复合分 | `ruleset/` 的淘汰赛表达 | v2 competition 只表达 round/panel/score | 新 capability |
| 现场大屏 | v1 结果板/主持手卡视图 | Live 只做失效提示与操作台 | 展示层项目 |
| 事故记录 | `incidents/` | v2 用 audit/任务承接，无独立事故对象 | 可评估为"有意放弃" |
| 活动克隆 | `staff_panel` clone | v2 只能新建 definition | 可评估为"有意放弃" |
| SSO provider | 无（v1 本地账号） | 当前使用本地会话 | 待 RFC |
| 多实例实时广播 | v1 Channels + Redis | 单实例实时；HTTP 恢复仍可靠 | 待规模需要 |

## 有意放弃

- **v1 数据导入 / 运营接管**：legacy bundle、`--mode adoption`、媒体桥与 golden
  v1 adapter 已删除。v1 的数据随源码一起归档，不再迁入 v2。
- **参与者账号认领**：`/claim` 与 `participant_claim` 表只服务导入的
  `legacy-user:*` 报名；导入移除后一并删除。v2 参与者使用本地账号。
- **1.x 部署切换**：不再有 cutover 流程；v2 是唯一部署目标。

## 1.x 源码归档状态

1.x 源码已于 2026-11-06 从 `main` 删除，完整源码保存在 tag `v1.0.2`，功能记录
在 [`docs/archive/v1/`](../archive/v1/README.md)。删除同步清掉了 Django app、
模板、静态资源、Django 测试、v1 CI、v1 部署与 Python 框架依赖；`pyproject.toml`
现在只保留 pytest/ruff/pyyaml 门禁工具。

后续功能缺口仍按本文表格推进，不再受 1.x 源码删除门槛约束。

## 约束

1. 任何 capability 不得读写其他 capability 的表；只能通过命令/查询/事件/稳定 ID/binding。
2. 产品面（Studio/Ops/Live/Portal）只组合公开 contract，不自行解释权威事实。
3. 新增 capability 只需注册 manifest + compiler + handlers，不修改 Engine。
4. 结构门禁 `GATE-PLUS-BOUNDARY-01` 与 `GATE-REALTIME-CORE-01` 继续强制边界。
