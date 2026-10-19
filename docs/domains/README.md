# Capability 文档索引

每个 capability 文档描述：目的、实体、自己的生命周期、不变量、领域事件、
v1 证据、Plus 要求与待决问题。Activity 是薄根容器（见 [activity.md](activity.md)），
capability 拥有自己的业务语义与更丰富的生命周期。

| Capability | 文档 | 主要不变量 |
| --- | --- | --- |
| Activity（thin root） | [activity.md](activity.md) | AUTH-03、AUTH-06、LIFE-01/05 |
| Registration / Questionnaire / Materials | [registration.md](registration.md) | AUTH-04/05、LIFE-07 |
| Competition / Evaluation / Podium | [evaluation.md](evaluation.md) | SCOR-01…07、RES-01 |
| Voting | [voting.md](voting.md) | TICK-04、SCOR/RES 快照 |
| Ticketing / Capabilities / Access | [tickets.md](tickets.md) | TICK-01…07 |
| Results / Publishing / Correction | [results.md](results.md) | RES-01…08、LIFE-03/04 |
| Archive / Retention / Export | [archive.md](archive.md) | RES-07、DEPL-06、AUTH-05 |

`Evaluation` 是业务领域名称；当前 Plus registry 由 `competition` capability 负责
评委席位、评分事实、排名与 podium。没有独立的 `evaluation` registry capability，
后续拆分必须先更新 capability ownership 与 release contract。

阅读顺序建议：activity → registration → evaluation → results → archive；
voting/tickets 作为交叉 capability。Activity Pack 是这些 capability 的
opinionated 组合，不是新的 Activity 子类。
