# 事故库索引

每条事故记录：现象、触发条件、根因、v1 修复、对应不变量、门禁、Plus 要求。
事故不是 changelog；它是“同样的错误不能换一种写法再犯”的依据。

| 事故 | 不变量 | 门禁/Golden |
| --- | --- | --- |
| [stale-static-assets](stale-static-assets.md) | DEPL-02/04 | GATE-RELEASE-01 / GATE-DEPLOY-01 |
| [duplicate-score-fact](duplicate-score-fact.md) | SCOR-01/06 | `duplicate-score-fact.json` |
| [revoked-result-media](revoked-result-media.md) | AUTH-07、RES-05 | GATE-MEDIA-01 / result golden |
| [admin-reauth-405](admin-reauth-405.md) | 拒绝可恢复性 | accounts 行为测试 |
| [archive-public-title-identity](archive-public-title-identity.md) | RES-02/06/07 | `archive-identity.json` |
| [unknown-roster-deferred](unknown-roster-deferred.md) | LIFE-07 | `unknown-roster.json` |
| [base-manager-bypass](base-manager-bypass.md) | AUTH-01/02 | GATE-AUTH-01 |

新增事故的规则：写下“当时以为是什么 / 实际是什么 / 为什么测试没抓住 / 哪条
规则现在能抓住它”。没有门禁或 golden 的事故，要在 roadmap 里留跟进项。
