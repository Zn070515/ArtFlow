# GOAL.md

# ArtFlow 学院文艺活动全生命周期平台目标基线 v5

> 本文档是 ArtFlow 的长期产品目标、领域边界和工程原则基线。
>
> 当前第一生产验证场景仍是信息工程学院十佳歌手及文艺部真实工作，但 ArtFlow 的最终目标不是“十佳算分器”，而是一套可长期运行、可复用到多类学院文艺活动的 EventOps 平台。
>
> **“负责人”与“部长”在本文中完全同义，统一写作“部长”。**

---

## 0. 一句话定义

ArtFlow 是面向学院文艺活动全生命周期的 **EventOps 活动运行平台**。

它把原本散落在：

- 微信 / QQ 群；
- Excel；
- Word；
- 问卷星；
- 网盘和临时附件；
- 纸质评分表；
- 主持手卡；
- 临时口头通知；
- 人工排名、加权、筛选、转述和抄写；

中的活动工作，收束成一套：

> **有状态、有权限、有版本、有审计、有二维码入口、有正式数据权威、有个人信息生命周期、有现场降级能力，并能在最后一个必要输入到达后快速给出唯一可信结果的工作系统。**

ArtFlow 的目标不是为了“数字化”而数字化，而是减少人工转录、信息断层、赛制理解错误、现场等待和不可追溯修改。

---

# 1. 产品边界

## 1.1 ArtFlow 最终覆盖的生命周期

ArtFlow 应能够覆盖：

```text
活动创建
↓
宣传 / 报名
↓
选手注册与资料提交
↓
审核 / 补材料
↓
节目与人员准备
↓
彩排
↓
票券发放 / 入场
↓
现场控制
↓
评委评分 / 观众投票
↓
赛制计算 / 晋级
↓
结果核定
↓
公开结果
↓
材料归档 / 复盘
```

不同活动只使用其中需要的部分。

例如：

- 十佳歌手：报名、材料、赛制、评委、观众、晋级、结果是核心；
- 毕晚：节目、材料、现场流程、通知、归档是核心，通常没有评分；
- 其它学院文艺活动：应复用相同活动、人员、材料、二维码、通知和归档基础设施。

---

## 1.2 不把某一年的赛制写死成产品

2025 院十佳和 2025 校十佳用于：

- Golden Test；
- 历史回放；
- Ruleset 能力验证；
- 事故回归；
- 发现必须支持的赛制原语。

它们不是 2026 或未来年份的默认规则。

未知规则必须保持未知：

```text
没有证据
→ 不猜
→ HOLD / NEEDS_RULE_CLARIFICATION
```

不能因为系统“需要一个答案”就自行补规则。

---

## 1.3 不把 ArtFlow 做成 PPT 播放系统

现场 PPT 继续允许使用独立电脑和现有 PowerPoint 工作流。

**当前及可预见阶段不把 PowerPoint 播放、切页、动画、字体兼容、视频播放等纳入 ArtFlow 核心控制。**

原因：

- Office / WPS / PowerPoint 兼容性复杂；
- 现场字体、比例、视频解码、动画、外接屏兼容风险高；
- ArtFlow 接管后会把舞台显示故障也变成系统故障域；
- 页面渲染的美观性难以无损替代成熟 PPT 工作流。

ArtFlow 可以提供：

- 结果板；
- 当前二维码页；
- 当前选手 / 当前环节只读页；
- 可供工作人员抄写或复制到 PPT 的正式结果；
- 导出 PNG / PDF / 文本等辅助材料。

但不把 PPT 本体控制作为完整体必需能力。

---

# 2. 用户与权限模型

ArtFlow 不采用“所有人都注册”的思路。

账号只给真正需要长期身份、长期数据或后台权限的人。

---

## 2.1 主席

- 必须拥有正式账号；
- 属于最高业务权限；
- 与部长拥有同等级业务权限；
- 可以进入全部 Staff 后台；
- 可以执行高风险业务动作。

包括但不限于：

- 活动创建与配置；
- 用户角色管理；
- Ruleset Freeze；
- 轮次控制；
- 评委面板调整；
- 结果核定；
- 解锁 / 回退；
- 正式结果发布；
- 归档；
- 高风险异常处理。

---

## 2.2 部长

“部长”与日常叙述中的“负责人”完全等同。

- 必须拥有正式账号；
- 与主席拥有同等级业务权限；
- 不再区分“部长”和“负责人”两套权限概念。

主席和部长都属于 ArtFlow 的最高业务权限层。

系统技术超级用户可以继续存在，但它属于技术维护机制，不代表学生组织职位。

---

## 2.3 部员

- 必须拥有正式账号；
- 所有部员权限完全相同；
- **不再细分材料部员、赛务部员、计分部员等子权限。**

原因：

- 文艺部规模有限；
- 活动现场人员职责经常临时变化；
- 过度权限细分会阻碍信息流通；
- 需要部长频繁授权会降低办事效率；
- 部员之间本身需要快速互相补位。

部员可以访问日常工作所需的完整 Staff 信息，包括：

- 报名与材料；
- 选手名单；
- 节目与现场信息；
- 常规评分录入；
- 投票会话信息；
- 现场异常信息；
- 结果板；
- 导出与日常工作文档。

但以下高风险 authority 动作仍只属于主席 / 部长：

- 改变用户最高权限；
- Ruleset Freeze / 高风险规则变更；
- 解锁已确认结果；
- 中途修改正式评委 Panel；
- 人工 override 正式结果；
- RELEASE 正式结果；
- 归档 / 解归档。

这里的区分是“普通业务权限 vs 最终 authority”，不是把部员再划成多个等级。

---

## 2.4 选手

- 必须注册正式账号；
- 可以自行注册；
- 一个账号可以在不同活动中形成自己的报名记录；
- 只能修改和查看自己有权访问的数据。

选手端长期目标：

- 报名；
- 个人资料；
- 曲目信息；
- 伴奏 / 图片 / 视频等材料；
- 授权与必要声明；
- 审核状态；
- 补材料要求；
- 活动通知；
- 彩排信息；
- 签到 / 候场状态；
- 自己可见的结果和历史活动。

选手不进入 Staff 后台。

---

## 2.5 评委老师

- **不注册账号；**
- 不要求设置密码；
- 不要求绑定邮箱或手机号；
- 不要求理解 ArtFlow；
- 不要求处理网络故障。

老师被视为临时现场主体。

正常电子评分路径：

```text
工作人员确认实际到场老师
↓
分配 JudgeSeat
↓
展示一次性认证 QR
↓
老师扫码
↓
获得仅本场有效的 JudgeSession
↓
进入极简评分页
```

QR 中不得包含老师姓名、手机号等个人信息，只包含短时、随机、一次性的访问 Grant。

如果老师拒绝扫码、设备不兼容、网络不可用或不愿意操作：

```text
STAFF_PROXY
```

必须是一等正式 fallback。

工作人员使用自己的已认证 Staff 账号，代表对应 JudgeSeat 录入老师给出的成绩，并记录：

- JudgeSeat；
- 原评委；
- 操作人；
- 来源 `STAFF_PROXY`；
- 原因；
- 时间；
- 修改历史。

纸质评分作为最终 DR 路径继续保留。

---

## 2.6 普通观众

- 不注册；
- 不要求登录；
- 不把姓名当作可信身份；
- 不把 IP 当作“一人”；
- 不使用复杂浏览器指纹作为核心安全机制。

观众投票权绑定到**有效票券及其现场状态**，而不是用户账户。

---

# 3. 前端 Surface 必须按角色分离

ArtFlow 是一个平台，但不应该让所有角色进入同一个复杂 Dashboard。

至少形成以下独立体验面。

---

## 3.1 Public Portal

无需登录：

- 活动首页；
- 往届风采；
- 活动公开信息；
- 报名入口；
- 公开结果；
- 对外二维码落地页。

---

## 3.2 Participant Portal

选手登录后：

- 报名；
- 材料；
- 审核；
- 通知；
- 自己的活动状态。

---

## 3.3 Staff Workspace

主席、部长、部员使用。

包含 ArtFlow 的主要运营后台：

- Activity Control；
- Registration；
- Material；
- Roster；
- Ruleset；
- Round；
- Rubric；
- Judge / Panel；
- Score；
- Audience / Vote；
- Ticket / Check-in；
- QR Center；
- Result Board；
- Notification；
- Incident；
- Archive；
- Audit；
- Export。

部员看到的信息应尽可能一致，避免人为形成信息孤岛。

---

## 3.4 Judge Terminal

这是极简临时界面，而不是后台。

只显示：

```text
活动名
当前选手 / 节目
当前评分项
总分
提交
等待下一位
```

不显示：

- 后台菜单；
- 其它评委分；
- Ruleset；
- 排名；
- 权限设置；
- 用户系统。

老师端设计标准：

> 工作人员只允许说“老师扫一下这个二维码，然后按表打分”。

如果还需要培训，界面就仍然太复杂。

---

## 3.5 Audience / Ticket Surface

不注册。

同一票券 QR 根据当前状态显示不同页面：

- 票券激活；
- 活动信息；
- 是否已检票；
- 是否拥有投票权；
- 投票是否开始；
- 投票；
- 已投票；
- 投票结束。

前端应直接把资格规则说清楚，例如：

> 完成票券领取并通过现场检票后获得本场投票资格；每张有效票券只有一次投票机会；未检票、已投票或超过投票时间均无法投票。

不要把系统内部反作弊逻辑暴露成复杂操作步骤。

---

## 3.6 Result / Display Surface

只读输出：

- 当前 READY / CONFIRMED 状态；
- 主持手卡抄写结果；
- 观众二维码页；
- 公布名单；
- 必要的大屏网页。

它不接管 PowerPoint。

---

# 4. QR / Entry Center

二维码中心是 ArtFlow 完整体的核心入口基础设施，而不是简单 PNG 生成器。

二维码应由一个统一的 Entry Point Registry 管理。

---

## 4.1 Public QR

包括：

- 报名；
- 活动主页；
- 公开结果；
- 选手登录后的指定工作入口；
- 公开通知页。

这些二维码通常可以长期存在。

---

## 4.2 Ticket QR

每张实体票拥有一个高熵唯一 QR Secret。

票券生命周期至少：

```text
CREATED
↓
ISSUED
↓
CHECKED_IN

另外：
VOID / REVOKED
```

`VOTED` 不是 Ticket 的全局终态。同一张有效票可以在不同的 `VoteSession` 中分别获得投票资格；投票状态属于：

```text
Ticket + VoteSession
```

数据库必须对 `(ticket_id, vote_session_id)` 建立唯一约束，确保一张票在每个投票场次只能产生一份 Ballot。

实际发票流程：

```text
学生领取票
↓
先扫码票面唯一 QR
↓
前端展示活动电子票 / 美术页面
↓
服务器确认票券已激活 / 发放
↓
工作人员交付实体票
```

扫码后的漂亮页面属于 UX，不承担核心身份安全。

浏览器可以记住票券以改善体验，但“设备绑定”不作为唯一 authority。

真正的投票权来自：

```text
有效 Ticket
+
已 CHECKED_IN
+
VoteSession OPEN
+
该 Ticket 尚未投票
```

---

## 4.3 Judge Authentication QR

由工作人员现场为一个 JudgeSeat 生成。

必须：

- 随机；
- 高熵；
- 短时；
- 一次性；
- 用后失效；
- 不携带老师个人信息；
- 只能兑换 JudgeSession；
- JudgeSession 权限只允许本场对应 JudgeSeat 的评分操作。

二维码只是 bootstrap grant，不是永久权限。

---

## 4.4 Operational QR

平台可继续生成：

- 选手签到；
- 材料提交；
- 工作人员指定工作页；
- 投票入口；
- 结果页；
- 临时现场入口。

需要登录的角色扫码后进入目标页，未登录则先走自己的正常登录，不因“扫到了二维码”获得额外权限。

---

# 5. Audience Ticket & Vote

## 5.1 一张真实入场票 = 每个投票场次一份投票资格

ArtFlow 不追求在无账号、无实名条件下证明“一个自然人”。

系统在每个 `VoteSession` 中证明的是：

> 这是一张真实发放、已经现场检票、在本投票场次尚未使用投票资格的票。

这样攻击者想制造 N 票，就必须实际控制 N 张有效票并通过对应检票状态，而不是仅靠浏览器脚本无限制造提交。

---

## 5.2 不相信观众姓名

如果活动方仍要求填写姓名，可以保存：

```text
display_name
identity_verified = false
```

姓名不参与：

- 去重；
- 身份校验；
- 一人一票判断；
- 作弊判定。

---

## 5.3 时间窗口是主要现场约束之一

投票可使用短窗口，例如数分钟或更短。

必须支持：

```text
CLOSED
OPEN
LOCKED
```

投票窗口开始和结束均由服务器 authority 决定。

观众页面不公开实时票数，避免提供实时刷票反馈。

---

## 5.4 反作弊保持简单

使用：

- Ticket eligibility；
- 一票一 Ballot；
- 投票时间窗；
- 幂等提交；
- 基础速率限制；
- 异常请求告警；
- 现场检票。

不默认引入：

- 手机验证码；
- 复杂浏览器指纹；
- Canvas fingerprint；
- IP 一票；
- AI 自动删票。

异常票只能进入人工 REVIEW / HOLD，不允许算法偷偷修改正式票数。

---

## 5.5 投票公网故障

ArtFlow 原生投票是 Primary。

可以准备外部表单作为 DR：

```text
ArtFlow Public Vote 不可恢复
↓
负责人切换 EXTERNAL_FALLBACK
↓
展示备用问卷入口
↓
投票结束
↓
双人核对外部结果
↓
以明确来源写回 ArtFlow AudienceScore
```

如果所有公网路径都不可用，必须根据事前冻结的 Audience Failure Policy 处理。

系统不能自己决定取消观众分或改变权重。

---

# 6. Judge / Panel

## 6.1 老师名单不是固定系统账户

活动前只能获得一个预计出席名单。

真正的比赛权威是：

```text
JudgeSeat
+
RoundPanelSnapshot
```

例如：

```text
J1 王老师 ACTIVE
J2 陈老师 ACTIVE
J3 李老师 ACTIVE
J4 赵老师 ACTIVE
J5 ABSENT
```

如果比赛规则允许 4 位评委，则本轮完整条件是 4/4，而不是继续等待不存在的 J5。

---

## 6.2 Judge 数量必须成为规则参数

Ruleset / Round 必须能声明：

- expected judge count；
- minimum judge count；
- scoring method；
- 当前 Panel 是否满足条件。

例如去最高最低对人数有数学要求，不能因为老师临时缺席就偷偷改成另一种算法。

---

## 6.3 中途离席必须 HOLD

如果同一轮已经有部分选手由 5 人评分，随后只剩 4 人：

```text
PANEL_CHANGED_MID_ROUND
→ HOLD
```

只有事前明确的规则才能继续，例如：

- 该评委本轮全部排除并对所有选手统一重算；
- 暂停等待；
- 使用工作人员代录该老师已经提供的分数；
- 其它经活动方确认的处理。

没有规则时不得自动计算。

---

## 6.4 电子评分 Primary

完整体理想路径：

```text
Judge QR
↓
JudgeSession
↓
当前 Performance
↓
老师输入评分
↓
本机 Draft
↓
提交 command_id
↓
Server ACK
↓
正式 Score Fact
```

老师不能自行选择正在评分的选手。

服务器必须验证：

- 当前 Activity；
- Round；
- Panel snapshot；
- JudgeSeat；
- Performance；
- 当前评分窗口；
- request / submission id；
- payload fingerprint。

陈旧页面必须返回 STALE_CONTEXT，而不能给错误选手写分。

---

## 6.5 STAFF_PROXY 是正式路径

任何一个老师均允许切换为人工代录。

适用：

- 拒绝扫码；
- 手机没电；
- 浏览器问题；
- 网络长期失败；
- 老师要求继续使用纸笔；
- 其它现场问题。

工作人员不应要求老师自行排障。

---

## 6.6 Paper 是最终 DR

保留空白纸质评分表。

目标是：

> 正常工作流不依赖纸，而不是现场禁止存在纸。

---

# 7. Staff 后台与现场控制

## 7.1 信息流优先

部员权限等同。

禁止为了理论最小权限把同一个文艺部拆成大量子角色，导致：

- 临时工作无法互相补位；
- 现场找不到有权限的人；
- 部长频繁授权；
- 信息不对称。

真正严格控制的是少量终局 authority，而不是普通信息读取和日常操作。

---

## 7.2 高风险动作明确分层

普通 Staff 可以完成日常运营。

主席 / 部长才能完成终局 authority，例如：

```text
Ruleset Freeze
Result Confirm / Unlock
Panel emergency change
Manual result override
Public Release
Archive / Unarchive
User role escalation
```

每次必须：

- 当前身份重新校验；
- 服务器端权限校验；
- 当前状态校验；
- 审计；
- 必要时填写原因。

---

# 8. 数据 authority

ArtFlow 必须区分：

```text
Raw Input
↓
Computed Candidate
↓
READY_TO_CONFIRM
↓
CONFIRMED
↓
RELEASED
```

这些不能合并成一个“result”。

---

## 8.1 Raw Input

包括：

- Judge score；
- Criterion score；
- Audience score；
- Vote ballot；
- Manual decision；
- Duel decision；
- Roster / group / running order snapshot。

一旦被正式结果消费，必须拥有明确不可变边界。

---

## 8.2 Candidate

Resolver 可以反复计算候选结果。

Candidate 不是正式结果。

如果输入变化，旧 Candidate 必须标记 stale 或被替换，不得继续在 UI 冒充当前可确认结果。

---

## 8.3 Confirmed

确认后才形成正式业务事实。

后续 Round roster、主持手卡、正式 Award 等只能引用正式 authority，而不是某次临时 preview。

---

## 8.4 Released

公众只能看到明确 RELEASE 的结果。

内部已经算出、甚至 CONFIRMED，不等于必须立即公开。

---

# 9. 2025 院十佳 Golden Chain

2025 历史材料确认的完整链路：

```text
15 人
↓
R1 5组×3
5评委
↓
R2 15人
↓
R1 30% + R2 60% + Audience 10%
↓
Top10
↓
CONFIRM
↓
R3
第一阶段 60% + R3 40%
↓
Top5
↓
R4
R3 30% + R4 50% + Audience 20%
↓
Top3
```

2025 院十佳必须长期保留为 Golden / Shadow Rehearsal。

最关键验收：

> **最后一格必要输入完成 → 自动进入 READY_TO_CONFIRM → 核定 → 后台结果板 → 工作人员能够立即把结果交给舞台。**

---

# 10. 2025 校十佳 Incident Gate

历史资料存在不能可靠推导的规则，例如：

- 直接晋级者没有 R2 分，但后续 fallback 公式要求 R2；
- R3 12 人如何成为 TOP10 未明确；
- 6 人中最终冠军选择方式未明确；
- 部分 tie / fallback 细则缺失。

这些必须持续得到：

```text
MISSING_SCORE_DEPENDENCY
RULE_UNRESOLVED
TIE_UNRESOLVED
NEEDS_RULE_CLARIFICATION
```

而不是猜答案。

---

# 11. 弱网与输入可靠性

用户、老师和工作人员均不能被假设处于可靠网络。

---

## 11.1 No Lost Input

老师或工作人员已经输入、尚未得到 Server ACK 的数据必须先保存在本机 pending draft。

刷新、瞬断、响应丢失不应静默丢掉已输入内容。

---

## 11.2 No Duplicate Input

所有高风险提交必须支持幂等 request / command id。

同一 command：

```text
第一次服务器成功但响应丢失
↓
客户端重试
↓
返回第一次的正式结果
```

不能制造第二份 Score / Vote / Confirm。

---

## 11.3 No Wrong-target Input

每个现场提交都必须带 expected context。

例如评分至少验证：

- Activity；
- Round；
- Judge / operator；
- Performance / Singer；
- panel / score version。

上下文已经变化就拒绝，不能自动猜“应该写给谁”。

---

## 11.4 No Incomplete Result

缺任何必需事实：

```text
NOT READY
```

不能因为主持人正在等就忽略缺失。

---

## 11.5 No Invented Rule

网络故障、老师缺席、评委中途退出、观众投票失败等没有冻结处理规则时：

```text
HOLD
```

---

# 12. 网络与部署

ArtFlow 的代码和数据模型必须 deployment-neutral。

可以运行在：

- 台式机；
- 现场笔记本；
- 校内服务器；
- 未来租用的云服务器。

是否租云服务器是部署决策，不应改变业务正确性。

---

## 12.1 完整体长期在线

如果未来长期承载：

- 选手账号；
- 报名；
- 材料；
- 电子票；
- 公共主页；
- 历史活动；

云服务器会显著提升公网长期可用性。

如果体量、访问量或免费隧道维护成本达到不合理水平，可以直接租用云服务器。

不为了坚持“零成本”牺牲产品稳定性。

---

## 12.2 云服务器不能成为现场唯一正确性前提

即使未来使用云：

- 现场评分提交仍必须支持弱网重试；
- 工作人员必须有人工 fallback；
- 正式结果 authority 不依赖某个外部 CDN；
- 公网投票失败必须有 DR；
- 网络断开不得让系统自动产生错误结果。

---

## 12.3 零预算部署仍是一等支持场景

在无云、无额外路由器情况下，允许：

- 笔记本直接运行 ArtFlow；
- Windows Mobile Hotspot 作为 Staff/Judge 本地备用接入；
- 手机 USB 网络作为可选公网 uplink；
- 公网 tunnel / IPv6 作为对外入口；
- 台式机作为备份主机。

但任何具体网络能力必须通过真实场地 rehearsal 后才能标记 Production。

---

## 12.4 单 Authority，不做 Active-Active

比赛期间只能有一个正式写入 Primary。

禁止：

- Desktop PostgreSQL 与 Laptop PostgreSQL 双主；
- 同步 PostgreSQL data directory；
- 多个浏览器离线数据库最终自动合并正式分数。

客户端只能缓存待提交 command，不能成为第二个 authority database。

---

# 13. 技术架构原则

ArtFlow 完整体即使功能很多，仍优先保持：

```text
Django Monolith
+
PostgreSQL
+
Server-rendered HTML
+
少量原生 JavaScript
+
Caddy / Nginx
```

不要因为页面和业务模块增加就自动迁移到微服务。

明确不主动引入：

- Kubernetes；
- Kafka；
- RabbitMQ；
- Redis Cluster；
- 多数据库微服务；
- 巨型 SPA；
- 为“实时”而强制 WebSocket。

只有真实规模或真实故障证明需要时才增加复杂基础设施。

---

# 14. 前端原则

## 14.1 面对老师

极简。

老师端每多一个选择都要证明必要性。

---

## 14.2 面对观众

简单、漂亮、规则直接。

美术设计可以丰富，但投票关键页面必须：

- 轻量；
- 无外部 CDN 依赖；
- 弱网可加载；
- 按钮状态明确；
- 不产生误导。

---

## 14.3 面对工作人员

效率优先。

Staff 页面允许信息密度更高：

- 快速表格；
- 键盘操作；
- 批量录入；
- 明确状态；
- 错误直接指出对象和原因。

不要为了“漂亮”增加现场操作步骤。

---

# 15. 现场异常必须是一等领域对象

至少记录：

- 时间；
- 环节；
- 问题；
- 影响对象；
- 当前 authority 状态；
- 采取的动作；
- 操作人；
- 结果；
- 是否需要赛后复盘。

典型异常：

- Judge 缺席；
- Judge 中途离开；
- Judge 拒绝电子评分；
- 设备故障；
- 网络故障；
- 缺分；
- 重复提交；
- 观众投票公网故障；
- Ruleset 未定义；
- 同分；
- 手工 override；
- 服务重启；
- 数据恢复。

---

# 16. 通知、材料与归档

## 16.1 通知

ArtFlow 应支持生成适合现有工作方式的通知材料：

- 微信 / QQ 文案；
- Word / DOCX；
- 公众号可复用内容；
- 选手个人通知。

不强迫所有通知必须在 ArtFlow 内部聊天完成。

---

## 16.2 材料

材料必须：

- 版本化；
- 标记当前版；
- 有完整性检查；
- 与活动 / 选手 / 节目绑定；
- 可归档导出。

---

## 16.3 Archive

活动归档必须区分 **永久业务事实** 与 **有期限个人信息**。

长期业务档案可以包含：

- 活动配置；
- 经确认需要长期保留的参赛 / 节目名单；
- Ruleset；
- 原始评分与正式计算事实；
- 投票最终事实；
- 正式结果；
- Award；
- 结果确认 / 解锁 / override 等核心 Audit；
- Incident；
- 必要现场工作文档；
- 经授权长期公开的媒体素材。

以下内容不得因为“活动归档”而默认永久保存：

- 手机号；
- 微信号；
- 学号等身份标识；
- 非公开联系方式；
- 工作人员内部备注；
- 原始报名表副本；
- 临时导出的联系方式文件；
- 未获得长期公开授权的原始照片 / 视频；
- Ticket secret、AccessGrant、Session 等临时凭证；
- 无长期业务必要性的 IP / 安全访问日志。

因此：

```text
Archive
├── Permanent Business Record
├── Time-limited Personal Data
├── Authorized Public Media
└── Time-limited Security / Operational Logs
```

**归档不是“数据库永远不删除任何东西”。**

正确原则是：

> **比赛事实需要长期可信；个人信息只保存到实现其处理目的所需的期限。**

Privacy cleanup 不得破坏正式评分、排名、获奖、Ruleset、确认记录等业务 authority。

---

# 17. 安全与 authority 原则

## 17.1 Default deny

知道 URL、对象 ID 或二维码内容不等于拥有权限。

所有权限最终由服务器重新验证。

---

## 17.2 Formal facts 不依赖 UI 自律

正式 authority 必须同时防：

- 普通 `.save()`；
- `QuerySet.update()`；
- `delete()`；
- `bulk_create()`；
- `bulk_update()`；
- `_base_manager`；
- Django Admin 的非正式修改路径。

---

## 17.3 Stored identity 也是 authority

保护一个数值不够。

对象原来属于哪个：

- Activity；
- Round；
- StageResult；
- VoteSession；
- RulesetVersion；

同样属于正式身份。

不能通过修改 FK 把受保护事实“搬”到未锁定对象来逃离保护。

---

## 17.4 Audit 与运行日志分开

正式 AuditLog 是业务证据。

普通 telemetry 用于：

- duration；
- request correlation；
- reason code；
- network / retry 信息。

不能把完整敏感 payload 无限制写入运行日志。

---

# 18. 数据治理与学院 / 学校接管 Readiness

ArtFlow 的长期目标允许从学生自研系统逐步演进为学院正式使用、甚至由学校信息化体系接管的业务系统。

“学校接入”不是一个单独技术功能，也不等于“拿到学校域名”。

它至少意味着：

```text
业务责任主体明确
+
数据处理规则明确
+
系统和账号可以移交
+
部署资产可归属学校 / 学院
+
网络与安全边界可说明
+
个人信息有生命周期
+
出现安全事件时有人负责
```

ArtFlow 必须从现在开始保持这种可接管性，但不得为了尚未发生的审批流程提前引入无法验证的复杂要求。

---

## 18.1 Personal Data Is Not Business Authority

ArtFlow 必须长期遵守：

> **Business facts are durable; personal data is perishable.**

比赛和活动正式事实，例如：

- Ruleset；
- Round / Panel snapshot；
- 原始评分事实；
- StageResult；
- 晋级 / 获奖；
- 正式结果；
- Confirm / Unlock / Override 记录；
- 必要的核心 Audit；

可以根据档案需要长期保存。

但：

- 手机；
- 微信；
- 学号；
- 私人邮箱；
- 内部备注；
- 非公开原始材料；
- 临时票券凭证；
- AccessGrant / Session；
- 安全访问 IP；

必须有明确业务目的和保存期限。

不能因为某个 Activity 是 Formal / Archived，就自动永久保存与活动结果无关的个人信息。

---

## 18.2 Data Inventory / Classification 先于加密

正式生产必须能够回答：

```text
我们收了什么数据？
为什么收？
从哪里来？
谁能看？
谁能改？
会不会公开？
保存多久？
到期怎么处理？
是否会交给第三方？
```

ArtFlow 至少建立以下内部数据类别：

### PUBLIC

可以对外公开：

- 活动名称 / 时间 / 地点；
- 已批准公开的介绍；
- 已 RELEASE 的结果；
- 已授权公开的照片 / 展示素材。

### INTERNAL BUSINESS

仅活动内部使用但不以个人隐私为核心：

- Ruleset；
- 运行顺序；
- 工作状态；
- 非公开评分；
- Panel；
- Incident；
- 内部结果候选。

### PERSONAL

与具体自然人相关：

- 姓名；
- 学号；
- 手机；
- 微信；
- 邮箱；
- 班级；
- 选手报名资料；
- Judge 到场记录等。

### SECURITY / SECRET

不得作为普通业务数据处理：

- password hash；
- MFA secret；
- recovery code；
- session token；
- Ticket secret；
- AccessGrant；
- encryption key；
- backup key；
- signing key。

### MEDIA

区分：

```text
Original Private Media
→ 默认私有、有期限

Approved Public Derivative
→ 经明确授权后可长期公开
```

数据分类必须进入 schema / documentation / preflight / export / archive 设计，而不是只存在审批文档里。

---

## 18.3 Data Minimization

收集个人信息时，默认原则是：

> **不收，比收完再加密更安全。**

每个 Participant / Staff / Judge / Audience 字段都必须能解释业务用途。

例如：

- 微信号是否仍有必要；
- 手机号和微信是否必须同时收；
- 学院字段在仅面向本学院时是否必要；
- 班级是否确实用于身份 / 活动运营；
- 观众姓名是否有真实业务价值。

“以前 Excel 一直有这一列”不能作为长期收集理由。

选手报名必须把：

```text
比赛必需信息
```

和：

```text
可选公开展示 / 宣传授权
```

分开。

不得用一个捆绑勾选框把“参加比赛”与“永久公开照片”等非必要处理混为一体。

---

## 18.4 Privacy Notice / Retention

正式 Participant 注册 / 报名页面必须提供清晰、可读的个人信息处理说明，至少说明：

- 谁在运行 ArtFlow；
- 收集哪些信息；
- 用来做什么；
- 哪些会公开；
- 是否交给第三方；
- 保存期限或期限确定方法；
- 如何更正 / 补充 / 申请删除非必要个人信息；
- 联系方式。

不同数据类别必须有可配置 retention policy。

不得在 GOAL 中写死“180 天 / 365 天”作为法律期限。

具体期限由：

```text
业务必要性
+
学院管理要求
+
适用法律 / 学校制度
```

共同确定。

系统至少支持：

```text
retention_policy
scheduled_cleanup_at
cleanup_status
cleanup_audit
```

Privacy cleanup 后：

- 正式评分 / 结果不变；
- 不再需要的联系方式删除或不可逆去标识化；
- 临时 secret 失效 / 销毁；
- 非必要原始材料删除；
- 留下“执行过清理”的审计事实，但不能在审计里复制被清除的明文 PII。

---

## 18.5 部员仍然完全等权

学院接入和个人信息最小权限原则 **不得重新把部员拆成材料组、舞台组、算分组等子权限**。

所有部员仍保持相同日常权限和信息可见范围。

个人信息保护通过以下方式实现：

- 最小化收集；
- 默认遮罩；
- 按需查看完整值；
- Sensitive Read 审计；
- 高风险批量导出单独控制；
- Archive / Retention；
- Audit 脱敏。

而不是通过制造信息孤岛实现。

部长 / 主席仍只在少数终局 authority 和高风险治理动作上高于部员。

---

## 18.6 Sensitive Data View

Staff 日常界面不必永远展示所有完整联系方式。

推荐：

```text
张三
学号：3020****0036
手机：138****1234
微信：***
```

当工作人员确有运营需要时：

```text
[查看完整联系方式]
```

服务器重新验证当前 Staff 身份，并记录：

```text
SENSITIVE_DATA_READ
actor
activity
object
field_group
timestamp
reason / context（必要时）
```

所有部员对这一能力保持相同权限。

目标不是制造访问障碍，而是能够回答：

> **谁实际查看过完整个人信息？**

---

## 18.7 Bulk Personal Data Export 是高风险动作

普通结果、节目单、候场表等业务导出与“全体选手联系方式导出”不是同一风险等级。

涉及批量个人信息的导出必须：

- 明确用途；
- 当前身份重新验证；
- 记录导出人、活动、字段、记录数量和时间；
- 文件按需即时生成；
- 不在服务器永久保留导出副本；
- 文件名 / 页眉可包含用途与导出时间标识；
- 必要时要求部长 / 主席执行或批准。

不得把：

```text
contacts.xlsx
```

作为 Archive 的永久默认组成部分。

---

## 18.8 Encryption Is Risk-based

ArtFlow 应支持针对高风险字段的应用层加密，但 **不得为了“看起来安全”给所有字符串做可逆加密**。

优先评估：

- phone；
- wechat；
- private email；
- student_id；
- 其它泄露后会明显增加个人风险、且业务确需长期保存的标识。

推荐使用经过广泛验证的 AEAD 方案，并保持：

```text
ciphertext
key_version
```

设计。

如果某字段同时需要：

```text
精确查询 / 去重 / UNIQUE
```

不得使用固定 IV 或自制“确定性 AES”。

可以采用：

```text
encrypted_value
+
HMAC / blind lookup index
```

实现查询与唯一约束。

是否对 student_id / name 等具体字段实施应用层加密，必须以 threat model 和实际审批要求决定。

磁盘 / volume / backup 加密不能被“字段已加密”取代；字段加密也不能取代访问控制。

---

## 18.9 Secret / Key Management

正式环境中的：

- DATA KEY；
- lookup / HMAC key；
- backup key；
- signing key；
- MFA secret wrapping key；

不得：

- 写入 Git；
- 写入数据库同一行；
- bake 进 Docker image；
- 只存在某一个学生个人电脑且无人能恢复。

必须支持：

```text
key id / version
rotation
compromise replacement
recovery
handover
```

正式由学院接管后，恢复能力不能只掌握在单个学生开发者手中。

如果学校 / 云平台提供 Secret Manager / KMS，应允许替换本地 secret file 实现，而不重写业务模型。

---

## 18.10 Backup Protection

备份属于正式数据副本，不能因为叫“backup”就绕过个人信息保护。

正式 backup pipeline 应支持：

```text
PostgreSQL / media
↓
consistent backup
↓
integrity manifest
↓
independent backup encryption
↓
off-host copy
↓
restore verification
```

BACKUP KEY 与应用 DATA KEY 不应默认为同一把密钥。

删除生产数据库中的 PII 后，还要明确旧备份如何按既定保留政策到期销毁；不能承诺“实时从所有历史 backup 擦除”这种无法实现的语义。

---

## 18.11 High-privilege Authentication

主席 / 部长 / System Admin 属于高权限长期账户。

正式学院生产模式不应把“所有管理员共享一个全局第二密钥”作为最终 MFA 方案。

目标：

```text
个人账号
+
个人密码 / SSO
+
个人 MFA
```

可以优先支持 TOTP；以后可扩展 Passkey / WebAuthn。

要求：

- 每人独立 MFA secret；
- recovery codes 只存 hash；
- MFA secret 加密；
- MFA reset / disable 是高风险操作；
- 敏感 authority 可要求 recent re-authentication；
- 共享 `ADMIN_LOGIN_KEY` 只能作为迁移期兼容机制，不是最终学校生产设计。

普通部员和选手是否强制 MFA，根据实际风险与学校统一认证能力决定，不因高权限 MFA 自动增加所有人的操作负担。

---

## 18.12 Audit Must Be PII-safe

Audit 用于证明“发生了什么”，不是复制一份个人信息历史镜像。

禁止把完整敏感值直接写入：

```text
old_value
new_value
note
exception
telemetry
```

至少统一经过 Audit Safe Serializer / redaction。

默认禁止记录：

- plaintext password；
- phone / wechat 的完整旧值、新值；
- student_id plaintext（非必要）；
- token；
- session；
- Ticket secret；
- AccessGrant；
- MFA secret；
- encryption / backup key；
- signed private URL。

正确审计示例：

```text
phone_changed = true
```

而不是：

```text
138... → 139...
```

Security access log 与永久业务 Audit 必须拥有不同 retention policy。

---

## 18.13 Uploaded Files Are Untrusted

文件上传成功不代表文件可以直接进入正式材料池或公开页面。

至少采用分层验证：

- allowlist extension；
- size limit；
- 不信任浏览器 Content-Type；
- magic / signature check；
- 随机内部对象名；
- 私有存储，不使用个人信息拼接路径；
- 图片实际 decode；
- 公开图片重新编码并去 EXIF；
- PDF / Office / 音视频按类型进行实际格式验证；
- ZIP 防止异常压缩比 / 路径穿越，默认不自动解压不可信压缩包。

当正式部署环境允许时，可增加 malware scanning / ClamAV。

ClamAV 是 defense-in-depth，不应成为所有开发环境和现场评分的硬依赖。

---

## 18.14 Public Media 与 Original Media 分离

公开展示不得默认直接暴露用户原始上传文件。

推荐：

```text
Original Upload
PRIVATE
↓
validate / decode
↓
strip metadata
↓
resize / re-encode
↓
Approved Public Derivative
```

这样可以避免：

- EXIF GPS；
- 原始文件名泄露个人信息；
- 异常 metadata；
- 巨大原图直接公开；
- 撤销公开授权时无法区分业务原件与公开副本。

---

## 18.15 Third-party Dependency Registry

正式环境必须知道哪些第三方可能接触：

- 个人信息；
- Ticket / Judge request；
- backup；
- media；
- 日志。

例如：

- 云服务器；
- 对象存储；
- 公网 tunnel；
- 邮件 / 短信服务；
- Malware scanner；
- CDN；
- 外部表单 DR。

必须记录：

```text
provider
purpose
data categories
network path
retention
是否可替换
是否为正式生产依赖
```

免费 tunnel 可以继续服务实验 / 零预算场景，但 **学院正式接管后不得因为“免费”而默认让第三方 HTTP tunnel 成为个人信息正式入口**。

---

## 18.16 Formal School Mode 默认境内部署

学生自研 / 临时活动阶段允许根据实际条件选择部署位置。

但如果 ArtFlow 进入学院 / 学校正式生产并持续处理学生个人信息：

> **默认优先校内基础设施或中国大陆合规云资源。**

香港或其它境外部署不得作为默认正式方案。

如果确有必要向境外提供个人信息，必须先按适用规定确认：

- 告知；
- 单独同意；
- 个人信息保护影响评估；
- 数据出境适用程序；
- 学校 / 学院批准。

不要为了省一台大陆服务器主动制造数据跨境治理问题。

---

## 18.17 Domain / Internet Publication

学校信息技术体系允许 ArtFlow 保持 deployment-neutral，但正式公网发布时必须尊重机构流程。

如果由学院 / 学校正式主办：

- 优先使用学校认可的域名 / 子域名；
- 域名、证书、服务器和联系人不应只绑定某个学生个人身份；
- ICP / 公安联网备案等事项由实际主办主体和接入方式按适用流程办理；
- ArtFlow 代码不得假设一定拥有 `zjut.edu.cn` 域名。

获得学校域名不是 ArtFlow 的业务 authority，也不等于自动通过安全审查。

---

## 18.18 SSO Is Pluggable, Not Mandatory Today

当前本地账号体系继续是一等支持路径。

如果学院 / NIC 明确要求统一身份认证，应通过可替换 Identity Provider 接入：

```text
Identity Provider
├── LocalAuth
└── School SSO / CAS / OIDC
```

业务模型继续只依赖 ArtFlow `User` / stable subject mapping。

不得把：

- 学号；
- CAS ticket；
- 外部 subject；
- SSO 特有字段；

散落到各业务表作为权限判断。

在校方未提出要求前，不把 CAS / SSO 接入作为 M2 blocker，也不把“未来可能接 SSO”当审批筹码。

---

## 18.19 Prepare for MLPS / Institutional Inventory, Do Not Self-declare Level

如果 ArtFlow 被学院 / 学校正式认定为信息系统，应能够向学校提供：

- 系统边界；
- 业务负责人；
- 技术负责人；
- 数据类别；
- 网络拓扑；
- 部署资产；
- 外部依赖；
- 用户与权限；
- 备份 / 恢复；
- 日志 / Audit；
- 漏洞与补丁管理；
- Incident response；
- 当前版本 / release manifest。

这些材料使 NIC 能够进行：

```text
系统摸底
→ 定级判断
→ 备案 / 整改（如适用）
```

ArtFlow 自己不得在 GOAL 中写死：

```text
“本系统一定是等保二级”
```

或者：

```text
“本系统无需等保”
```

最终范围和等级由正式责任主体 / 学校信息技术部门依据实际部署、影响和现行规范确定。

---

## 18.20 Ownership / Handover

学院正式接管前必须解决 bus factor。

不能存在：

```text
域名只有学生个人能续费
云服务器只有学生个人账号
GitHub 只有学生个人有管理员
Backup key 只有学生个人知道
MFA recovery 只有学生个人持有
数据库恢复必须找原作者
```

正式模式至少指定：

```text
Business Owner
System Owner
Technical Maintainer
Data Responsible Contact
Security / Incident Contact
Backup / Key Recovery Custodian
```

并有：

- 源码与依赖锁定；
- migration；
- deployment manifest；
- runbook；
- backup / restore；
- key recovery；
- account recovery；
- release procedure；
- 最低限度维护文档。

ArtFlow 的最终目标不是“徐昕永远维护它”。

而是：

> **即使原开发者毕业，学院仍然有能力安全地继续运行、停用、迁移或恢复系统。**

---

## 18.21 Institutional Readiness 不等于 M2 停工

学院接入 readiness 与 M2 业务能力可以并行推进。

在 M2 期间优先完成低迁移成本、高收益的基础：

```text
Data Inventory / Classification
Privacy Notice / Retention Model
Audit Redaction
Secret / Key Contract
High-privilege MFA migration plan
Sensitive Export contract
Third-party dependency inventory
```

以下能力可在 threat model / 校方要求明确后逐步实现：

```text
字段级加密覆盖范围
ClamAV
学校 SSO
正式对象存储
等保整改项
学校域名 / 正式服务器
```

不得为了“未来可能审批”无限延迟 Ticket / Judge / QR 等已经明确的 M2 业务开发。

---

---

# 19. Capability Truth

功能只能处于明确状态，例如：

```text
PRODUCTION
EXPERIMENTAL
UNSUPPORTED
```

UI、模板、Ruleset Freeze、Preflight 必须尊重状态。

不能出现：

> 页面显示“支持”，但后台其实只能通过 shell 造数据。

未知能力必须诚实显示未知。

---

# 20. Production Rehearsal

任何正式新能力在首次使用前必须通过真实行为彩排，而不仅是单元测试。

重点场景：

- 最后一格评分 → READY；
- 多 Staff 并发录入；
- 网络断开；
- 请求成功但响应丢失；
- 重复提交；
- Judge 缺席；
- Judge 临时退出；
- STAFF_PROXY；
- Audience timeout；
- Vote public ingress failure；
- Web restart；
- PostgreSQL restart；
- backup / restore；
- stale browser；
- Ruleset ambiguity。

验收目标不是“所有东西都不坏”，而是：

> **坏掉时系统可以降级、可以 HOLD、可以人工接管，但不能悄悄产生错误正式结果。**

---

# 21. 当前开发顺序

## M1 — 当前十佳生产核心

先完成：

```text
Core Authority Closure
↓
Roster / Advancement
↓
Onsite Checkpoint
↓
2025 院十佳 Shadow
↓
2025 校十佳 Incident Gate
↓
Production Rehearsal / DR
```

M1 的重点仍然是让现有 Staff 主流程可靠运行。

---

## M2 — QR / Ticket / Direct Judge

M1 代码基线稳定后进入：

```text
QR Entry Registry
Ticket lifecycle
Check-in
Audience ticket entitlement
JudgeSeat / PanelSnapshot
One-time Judge QR
JudgeSession
Direct electronic scoring
Local draft + idempotent ACK
STAFF_PROXY
```

同时并行推进 **Institutional Readiness Foundation**：

```text
Data Inventory / Classification
Privacy Notice / Retention
Audit Redaction
Secret / Key Contract
High-privilege MFA migration plan
Sensitive Export contract
Third-party dependency inventory
```

这批学校接入基础不得把 M2 重新拖回“大而全安全平台”。

字段级加密覆盖范围、ClamAV、学校 SSO、正式域名 / 服务器、等保整改等，在 threat model 或校方要求明确后逐步落地。

---

## M3 — 平台完整化

继续扩展：

- 通知中心；
- 选手现场状态；
- 候场 / Stage Runner；
- 更完整 Archive；
- 更多学院活动模板；
- 长期公网部署；
- 必要时云部署；
- 更成熟的 Event Preflight / Health / DR。

---

# 22. 永久禁止的错误方向

除非真实需求发生变化，不要：

1. 把部员再拆成大量权限子角色；
2. 强迫评委老师注册账号；
3. 强迫观众注册账号；
4. 把观众填写姓名当真实身份；
5. 把 IP 当一人一票；
6. 把“实时计算”直接等价于“实时公开”；
7. 为未知赛制自动猜规则；
8. 为了无纸化删除 STAFF_PROXY 和纸质 DR；
9. 把 PPT 播放控制纳入当前核心；
10. 为了技术炫耀引入微服务 / Kafka / Kubernetes；
11. 把免费公网 tunnel 当正式结果产生的唯一依赖；
12. 搞 PostgreSQL Active-Active；
13. 让客户端缓存成为正式第二数据库；
14. 因为老师或观众不配合而把系统正确性交给他们；
15. 为了“过审批”把所有字段无差别可逆加密；
16. 为个人信息保护重新把部员拆成大量子角色；
17. 把共享 `ADMIN_LOGIN_KEY` 作为正式学校生产环境最终 MFA；
18. 在学院正式接管模式下未经评估默认把个人信息部署到境外；
19. 把免费第三方公网 tunnel 作为学校正式个人信息系统不可替换的唯一入口；
20. 因为“归档”而永久保存所有联系方式、Ticket secret、Session 和安全日志。

---

# 23. 完全体最终标准

ArtFlow 完全体不以“有多少页面”判断完成，而以真实活动能否满足以下标准判断：

### 主席 / 部长

可以从一个后台掌握活动完整状态，并对少数终局 authority 负责。

### 部员

拥有相同的日常工作权限和充分信息，可以随时互相补位。

### 选手

从报名到比赛结束只维护自己的一份真实资料，不再在多个表格和聊天里重复提交。

### 评委

愿意扫码时，只需要扫一次并打分；不愿意扫码时，比赛也不会因此停止。

### 观众

拿到真实票、完成检票、在允许时间内即可投票，不需要注册，不需要理解系统。

### 后台

最后一个必要输入到达后立即得到候选结果；缺失或规则不明时明确 HOLD；确认后形成唯一正式结果。

### 网络

网络可以差、请求可以重试、公网可以故障，但不能因此出现丢分、重复分、错选手分或错误正式结果。

### 系统

仍然保持可部署、可测试、可备份、可恢复、可审计，并且能够从本地机器平滑迁移到云服务器，而不用重写业务核心。
