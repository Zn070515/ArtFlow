# GOAL.md

# ArtFlow 院十佳决赛生产基线 v6

> 本文件是 ArtFlow 的长期产品目标、当前业务边界与工程约束基线，用于约束后续 Agent、开发者和自动化修改。
>
> **本文件不是当前代码实现清单，也不是阶段性 TODO。**
>
> ArtFlow 当前唯一需要主动扩展、彩排和正式验收的生产场景是：**学院十佳歌手决赛全流程**。
>
> 代码库中仍可能保留通用活动、毕晚、历史实验、旧入口、旧字段和兼容逻辑；除非有新的明确需求，**不得因为这些代码仍存在，就把它们重新解释成当前产品范围或开发优先级。**

---

# 0. 真相优先级

ArtFlow 长期最容易出现的问题不是“少一个功能”，而是旧文档、历史材料、旧代码和新决策混在一起，导致 Agent 把已经废弃的方向重新实现。

因此必须区分两类真相。

## 0.1 产品决策真相

当产品方向发生冲突时，优先级是：

```text
用户最新明确决策
>
本 GOAL.md
>
仍有效的正式设计 / runbook
>
旧 GOAL、旧 issue、历史方案、旧聊天结论
>
2025 历史材料
```

历史材料只能说明“当年发生过什么”，不能自动变成未来需求。

## 0.2 当前能力真相

判断“现在代码到底已经支持什么”时，优先级是：

```text
main 当前代码
+
migration
+
tests / E2E
+
CI gate
>
README / GOAL / 文档中的能力描述
```

如果 GOAL 写着“应该支持”，但 main 里没有可用代码、测试和真实入口，则该能力仍未完成。

如果代码中还残留旧实现，但本 GOAL 已明确废弃，则它属于：

```text
LEGACY / COMPATIBILITY
```

不得继续作为新功能设计基线。

## 0.3 GOAL 不维护短寿命状态

以下内容不应写死在 GOAL：

- 当前 HEAD SHA；
- 某一次 CI 的耗时；
- 某个备案步骤“正在等待”；
- 某个临时公网 IP；
- 某项 feature 是否刚 merge；
- 某个 issue 当前是否关闭；
- 某台服务器当前容器 IP；
- 某一次彩排当天人员安排。

这些状态应由代码、测试、CHANGELOG、issue、runbook 或部署文档表达。

---

# 1. 一句话定义

ArtFlow 是面向**学院十佳歌手决赛**的 EventOps 运行系统。

它把原本散落在：

- 微信 / QQ；
- Excel；
- Word；
- 问卷星；
- 网盘和临时附件；
- 纸质评分表；
- 人工算分；
- 主持手卡；
- 现场口头传递；

中的关键流程，收束成：

> **报名与材料有结构、赛制有版本、现场入口稳定、评分和投票有 authority、结果可核定、异常可 HOLD、修改有审计、失败可人工接管的一套决赛运行系统。**

ArtFlow 的目标不是“功能越多越好”，而是：

> **正式决赛当天减少转录、等待、错分、漏分、错对象提交、临时猜规则和信息断层，同时保证系统故障时比赛仍然能够继续。**

---

# 2. 当前产品边界

## 2.1 当前正式范围只有院十佳决赛

当前 ArtFlow 主动支持：

```text
院十佳决赛
```

不把以下内容纳入当前正式流程：

```text
海选
初赛
复赛
其它学院赛事
毕晚
草坪音乐节
通用赛事 SaaS
商业化产品平台
```

代码库中存在相关历史模块，不等于这些模块是当前 blocker。

## 2.2 不再做“多活动平台化优先”

底层设计可以保持合理复用性，但所有新增需求必须先回答：

> **它是否改善院十佳决赛的真实报名、材料、彩排、检票、评分、投票、结果或恢复流程？**

如果答案是否定的，则默认不是当前优先事项。

不要为了“以后也许支持别的活动”提前增加：

- 泛化工作流引擎；
- 多租户；
- 多组织；
- 商业计费；
- 模板市场；
- 复杂的跨活动权限；
- 为未来活动准备的大量抽象层。

## 2.3 条件性分组合唱，而不是默认分组赛制

ArtFlow **不把“分组”作为院十佳决赛的默认赛制结构**。

如果当届最终确认的正式赛制不存在分组合唱环节，则不得为了历史代码、旧材料或未来泛化需求要求工作人员配置 Group。

如果正式赛制确认存在分组合唱环节，则 ArtFlow 只实现该环节真实需要的：

```text
外部分组结果录入
+
组成员管理
+
组级共享材料
+
必要的版本追踪
```

不得因此把整个比赛改造成 group-first 系统。

## 2.4 不接管 PPT / 音视频播放

ArtFlow 不负责：

- PowerPoint / WPS 播放；
- 切页；
- 动画；
- 字体；
- 舞台视频播放；
- 伴奏播放；
- 灯光；
- 调音台。

这些素材提前制作并由现场电脑按原工作流执行。

ArtFlow 可以输出：

- 当前选手；
- 当前轮次；
- 结果板；
- 固定二维码页；
- 主持手卡所需结果；
- PNG / PDF / DOCX / Excel 等辅助材料。

但不把舞台播放系统纳入故障域。

---

# 3. 2025 与当前活动的关系

## 3.1 2025 是历史模板，不是当前赛制

必须永久保留：

```text
院十佳 2025（历史模板）
```

不得覆盖、重写或直接改成下一届。

它的用途是：

- 历史回放；
- Golden / Shadow Test；
- Ruleset 回归；
- 真实数据彩排；
- 验证过去发生过的事故；
- 提供下一届活动创建时的初始参考。

## 3.2 正确的新届创建流程

```text
创建新一届院十佳决赛
↓
TEST
↓
从 2025 历史模板 clone
↓
等待当届赛制确认
↓
按确认规则调整轮次 / 权重 / 晋级人数 / Questionnaire / 材料需求
↓
完整彩排
↓
Admin Freeze
↓
TEST → FORMAL
↓
正式比赛
```

## 3.3 不把历史公式写成未来默认值

2025 已知存在真实的多阶段晋级和观众投票事实，但历史资料中部分权重、字段和描述可能存在冲突。

因此：

> **不得因为 2025 材料中出现某个公式、分组或权重，就自动写进下一届。**

未确认内容必须保持：

```text
UNKNOWN
/
NEEDS_RULE_CLARIFICATION
/
HOLD
```

而不是让系统猜一个“最合理”的答案。

---

# 4. 用户、账号与权限

ArtFlow 的软件权限以系统角色为准，不以学生组织职位名直接授权。

组织里的“主席 / 部长 / 部员”可以映射到系统角色，但**组织职位不是代码里的 authority source**。

## 4.1 Participant / 选手

选手使用：

```text
账号 + 密码
```

可以：

- 注册 / 登录；
- 报名；
- 查看和维护自己的资料；
- 上传自己的材料；
- 查看审核状态；
- 按 Staff 指示补交缺失材料；
- 查看自己有权看到的活动信息；
- 如果属于分组合唱 Group，则进入本组共享材料工作区。

不能进入 Staff 后台。

## 4.2 Staff / 工作人员

工作人员使用：

```text
账号 + 密码 + STAFF_ACCESS_KEY
```

`STAFF_ACCESS_KEY` 用于工作人员注册 / 登录边界，不与管理员密钥复用。

Staff 负责日常运营：

- 报名与审核；
- 材料；
- 轮次准备；
- 票券；
- 检票；
- 评委现场控制；
- 投票开关；
- 常规评分录入；
- STAFF_PROXY；
- 分组结果录入与核对；
- Incident；
- 日常导出；
- 现场状态查看。

不要继续把 Staff 拆成“材料 Staff / 计分 Staff / 检票 Staff / 舞台 Staff”等权限角色。

现场岗位可以不同，但账号能力应允许快速互相补位。

## 4.3 Admin / 管理员

管理员使用：

```text
账号 + 密码 + ADMIN_ACCESS_KEY
```

`ADMIN_ACCESS_KEY` 与 `STAFF_ACCESS_KEY` 独立。

Admin 负责高风险 authority，例如：

- 用户角色和状态；
- Ruleset Freeze；
- 高风险配置；
- 正式结果确认 / 解锁；
- 正式结果 Release；
- 高风险 override；
- 归档相关终局动作；
- 其它需要 recent verification 的操作。

不要把 Admin 理解为“技术 superuser UI”。

业务 Admin 与 Django / 系统维护超级用户是两个概念。

## 4.4 Judge / 评委

评委：

- 不注册账号；
- 不设置密码；
- 不绑定手机号；
- 不绑定邮箱；
- **默认不绑定现实姓名；**
- 不需要理解后台；
- 不需要自己排障。

评委的正式 authority 是：

```text
当前 Panel 中的匿名评分通道 / JudgeSeat
```

不是现实姓名。

---

# 5. 报名、Questionnaire 与材料

## 5.1 Questionnaire 是当前报名与材料结构的中心

选手端应统一到：

```text
JSON Questionnaire Schema
↓
前端渲染
↓
验证
↓
保存 / 回填
```

不要继续把每一届的新字段硬编码成新的 Django 表单页面。

## 5.2 赛制驱动 Questionnaire

Questionnaire 应由当前活动的已确认赛制 / 轮次需求组合。

最小模块可以包括：

- 基本信息；
- 曲目信息；
- 伴奏；
- 歌词；
- 图片；
- 视频；
- 帮唱 / 合作信息；
- 授权与声明；
- 某一轮次特有材料；
- 条件性 Group Chorus 材料。

原则：

> **赛制决定需要哪些材料模块；Questionnaire 负责把这些模块组合成选手看到的表单。**

## 5.3 Submission Subject 至少支持 PARTICIPANT / GROUP

Questionnaire / Material 系统应允许提交主体至少区分：

```text
PARTICIPANT
GROUP
```

个人环节：

```text
subject = PARTICIPANT
```

分组合唱环节：

```text
subject = GROUP
```

不得为分组合唱另建一套与 Questionnaire 完全平行的材料系统。

## 5.4 基本信息不要继续分裂成另一套体验

选手基本资料也应进入统一 Questionnaire / Participant experience。

不要让选手分别面对：

```text
注册资料页
+
报名表
+
材料表
+
轮次材料页
+
临时补交页
```

但后端 authority 可以继续合理解耦。

## 5.5 报名截止后的修改规则

自由报名时段结束后：

> **选手不能继续任意修改已提交正式资料。**

只能：

- 查看；
- 按 Staff 指定的缺交 / 退回项补交；
- 修改被明确重新开放的字段。

不要用“整个报名重新开放”解决一两个材料缺失。

## 5.6 材料系统要求

材料至少需要：

- 明确所属 Activity / Subject / Questionnaire field；
- 类型和大小策略；
- 当前版本；
- 完整性状态；
- Staff review；
- 补交语义；
- 归档边界；
- 私有原件与公开衍生物区分。

---

# 6. 条件性分组合唱

## 6.1 分组产生不由 ArtFlow 负责

正式分组优先通过主办方认可的外部公开工具完成，例如微信群中的随机分组小程序。

ArtFlow 不承担随机分组算法或公平性证明。

原因：

> 分组涉及比赛公平性。由 ArtFlow 自己生成随机结果，容易被质疑是否存在后台控制、算法偏差或结果可修改。

正式流程：

```text
外部公开分组
↓
形成第一组、第二组……
↓
Staff 将结果录入 ArtFlow
↓
核对组次和成员
↓
Confirm / Freeze
↓
ArtFlow 从已确认分组开始负责后续管理
```

## 6.2 Group 只属于需要分组的具体环节

存在一个分组合唱环节，不意味着整个比赛都切换为 group-first 数据模型。

个人演唱轮次继续按：

```text
Participant
RoundEntry
Performance
```

管理。

只有明确需要组级协作的环节建立：

```text
GroupStage
↓
Group
↓
GroupMembership
```

## 6.3 Group 的最小正式信息

每个分组合唱 Group 至少包含：

```text
group_order
members
```

例如：

```text
第一组
成员：A、B、C
```

或：

```text
第二组
成员：D、E、F
```

`group_order` 是工作人员和选手实际使用的：

```text
第一组
第二组
第三组
……
```

不要默认设计：

- 队长；
- 组名；
- 口号；
- 颜色；
- 组别类型；
- 队伍简介；
- 额外组织结构。

除非当届正式赛制明确要求，否则这些字段不要成为正式必填能力。

## 6.4 组次和成员由系统确定

小组合唱材料页面中的：

```text
组次
成员
```

都来自已确认的 Group / GroupMembership。

它们是：

```text
read-only / system-owned
```

不要求组员自己重新填写，也不允许普通组员修改。

## 6.5 Group Material 的 owner 是 Group

分组合唱所需材料属于：

```text
Group
```

不是某一个 uploader。

不得为每个组员复制一套相同的组材料记录。

正确语义：

```text
第一组
↓
唯一一份当前合唱材料状态
```

而不是：

```text
A 的第一组材料
B 的第一组材料
C 的第一组材料
```

## 6.6 组内共享同一份材料权限

同一 Group 的所有当前有效成员拥有相同的：

```text
查看
提交
修改
补交
```

权限。

例如：

```text
A 上传伴奏 v1
↓
B 可以看到并替换
↓
C 看到的是 B 修改后的当前版本
↓
A 再次进入时也看到最新正式内容
```

每次操作仍记录真实 actor，用于追踪。

共享的是同一份正式 Group Material，而不是个人副本。

## 6.7 小组合唱材料的最小必填内容

必须包含：

```text
1. 组次
2. 小组成员
3. 合唱伴奏音频或视频
```

其中：

- 组次由系统自动展示；
- 成员由 GroupMembership 自动展示；
- 伴奏至少存在一个正式可用的音频或视频。

伴奏验证规则：

```text
audio exists
OR
video exists
```

即可通过。

允许同时上传音频和视频，但完整性检查不要求两者都存在。

## 6.8 其它组材料默认非必填

除非当届赛制明确提出，不主动要求：

- 歌词；
- 曲目介绍；
- 舞台说明；
- 背景图片；
- 服装信息；
- 队长；
- 组名；
- 分工说明；
- 宣传文案；
- 联系方式；
- 其它“可能以后有用”的字段。

如果为了 schema 扩展性保留这些字段，也必须默认：

```text
optional
```

设计原则：

> **先收比赛运行真正需要的材料，不因为 Questionnaire 可扩展就主动扩张收集内容。**

## 6.9 Group Material 最小 READY 条件

一个分组合唱 Group 的最小 READY 条件：

```text
Group 已 CONFIRMED
+
至少 1 名有效成员
+
组次存在
+
成员名单存在
+
至少一个当前有效的伴奏音频或视频
```

缺任意一项：

```text
NOT READY
```

Staff 页面应直接指出缺什么，例如：

```text
第二组
⚠ 缺少伴奏文件
```

而不是只显示：

```text
材料不完整
```

## 6.10 截止与补交

自由提交期间：

```text
任一有效组员
→ 都可以维护本组开放字段
```

截止后：

```text
Group Material
→ 锁定
```

如果 Staff 指定某些字段缺失、退回或要求重交，则所有有效组员都可以补交这些明确重新开放的字段，但不能因此修改其它已冻结材料。

权限逻辑：

```text
Group membership
×
Field submission state
×
Activity lifecycle
```

而不是：

```text
只要是组员就永远可以修改全部材料
```

## 6.11 Membership 与材料解耦

组员被移出某 Group 后：

```text
立即失去该 Group 的后续编辑权限
```

但其过去提交或修改形成的组材料不会被删除，因为正式 owner 是 Group，而不是 uploader。

新加入该 Group 的成员：

```text
立即获得当前组材料的正常共享权限
```

## 6.12 分组修正必须可审计

分组结果录入错误允许修正。

一旦分组已经 Confirm / Freeze，成员调整必须通过显式解锁或受控修正路径，并记录：

- 操作人；
- 时间；
- 原成员关系；
- 新成员关系；
- 修改原因。

不得静默改变已经被材料、评分或结果消费的正式分组事实。

---

# 7. 前端版本展示原则

## 7.1 任何主视图默认只显示最新版本

任何面向：

```text
Participant
Staff
Judge
Public
```

的主页面、大卡片、列表、详情主要区域，默认只展示当前有效的**最新版本**。

例如材料页面应显示：

```text
伴奏
chorus-final.mp3

最后更新：10 月 3 日 18:42
```

而不是：

```text
v1 chorus.mp3
v2 chorus-new.mp3
v3 chorus-final.mp3
```

也不要默认突出：

```text
当前版本：v7
历史版本：6 个
```

除非该信息对当前操作确有必要。

原则：

> **版本系统是后台一致性和追踪机制，不应该成为普通用户的主要认知负担。**

## 7.2 修改后新版本立即替代主视图

例如：

```text
A 上传 accompaniment-v1.mp3
↓
B 替换 accompaniment-final.mp3
```

之后组内所有成员正常访问材料页时，只看到：

```text
accompaniment-final.mp3
```

旧文件不得继续和当前文件并排显示，造成：

> “到底比赛用哪一个？”

这种歧义。

## 7.3 需要 Trace 的对象提供独立历史路由

对于确实需要审计 / 追踪的对象，可以提供：

```text
/history/
```

或等价独立入口。

例如：

```text
/groups/<group_id>/materials/<field>/history/
```

History 页面可以显示：

```text
当前版本
v4
B
10 月 3 日 18:42
accompaniment-final.mp3

历史
v3
A
10 月 3 日 17:16
accompaniment-2.mp3

v2
C
10 月 2 日 21:03
accompaniment.mp3
```

但 History 不应成为正常材料提交流程的一部分。

## 7.4 不是所有版本化对象都必须提供 History UI

需要区分：

```text
数据层可追踪
```

和：

```text
产品上需要给人查看历史
```

不是一回事。

只有以下情况值得提供 History Route：

- Staff 需要确认谁改过正式材料；
- 多人共享编辑后需要追踪；
- 正式结果 / Ruleset / 分组成员变化需要审计；
- Incident 调查需要回溯；
- 当前业务确实存在查看旧版本的需要。

否则只保留 backend trace / Audit 即可。

## 7.5 Group Membership 正常页也只显示当前态

正常 Group 页面只显示当前成员：

```text
第一组

A
B
D
```

不会默认把：

```text
C 曾经属于第一组
```

混进当前成员表。

需要追踪时走：

```text
Group Membership History
```

查看：

```text
C 移出
D 加入
操作人
原因
时间
```

---

# 8. Ruleset、轮次与结果 authority

## 8.1 规则不能藏在 UI 里

晋级、加权、观众分、Award、人工决定等正式逻辑必须由 Ruleset / resolver 明确表达。

不能把关键公式只写在：

- 前端 JavaScript；
- Excel；
- Staff 口头约定；
- 某个 view；
- 某段主持稿。

## 8.2 轮次使用中性语义

当前正式流程只处理决赛。

新 UI 和新 schema 优先使用：

```text
轮次
环节
stage
round
```

不要重新把“初赛 / 复赛”作为正式产品流程的核心词汇。

历史 enum / migration 可以兼容存在，但不应驱动新 UX。

## 8.3 Group 只在明确的组级环节存在

如果当届存在分组合唱：

- Group 只服务该环节；
- 不把所有 RoundEntry 改成 GroupEntry；
- 不把整个 Result resolver 重新 group-first；
- 不因一轮合唱恢复通用分组赛制。

## 8.4 数据 authority 链

必须长期保持：

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

这些状态不能合并成一个笼统的 `result`。

### Raw Input

包括：

- Judge score；
- Criterion score；
- Vote ballot；
- Audience-derived score；
- Manual decision；
- 当前 roster / running order snapshot；
- 若赛制需要，已确认 Group / GroupMembership snapshot。

### Candidate

Resolver 可以重复计算候选结果。

Candidate 不是正式结果。

输入变化后旧 Candidate 必须 stale / 失效，不得继续冒充当前结果。

### CONFIRMED

只有确认后的 StageResult / Award / advancement 才能作为下游正式来源。

### RELEASED

公众只看到显式发布的结果。

内部已经算出或确认，不等于自动公开。

## 8.5 最后一个输入到达后的目标

系统最重要的现场目标：

```text
最后一个必要输入完成
↓
立即得到唯一候选结果
↓
READY_TO_CONFIRM
↓
Admin 核定
↓
工作人员立即获得可交付给舞台的正式结果
```

ArtFlow 必须减少“再开 Excel 算一次”的需要，但仍允许人工复核。

## 8.6 未知规则绝不补全

任何缺失规则必须进入：

```text
NOT READY
RULE_UNRESOLVED
TIE_UNRESOLVED
NEEDS_RULE_CLARIFICATION
HOLD
```

不能因为主持人在等，就自动猜一个处理方法。

---

# 9. Audience / Vote

## 9.1 观众只有一种正式投票资格

**不再区分普通观众、VIP 观众、最佳人气观众、成绩观众等安全身份。**

如果现实票券有普通 / VIP / 嘉宾等类别，那是票券或座位 metadata，不影响观众投票 authority。

正式观众资格统一来自：

```text
有效 Ticket
+
CHECKED_IN
```

## 9.2 最佳人气不单独建安全体系

“最佳人气奖”如果使用观众票：

> **直接消费与成绩组成相同的一套 VoteSession / Ballot facts。**

不要再创建：

- Popularity 专用账号；
- Popularity 专用 QR；
- Popularity 专用权限；
- Popularity 专用反作弊系统。

它与“观众票是否计入成绩”之间的差别属于 Ruleset / Award 计算，不属于入口安全。

## 9.3 原始票数不是默认意义上的成绩分

如果观众票要进入正式成绩，必须由 Ruleset 明确完成比例 / 支持率 / 标准分转换。

例如：

```text
有效支持 ballot
÷
本 VoteSession 有效 ballot 总数
×
标准分值
```

或当届明确确认的其它公式。

不要把 raw vote count 直接塞进 Judge score。

## 9.4 正式院十佳投票不用现场口令

正式 Singer Contest VoteSession：

```text
Ticket-backed
```

不要再要求普通观众输入现场 passcode。

旧 passcode 只允许作为历史 / legacy compatibility，不是新正式流程。

## 9.5 一个 Activity 同时最多一个公开 VoteSession

现场 Live Router 必须始终能明确判断：

```text
0 个 open vote → 等待
1 个 open vote → 展示该投票
```

不得依靠“最新创建 VoteSession”猜当前投票。

## 9.6 一张票每个 VoteSession 一份 Ballot

正确唯一性是：

```text
Ticket + VoteSession
```

同一张有效票可以在不同投票轮次分别投一次。

`VOTED` 不是 Ticket 的全局生命周期状态。

## 9.7 不把以下机制作为核心反作弊

默认不引入：

- IP 一票；
- 手机验证码；
- 强制实名；
- Canvas fingerprint；
- 复杂设备指纹；
- 动态 TOTP 投票二维码；
- AI 自动删票。

正式正确性依赖：

- Ticket；
- Check-in；
- ballot uniqueness；
- VoteSession 状态；
- server-side authority；
- 基础 rate limit；
- audit / incident。

## 9.8 公网投票故障必须可降级

ArtFlow 原生投票是 Primary。

可以准备外部表单 / 问卷作为 DR。

如果切换 DR：

- 必须由工作人员明确执行；
- 记录 Incident；
- 明确数据来源；
- 结束后人工核对；
- 以受控方式写回正式 Audience facts。

系统不得自行取消观众分或改变权重。

---

# 10. Ticket / Check-in

## 10.1 Ticket 生命周期

至少保持：

```text
CREATED
↓
ISSUED
↓
CHECKED_IN

另外：
VOID
REVOKED
```

## 10.2 Ticket QR 必须可恢复 / 可重打

正式票券不再采用“页面一刷新 QR 永久丢失”的设计。

当前目标协议：

```text
public_code
+
credential_version
+
signature
```

服务器使用独立：

```text
QR_SIGNING_KEY
```

验证。

同一票券可以重新渲染 / 重新打印。

怀疑泄漏时：

```text
credential_version + 1
```

使旧新式凭证失效。

旧 raw-secret 路径只作为迁移兼容，不得成为重置后的后门。

## 10.3 没有扫码枪

院十佳现场默认硬件条件：

> **只有工作人员自己的手机。**

检票主流程必须是：

```text
Staff 手机
↓
浏览器打开检票页
↓
调用手机摄像头
↓
扫描 Ticket QR
↓
立即显示 成功 / 已检票 / 无效
```

手工输入票号 / credential 只作为 fallback。

不要为专用扫码枪设计工作流。

## 10.4 Ticket browser session 以现场可用性为优先

观众自己的浏览器可以记住已识别票券。

短至几十分钟的 session 会在晚会中制造无意义阻塞，因此正式现场 session 应覆盖活动主要时段。

但最终 authority 仍要重新检查：

```text
Ticket 当前状态 == CHECKED_IN
```

被 REVOKED 后，即使浏览器仍有 cookie 也不能继续获得资格。

---

# 11. QR / Entry

## 11.1 QR 的核心原则

> **二维码代表稳定入口，不代表瞬时业务状态。**

服务器决定这个入口“现在应该显示什么”。

不要让工作人员在比赛中管理一堆随轮次变化的二维码。

## 11.2 当前只管理四张固定活动二维码

院十佳决赛正式 QR Center 只需要管理：

```text
1. 活动入口
2. 报名入口
3. 现场观众入口
4. 评委入口
```

典型稳定路由：

```text
/e/<public_code>/
/e/<public_code>/apply/
/e/<public_code>/live/
/e/<public_code>/judge/
```

## 11.3 不单独管理这些 QR

不要再为以下对象创建需要人工管理的独立固定二维码：

- 每个 VoteSession；
- 最佳人气；
- 每个 JudgeSeat；
- 每个结果页面；
- Staff 每个后台功能。

其中：

- Result 属于活动 / Live 生命周期；
- VoteSession 由 Live Router 决定；
- JudgeSeat 由共享 Judge Entry 自动分配；
- Ticket QR 属于票券库存，不属于 QR Center 固定入口；
- Staff 正常登录后台即可。

## 11.4 Live QR 整晚不换

观众现场入口必须保持同一个 URL / QR。

```text
未开放投票
→ 等待

Staff 开放 VoteSession
→ 同一页面出现投票

投票结束
→ 同一页面回到等待

下一轮 VoteSession 开放
→ 同一页面出现下一轮

结果发布
→ 同一页面可以进入正式结果
```

前端可以使用轻量 polling 获取状态变化。

不为了这一点强制引入 WebSocket。

## 11.5 打印前必须使用正式 HTTPS host

稳定 QR 的价值依赖长期可达的正式域名。

不要把：

- localhost；
- SSH tunnel；
- 临时 IP；
- 临时开发域名；

生成进最终海报、节目单和现场 PPT。

---

# 12. Judge / Panel

## 12.1 Judge 默认匿名

当前推荐流程不是“提前录入每位老师姓名再发二维码”。

正确默认语义：

```text
本轮需要 N 个评委通道
↓
准备 Panel
↓
内部形成 J1...Jn
↓
所有老师扫同一张 Judge QR
↓
按到达顺序自动领取空闲通道
```

现实姓名：

- 默认不需要；
- 不参与评分 authority；
- 可以作为 `display_label` / 备注后补；
- 不进入 QR payload。

## 12.2 一个 Activity 同时只能有一个现场 Panel

共享 Judge QR 必须有唯一目标。

因此同一 Activity 不允许同时存在多个 ACTIVE / HOLD 的现场评委组，让服务器靠 round id 或创建时间猜当前轮次。

## 12.3 一个 Seat 只允许一个 ACTIVE JudgeSession

例如 5 个评委通道：

```text
第 1 台设备 → J1
第 2 台设备 → J2
第 3 台设备 → J3
第 4 台设备 → J4
第 5 台设备 → J5
第 6 台设备 → 拒绝并提示联系工作人员
```

不能出现两个手机同时代表同一正式 JudgeSeat。

## 12.4 Judge QR 不使用短时倒计时作为主安全机制

旧的：

```text
每 Seat 单独 QR
+
15 分钟 grant
+
一次兑换
```

不再是推荐主流程。

现场优先：

```text
稳定共享 Judge QR
+
server-side seat claim
+
长时 JudgeSession
+
Staff 显式释放 / 重置
```

短时 grant 可以作为 legacy / fallback 保留，但不得重新成为默认 UX。

## 12.5 JudgeSession 应覆盖整场主要时段

老师正常情况下：

```text
扫一次
↓
整晚评分
```

刷新、锁屏、短暂切后台不应该要求重新扫码。

Session TTL 只是兜底，不是工作人员需要管理的倒计时。

## 12.6 HOLD 不踢已连接评委

HOLD 的语义：

```text
保留 JudgeSession
+
停止正式评分提交
+
前端显示现场暂停
```

RESUME 后原设备继续使用。

只有：

- Staff 释放；
- Panel 被替换；
- 设备丢失；
- 正式结束；
- 安全重置；

才需要 revoke session。

## 12.7 老师不能选“给谁打分”

Judge Terminal 必须由服务器决定：

- Activity；
- Round；
- Panel；
- JudgeSeat；
- 当前 Performance；
- Rubric；
- context version。

老师只能：

```text
看当前选手
填分
提交
等下一位
```

不能从下拉框选择选手 / 轮次。

## 12.8 STAFF_PROXY 与 Paper 永远保留

如果老师：

- 不愿扫码；
- 手机没电；
- 浏览器故障；
- 网络故障；
- 坚持纸笔；

工作人员不应要求老师现场排障。

正式 fallback：

```text
Direct Judge
↓
STAFF_PROXY
↓
PAPER_DR
```

系统目标是“正常流程少用纸”，不是“禁止纸”。

---

# 13. Staff 现场工作原则

## 13.1 信息流优先于细权限

文艺部规模小、岗位会临时变化。

日常 Staff 能力不要因岗位切割形成信息孤岛。

真正严格控制的是少量终局 Admin authority。

## 13.2 手机是一等现场终端

现场必须假设工作人员大量使用自己的手机，而不是一直坐在后台电脑前。

关键页面需要适配：

- 手机检票；
- 当前投票开关；
- Judge 连接状态；
- Incident；
- 当前结果状态；
- 必要现场操作。

## 13.3 不为了“漂亮”增加操作层级

Staff 页面可以信息密度高。

优先：

- 少点击；
- 清楚状态；
- 批量操作；
- 错误指出对象；
- fallback 明显。

不要把后台做成营销页面。

---

# 14. TEST / FORMAL / Freeze

## 14.1 TEST 是正式流程的一部分

TEST 不是随便造数据的开发模式。

它用于：

- 私测；
- 线下会议彩排；
- 评委端模拟；
- 观众投票模拟；
- Ticket / Check-in 模拟；
- Group Chorus 材料协作模拟；
- 全流程 rehearsal。

## 14.2 TEST 公共面默认不可见

普通匿名用户默认不能访问 TEST 活动公共入口。

Staff / Admin 可以预览。

Judge TEST 彩排需要由 Staff 显式开启。

关闭后不再公开。

## 14.3 Freeze 是正式比赛边界

正式前：

- Ruleset；
- 轮次配置；
- Questionnaire 结构；
- 评分表；
- 关键 roster source；
- 若存在分组合唱，则正式 Group / GroupMembership；

必须完成确认 / Freeze。

## 14.4 Admin 可以应急解锁，但必须留下审计

现场出现真实问题时，系统不能因为“绝对不可解锁”阻塞比赛。

允许：

```text
Admin Unlock
↓
修改
↓
重新 Freeze / Confirm
```

但必须记录：

- 谁；
- 什么时间；
- 为什么；
- 改了什么；
- 后续如何重新锁定。

---

# 15. 可靠性原则

所有现场关键链路都必须同时满足以下五条。

## 15.1 No Lost Input

用户已经输入但尚未获得 Server ACK 的关键数据不能静默丢失。

Direct Judge 应保留本地 draft / pending state。

## 15.2 No Duplicate Input

正式写入使用幂等 command / request id。

```text
服务器已成功
+
响应丢失
+
客户端重试
```

不能生成第二份 Score / Ballot / Confirm。

## 15.3 No Wrong-target Input

现场提交必须绑定 expected context。

上下文已变化：

```text
STALE_CONTEXT
```

不能“猜它应该属于下一位 / 上一位选手”。

## 15.4 No Incomplete Result

缺任何必需输入：

```text
NOT READY
```

不能为了快而生成看起来完整的错误结果。

## 15.5 No Invented Rule

遇到：

- 缺评委；
- 票数异常；
- 平票；
- 公网投票失败；
- 上游结果改变；
- 未定义 fallback；
- 分组规则未确认；

如果赛制没有冻结处理规则：

```text
HOLD
```

---

# 16. Incident 与人工接管

现场异常是一等业务对象。

至少记录：

- 时间；
- Activity / Round；
- 影响对象；
- 当前 authority 状态；
- 问题；
- 采取动作；
- 操作人；
- 结果；
- 是否需要赛后复盘。

典型 Incident：

- Judge 设备故障；
- Judge 中途退出；
- STAFF_PROXY；
- Paper DR；
- Ticket 异常；
- 投票公网故障；
- 缺分；
- 重复提交；
- stale context；
- Ruleset ambiguity；
- Group 录入或成员修正；
- 服务重启；
- 数据恢复；
- 人工 override。

目标：

> **允许系统坏，允许网络坏，允许人不配合；不允许错误结果悄悄变成正式结果。**

---

# 17. 部署基线

## 17.1 云服务器已经是主路线，不再是“未来可能”

ArtFlow 当前正式生产方向已经从本机 NAT / 临时 tunnel 转向：

```text
中国大陆云服务器
+
Docker Compose
+
PostgreSQL
+
正式 HTTPS 域名
```

当前已有阿里云 ECS 作为生产基础设施。

因此 Agent 不应再把以下方案当正式主路线：

- 宿舍台式机穿透学校 NAT；
- 免费 tunnel 长期生产；
- 现场自建 WLAN 作为用户必须接入路径；
- 所有观众安装 Tailscale；
- 临时 URL 印在宣传材料上。

这些最多是开发 / DR / 探针手段。

## 17.2 备案与公网发布是部署问题，不是业务模型

ICP备案、域名、证书、公安联网备案等状态会变化。

GOAL 不固定某个“当前备案进度”。

代码必须做到：

- deployment-neutral；
- 正式公网使用稳定 HTTPS host；
- 不把学校域名写死进业务模型；
- 不因备案等待改变 Ruleset / Ticket / Judge authority。

## 17.3 反向代理

正式公网运行应允许：

```text
Caddy / Nginx
↓
Django / Gunicorn
↓
PostgreSQL
```

是否额外启用 CDN / WAF / OSS 取决于真实需求，不是当前功能 blocker。

## 17.4 单一正式数据库 authority

比赛期间只有一个 Primary PostgreSQL authority。

禁止：

- Active-Active；
- 两台 PostgreSQL 双主；
- 同步数据库目录；
- 多浏览器离线数据库最终合并正式结果。

客户端可以缓存待提交 command，但不能成为第二数据库。

## 17.5 云不可用时仍要有业务 fallback

云服务器是 Primary，不代表比赛必须依赖它才能继续。

仍应保留：

- STAFF_PROXY；
- Paper score sheet；
- 外部投票 DR；
- 主持手卡；
- 手工复核；
- backup / restore；
- 必要现场人工流程。

---

# 18. 安全原则：足够强，但不能阻塞现场

ArtFlow 不以“最大化安全机制数量”为目标。

现场可用性是安全设计的一部分。

## 18.1 不能牺牲的 invariants

以下必须保持：

- 正式 authority 在服务器；
- TEST / FORMAL 隔离；
- 一张 Ticket 每 VoteSession 最多一份 Ballot；
- 一个 JudgeSeat 最多一个 ACTIVE JudgeSession；
- Judge 不能选择当前评分对象；
- HOLD / LOCK 能阻止正式写入；
- Result 必须经过正式 Confirm / Release；
- QR 不包含不必要 PII；
- Ticket credential 可显式 revoke / rotate；
- Admin 高风险操作重新校验；
- Audit 不记录 secret 明文；
- Group Membership 的正式修正可审计。

## 18.2 不默认引入的安全复杂度

除非真实威胁或正式要求证明必要，不默认加入：

- 30 秒动态 QR；
- TOTP 式 Judge QR；
- Judge 15 分钟反复扫码；
- 观众手机号验证码；
- 人脸；
- 校园身份实名投票；
- 复杂浏览器指纹；
- IP 一票；
- 复杂设备 MDM；
- 大型 IAM；
- 为所有 Staff 强制个人 MFA；
- 为了“安全”让老师承担故障排查。

## 18.3 Access Key 当前就是明确边界

当前 Staff / Admin 使用独立部署 access key。

不要擅自：

- 合并两把 key；
- 把 key 写进数据库；
- 写进 Git；
- 写进页面；
- 将其升级成复杂 key management 平台作为当前 blocker。

## 18.4 数据最小化

优先不收不必要数据。

观众不需要姓名。

Judge 不需要现实姓名。

选手字段必须能解释用途。

Group Chorus 除了：

```text
组次
成员
伴奏音频或视频
```

之外，其它内容默认不必强制收集。

## 18.5 Audit 必须 PII-safe

不得把以下明文塞进 Audit：

- password；
- access key；
- ticket credential；
- session token；
- Judge credential；
- signing key；
- 不必要的完整联系方式。

---

# 19. 数据与归档

## 19.1 Business facts durable，个人信息不是

长期可信的正式业务事实包括：

- Ruleset；
- Round；
- Panel snapshot；
- Score facts；
- Vote facts；
- StageResult；
- advancement；
- Award；
- Confirm / Unlock / Override；
- 必要核心 Audit；
- 已确认 Group / GroupMembership history（若当届存在）。

个人信息不因为活动归档就默认永久保存。

## 19.2 Archive 不等于全部保留

不得因为“归档”默认永久保存：

- 手机号；
- 微信；
- 学号；
- 临时 Staff note；
- 不必要报名副本；
- Ticket credential；
- Judge session；
- AccessGrant；
- 无长期业务价值的 IP / 安全日志；
- 未授权长期公开的原始照片 / 视频。

## 19.3 原始私有媒体与公开衍生物分离

推荐：

```text
Original Upload
PRIVATE
↓
validate / decode
↓
必要时 strip metadata / re-encode
↓
Approved Public Derivative
```

不要默认直接公开用户原始上传文件。

---

# 20. 技术架构

当前继续坚持：

```text
Django Monolith
+
PostgreSQL
+
Server-rendered HTML
+
少量 TypeScript / JavaScript
+
Docker Compose
+
Caddy / Nginx
```

不要因为业务复杂就自动引入：

- 微服务；
- Kubernetes；
- Kafka；
- RabbitMQ；
- Redis Cluster；
- 多数据库；
- 巨型 SPA；
- 为“实时”而强制 WebSocket。

只有真实瓶颈证明需要时才增加复杂度。

---

# 21. CI / Gate 原则

CI 目标是：

> **不削弱 gate，消除重复 gate。**

## 21.1 Gate 必须正交

期望职责分离：

```text
Linux SQLite quality gate
→ 全量业务正确性 + coverage + lint/type/static

Windows Python 3.12
→ 完整 Windows / 解释器兼容

Windows Python 3.13
→ 完整 Windows / 解释器兼容

PostgreSQL integration
→ PostgreSQL-specific 锁、并发、事务、upsert 等语义

Compose acceptance
→ production-like 容器、migrate、doctor、health、Playwright、static、backup/restore

Security
→ dependency / CodeQL / secret scan

Workflow lint
→ Actions contract
```

## 21.2 不重新引入重复 full suite

不要再让同一套完整 Django / pytest suite 同时在：

- Linux；
- PostgreSQL integration；
- Compose container；
- Windows 3.12；
- Windows 3.13；

全部无差别重复。

PostgreSQL gate 只验证 PostgreSQL-specific contract。

Compose gate验证运行时 / E2E / 恢复，不再为了“更保险”重复整套 unit suite。

## 21.3 并行化不是削弱测试

允许并鼓励使用 pytest-xdist 等方式并行执行完整测试。

不得为了缩短 CI：

- 降 coverage threshold；
- 删除 Windows 3.12 / 3.13 支持；
- 删除 PostgreSQL concurrency test；
- 删除真实 Playwright acceptance；
- 删除 backup / restore gate；
- 把失败测试改成 continue-on-error。

## 21.4 Migration tests 必须隔离

历史 migration rollback / forward 测试会改变 schema state。

在 xdist 下必须显式隔离，不能因并行化导致其它测试看到错误 schema。

---

# 22. Production Rehearsal

任何第一次正式使用的新现场能力都必须经过真人 rehearsal。

单元测试通过不等于现场可用。

至少覆盖：

```text
报名 / Questionnaire
↓
材料审核 / 补交
↓
若存在分组合唱：外部分组结果录入
↓
Group Material 共享提交 / 修改 / 补交
↓
Ticket 签发
↓
手机检票
↓
Judge 共享 QR / J1...Jn
↓
当前表演切换
↓
Direct Judge score
↓
HOLD / RESUME
↓
STAFF_PROXY
↓
Audience Live QR
↓
VoteSession A
↓
等待
↓
VoteSession B
↓
Result Closure
↓
Confirm
↓
Release
↓
Backup / Restore
```

还必须故意演练：

- 刷新；
- 断网；
- 请求成功但响应丢失；
- 重复提交；
- 第六个 Judge 设备；
- Judge 设备退出；
- Ticket 重复扫描；
- 已检票 / 未检票观众；
- VoteSession 关闭；
- stale context；
- 服务重启；
- PostgreSQL 重启；
- 规则未确认；
- Group 成员修正；
- Group Material 被不同成员连续修改；
- 人工 fallback。

验收标准：

> **现场人员不需要理解内部模型，也不会因为安全机制、二维码切换、版本展示或状态不清而卡住比赛。**

---

# 23. 当前优先级规则

GOAL 不维护 M1 / M2 / M3 版本路线图。

Agent 接到没有明确优先级的新任务时，默认按以下价值顺序判断：

```text
1. 院十佳决赛正式正确性
2. 现场稳定 / fallback
3. 报名 Questionnaire / 材料语义清晰
4. Judge / Ticket / Vote / Result 的真实现场闭环
5. 条件性 Group Chorus 的真实需求
6. 人类友好的 Staff / Participant / Judge UX
7. 部署、备份、恢复、CI 效率
8. 合规所必需的最小改造
9. 产品展示 / 多活动平台化 / 商业化
```

第 9 项默认不得反向阻塞前 1～8 项。

---

# 24. 明确延后 / 非目标

除非用户重新明确改变方向，当前不要主动投入：

1. 初赛 / 复赛全流程；
2. 未经当届赛制确认的通用分组赛制；
3. ArtFlow 内置随机分组算法作为正式主流程；
4. 毕晚 / 草坪音乐节新功能扩张；
5. 多租户 Event SaaS；
6. 产品官网商业化包装；
7. 收费 / 支付；
8. 通用活动模板市场；
9. PPT / 舞台媒体控制；
10. 微服务；
11. WebSocket-first 架构；
12. 专用扫码枪工作流；
13. 观众多层身份体系；
14. 最佳人气单独安全系统；
15. 每 VoteSession 一张人工管理 QR；
16. 每 JudgeSeat 一张默认 QR；
17. Judge 必须实名绑定；
18. Judge 15 分钟重复扫码；
19. Audience 现场口令作为正式院十佳主流程；
20. 动态旋转 QR；
21. 免费 tunnel 作为正式主入口；
22. 本机 NAT 穿透作为正式部署主路线；
23. PostgreSQL Active-Active；
24. 客户端第二 authority database；
25. 为了“学校以后可能要求”提前建设完整 SSO / IAM / MLPS 平台；
26. 为了安全而让评委、观众承担复杂步骤；
27. 为了版本追踪而在主页面堆叠所有历史版本；
28. 为分组合唱默认强制收集大量非必要字段。

---

# 25. 历史兼容代码处理原则

代码库中可能长期存在：

- farewell_show；
- GENERAL activity；
- group / PerformanceGroup；
- legacy passcode；
- per-seat Judge grant；
- old Ticket secret；
- preliminary / semi_final enum；
- 历史 migration；
- 旧数据导入字段。

这些存在的原因可能是：

```text
migration compatibility
historical replay
data preservation
regression test
safe migration path
```

Agent 不得看到这些模型就推断：

> “这是未来正式产品必须继续扩展的能力。”

如果要删除，也必须先检查真实历史数据和 migration compatibility。

正确态度：

```text
能安全退役 → 退役
暂时不能删 → 标成 legacy
当前决赛仍需要 → 才继续演进
```

特别注意：

> 如果当届正式赛制确认存在分组合唱，则只恢复 / 新建该环节真实需要的 Group 能力，不能因此把所有历史分组逻辑重新纳入主产品。

---

# 26. 完全体验收标准

ArtFlow 当前阶段不以页面数、模型数或 commit 数判断完成。

## 26.1 选手

选手能够：

- 注册；
- 报名；
- 只维护一套真实资料；
- 按赛制看到正确材料模块；
- 清楚知道缺什么；
- 报名截止后只补 Staff 指定项；
- 不需要反复在多个问卷和群里重复提交；
- 如果属于分组合唱 Group，可以看到并维护本组当前共享材料；
- 主页面只看到当前最新材料，不被历史版本干扰。

## 26.2 Group Chorus（若当届存在）

工作人员能够：

```text
外部公平工具完成分组
↓
把第一组、第二组……录入 ArtFlow
↓
确认组员
↓
选手共享本组材料
↓
至少提交音频或视频伴奏
↓
Staff 清楚看到是否 READY
```

组内任何成员的修改立即成为该组新的当前版本。

历史需要追踪时走独立 History / Audit 路由。

## 26.3 Staff

工作人员能够：

- 在一个 Workspace 看到当前活动状态；
- 用手机完成检票；
- 快速打开 / 关闭投票；
- 看到 Judge 连接情况；
- 切换当前表演；
- 处理 STAFF_PROXY；
- 遇到问题明确 HOLD；
- 快速得到 READY / CONFIRMED 结果；
- 记录 Incident；
- 不因为权限细分而找不到能操作的人。

## 26.4 Judge

老师的理想体验只有：

```text
扫同一张二维码一次
↓
自动进入一个匿名评分通道
↓
看当前选手
↓
填分
↓
提交
↓
等待下一位
```

HOLD / RESUME 不要求重新扫码。

老师不愿意扫码也不能阻塞比赛。

## 26.5 Audience

观众：

```text
拿到有效票
↓
完成检票
↓
扫码同一个 Live QR
↓
投票开放时直接投
```

不注册、不输现场口令、不理解 VoteSession、不区分最佳人气权限。

## 26.6 Result

最后一个必要事实到达后：

- 系统能立即得到候选；
- 缺输入明确 NOT READY；
- 规则不明明确 HOLD；
- stale 结果不能被确认；
- Admin 确认后产生唯一正式结果；
- Release 与 Confirm 分离；
- 工作人员能立即把正式结果交给主持 / PPT / 舞台。

## 26.7 Failure

发生：

- 弱网；
- 浏览器刷新；
- 设备故障；
- Judge 不配合；
- 投票入口故障；
- 服务重启；

时：

> **比赛可以降级、HOLD、人工接管或恢复，但不能悄悄产生错误正式结果。**

## 26.8 Engineering

系统保持：

- 可测试；
- CI gate 清晰；
- 可部署；
- 可备份；
- 可恢复；
- 可审计；
- migration 可重复；
- 历史数据不被新功能随意破坏；
- 主 UX 不暴露不必要的版本复杂度。

---

# 27. 给后续 Agent 的最后约束

在修改 ArtFlow 前，先问自己：

```text
1. 这个需求是否真的服务于当前院十佳决赛？
2. 我是不是因为旧代码 / 旧 GOAL / 2025 材料而恢复了已经废弃的方向？
3. 我是否把现场步骤变多了，尤其是评委、观众和手机检票？
4. 我是否破坏了 authority / TEST-FORMAL / audit / fallback？
5. 我是否把内部版本追踪暴露成了普通用户的认知负担？
6. 如果是 Group Chorus，我是否只实现正式赛制真实需要的最小能力？
7. 我是否增加了复杂度，却没有消除真实的现场 failure mode？
```

如果第 2～7 项任意一个答案值得怀疑：

> **先重新核对当前产品决策和 main，而不是继续扩实现。**

ArtFlow 当前阶段最重要的不是成为“最完整的 EventOps 平台”，而是：

> **把一次真实的院十佳决赛从报名、材料、条件性分组合唱、彩排、检票、评分、投票到结果核定稳定跑完，并且在任何局部故障下仍然不会产生错误正式结果。**
