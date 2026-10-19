# 领域模型索引

每个领域文档描述：目的、实体、生命周期、不变量、领域事件、v1 参考与待决问题。

| 领域 | 文档 | 主要不变量 |
| --- | --- | --- |
| 活动 | [activity.md](activity.md) | AUTH-03、AUTH-06、LIFE-01/05 |
| 报名 / 问卷 / 材料 | [registration.md](registration.md) | AUTH-04/05、LIFE-07 |
| 评分 / 评委 / 名次 | [evaluation.md](evaluation.md) | SCOR-01…07、RES-01 |
| 投票 | [voting.md](voting.md) | TICK-04、SCOR/RES 快照 |
| 票据 / 凭证 / 访问 | [tickets.md](tickets.md) | TICK-01…07 |
| 结果 / 公示 / 纠错 | [results.md](results.md) | RES-01…08、LIFE-03/04 |
| 归档 / 保留 / 导出 | [archive.md](archive.md) | RES-07、DEPL-06、AUTH-05 |

阅读顺序建议：activity → registration → evaluation → results → archive，
voting/tickets 作为交叉领域。
