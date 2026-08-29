# GOAL.md

# ArtFlow 文艺活动运行平台开发目标 v3

> **状态：M0 System Invariant Hardening 已完成；进入 M1 Contest Domain & Rehearsal Readiness**
>
> 本文档自本版本起取代旧 `GOAL.md v2`，作为 ArtFlow 的**产品目标与领域设计最高优先级基线**。
>
> 具体实现细节、阶段任务、验收和 ChatGPT 审核结论见 `ChatGPT.md`。
>
> 当前第一生产目标仍然是信息工程学院真实文艺活动，尤其是**十佳歌手决赛的后台运行**。系统不能为了抽象完整性牺牲现场可靠性，也不能把某一年的具体赛制写死成系统规则。

---

## 0. 一句话定义

ArtFlow 是面向学生文艺活动的 **EventOps 活动运行系统**。

它要解决的不是“做一个报名网站”，而是把文艺活动筹备和现场中散落在：

- 微信/QQ群；
- Excel；
- Word；
- 纸质评分表；
- 主持手卡；
- 网盘/附件；
- 临时口头通知；
- 人工排名、筛选、加权、补位；

里的工作，收束成一套：

> **有状态、有版本、有权限、有审计、有回退、能快速给出现场唯一结果的工作系统。**

---

# 1. 当前真实业务基线

ArtFlow 后续设计必须以真实工作留痕为基线，而不是假想一个“标准十佳”。

## 1.1 现场输入仍以人工为主

现阶段必须接受以下现实：

- 评委可以继续使用纸质评分表；
- 分数由后台工作人员人工录入；
- 观众投票可能由系统产生，也可能只得到人工整理后的“观众分”；
- 选手材料、歌曲、帮唱嘉宾、节目需求等仍可能由工作人员人工收集后录入；
- 第一场正式生产不强迫评委、主持人或所有工作人员改变既有习惯。

ArtFlow 的第一价值不是强行“无纸化”，而是：

> **人工只负责输入现实中必须由人判断或收集的信息；确定性的计算、排序、排除、合流、补位、名单生成全部交给系统。**

---

## 1.2 主持人不设电子工作台为第一优先级

真实现场中：

- 主持人上台使用纸质手卡；
- 初始手卡中待公布结果的位置预留横线；
- 后台算分完成后，工作人员现场把最终名字写到手卡上；
- 后台与舞台通常只隔一道帘子。

因此 ArtFlow 不应把“主持人网页端”作为核心需求。

真正要做的是：

> **后台抄卡模式 / Backstage Result Board**

系统必须在结果可宣布后，按主持稿/手卡所需顺序给出：

- `HOLD`：不能宣布；
- `REVIEW`：存在人工裁决/缺失/冲突；
- `READY`：结果完整、已确认、可抄手卡；
- 对应的最终姓名、编号或必要说明。

---

## 1.3 十佳初赛与决赛优先级不同

### 院十佳初赛

初赛通常不是高复杂度、高风险环节。

目标：

- 能收报名；
- 能审核；
- 能进行简单打分或人工筛选；
- 能形成可靠的决赛 roster；
- 数据不丢；
- 操作简单。

不要为了初赛设计复杂 tournament engine。

### 院十佳决赛

是 ArtFlow 第一优先级。

重点：

- 多轮；
- 分组；
- 不同评分表；
- 评委原始分；
- 多轮加权；
- 观众分/观众票；
- 晋级；
- 结果锁定；
- 快速抄主持手卡；
- 音频/歌曲/帮唱材料；
- 现场异常与回退。

### 校十佳屏峰校区决赛（若当年存在）

复杂度可能高于院十佳，应作为高级 Ruleset 的压力测试和生产候选。

---

# 2. 2025 历史黄金样例

历史材料用于：

1. 验证模型表达能力；
2. 做 Golden Test；
3. 发现未来配置器必须支持的赛制原语；
4. 防止开发者把赛制写死。

**历史规则不是 2026 规则。**

---

## 2.1 2025 院十佳决赛黄金样例

已找到实际使用的三份工作人员/评委评分 Excel：

- `第一阶段评分表.xlsx`
- `第三轮评分表.xlsx`
- `第四轮评分表xlsx.xlsx`

可以确认：

### 决赛人数

- 15 位决赛选手。

### 第一轮

- 5 组 × 3 人；
- 同组共同演唱；
- 仍按个人评分；
- 5 位评委；
- Rubric：
  - 音准节奏 30；
  - 演唱技巧 30；
  - 情感表达 20；
  - 默契程度 20。

### 第二轮

- 15 人；
- 5 位评委；
- Rubric：
  - 音准节奏 30；
  - 演唱技巧 30；
  - 情感表达 20；
  - 舞台感染力 20。

### 第一阶段总分

实际 Excel 公式：

```text
第一阶段总分
=
第一轮评委平均 × 30%
+
第二轮评委平均 × 60%
+
第一阶段观众分 × 10%
```

然后形成第一阶段排名/晋级。

### 第三轮

- 10 人；
- 5 位评委；
- Rubric：
  - 合作默契 30；
  - 演唱技巧 30；
  - 情感表达 25；
  - 舞台创意 15。

第三轮工作人员表实际公式：

```text
第三阶段综合结果
=
第一阶段总分 × 60%
+
第三轮评委平均 × 40%
```

### 第四轮

- 5 人；
- 5 位评委；
- Rubric：
  - 演唱功底 30；
  - 情感表达 25；
  - 舞台掌控 20；
  - 歌曲完成度 15；
  - 舞台感染力 10。

第四轮工作人员表实际公式：

```text
第四阶段总分
=
第三轮评委平均 × 30%
+
第四轮评委平均 × 50%
+
第四轮观众分 × 20%
```

### 关键领域结论

2025 院十佳证明 ArtFlow 必须支持：

- 同一活动任意数量的比赛轮次；
- 分组表演与个人评分分离；
- 每轮不同 Rubric；
- 任意评委人数；
- Round Score；
- Composite Score；
- Composite 可以引用前一阶段 Composite；
- 观众结果可进入 Composite；
- 多阶段晋级；
- 后续轮歌曲/伴奏/嘉宾在晋级前提前准备；
- 规则冻结前可以多次修改。

---

## 2.2 2025 校十佳屏峰校区决赛黄金样例

正式赛制终稿可确认：

```text
20 人
↓
第一轮：5组×4人
↓
每组1人直接晋级第三轮：共5人
↓
剩余15人按第一轮分数取前12进入复活赛
↓
第二轮：12人复活赛
↓
按第二轮评委分取前7
↓
5名直通 + 7名复活 = 第三轮12人
↓
第三轮：3组×4人
↓
每组由评委人工决定直接晋级0~2人
↓
若总人数不足6
则按某个加权结果自动补足到6
↓
6人中产生后续晋级名单
```

正式文档给出的补位公式为：

```text
第一轮 20%
+
第二轮 30%
+
第三轮 50%
```

### 必须保留的历史歧义

第一轮直接晋级第三轮的选手不参加第二轮，但补位公式又引用第二轮成绩。

现有历史材料没有明确说明：

- 直通选手是否进入补位池；
- 如果进入，其第二轮缺失值如何处理；
- 是否应对直通选手使用另一套公式。

因此：

> **ArtFlow 不能擅自发明答案。**

该历史赛制必须成为 `RulesetValidator` 的黄金错误样例：

```text
若某条候选路径无法产生 Composite 所需要的全部输入，
Ruleset 不得 Freeze。
```

---

# 3. 赛制不确定性本身就是产品需求

每年的以下信息都可能变化：

- 报名人数；
- 决赛人数；
- 轮次数量；
- 评委人数；
- 评委是否分组/分 Panel；
- 是否去最高最低；
- 每轮 Rubric；
- 每轮权重；
- 是否累计上一阶段成绩；
- 是否有观众票；
- 观众票是否计分；
- 观众分如何换算；
- 是否有人气奖；
- 是否分组；
- 每组是否直通；
- 是否复活；
- 是否 PK；
- 是否轮空；
- 是否有待定席；
- 晋级名额；
- 是否人工裁决；
- 平分处理；
- 是否存在赛道/专业组配额；
- 是否多校区合流；
- 是否有踢馆/挑战替换。

因此开发目标不是：

> “提前预测 2026 赛制。”

而是：

> **让常见变化在赛制正式公布后无需修改 Python，只需要复制模板、调整参数、验证并 Freeze。**

---

# 4. 赛制变化的代码修改目标

## 4.1 常规变化：0 行 Python

以下变化必须通过配置完成：

- 选手人数；
- 评委人数；
- 轮数；
- 分组数；
- 每组人数；
- Top N；
- 每组 Top N；
- Rubric；
- 平均/去极值平均；
- Round 权重；
- Composite 权重；
- 观众票开关；
- 人气奖开关；
- 观众是否进入正式成绩；
- 直通；
- 复活；
- 分支；
- 合流；
- 自动补位；
- 常见 PK；
- 常见轮空；
- 常见赛道配额；
- 平分进入人工复核。

## 4.2 新 primitive 才允许改代码

只有当正式赛制出现：

> 现有强类型赛制原语无法表达的新运算语义

时，才新增 primitive。

新增 primitive 必须同时新增：

- schema；
- validator；
- resolver；
- tests；
- audit/reproducibility；
- 至少一个真实或合成 Golden Case。

禁止现场临时在 Python 中写：

```python
if activity_id == ...
```

或：

```python
if year == 2026:
```

---

# 5. 产品边界

ArtFlow 不是：

- 校级第二课堂系统；
- 通用学生管理系统；
- 商业票务平台；
- 通用低代码工作流平台；
- 任意公式执行器；
- BPMN 引擎；
- 微信生态替代品；
- 强制无纸化系统。

ArtFlow 是：

> **围绕文艺活动筹备、评审、现场决策、材料、结果、导出和归档的专业化轻量 EventOps。**

---

# 6. 总技术路线

继续保持 Django 单体。

推荐主线：

```text
Django
PostgreSQL
Django Templates
Tailwind CSS
少量 Alpine.js / HTMX
Gunicorn
Nginx/Caddy
Docker Compose（开发/验收）
```

不要因为 M1 引入：

- 微服务；
- Celery（除非后续出现明确异步刚需）；
- Redis（除非明确需要共享状态/缓存）；
- 任意规则脚本解释器；
- React 大重构；
- 工作流引擎。

---

# 7. M0 已冻结的系统不变量

M1 不允许破坏以下已经 harden 的规则。

---

## 7.1 身份与权限

角色：

```text
Guest
Participant
Staff
Admin
```

原则：

- Staff 只能执行工作人员职责；
- Admin 才能修改角色、关键权限、正式归档/解归档、紧急高风险操作；
- Production 不依赖 Django Admin 作为业务后台；
- Admin 二次密钥机制继续保留；
- 至少一个有效 Admin 的 invariant 必须保持；
- 权限修改必须审计。

---

## 7.2 Activity 是事务 aggregate root

所有 Activity-owned mutation 必须遵守：

```text
Activity
→ child aggregate / owner
→ dependent rows
```

任何依赖：

- Activity lock；
- phase；
- lifecycle；
- ActivityAction；

的 mutation，都必须在同一事务中：

```text
Activity SELECT FOR UPDATE
→ 锁后重新验证
→ child SELECT FOR UPDATE
→ mutation
→ audit
```

事务外检查只用于 UX，不是业务 authority。

---

## 7.3 GET 必须安全只读

普通 GET/HEAD 不得：

- 创建数据库记录；
- 自动同步派生状态；
- 改锁；
- 改结果；
- 改材料检查；
- 改归档；
- 改权限。

需要 reconciliation 的数据只能在明确 mutation 中维护。

---

## 7.4 TEST / FORMAL 严格隔离

TEST 活动：

- 仅 Staff/Admin 可进入完整测试路径；
- 普通用户不得误入 TEST 报名或 TEST 投票；
- TEST 内容不得公开为正式内容；
- TEST 数据必须带 lifecycle marker；
- TEST → FORMAL 前必须清理 runtime test data；
- 公开内容按规则保留为 Draft/Hidden。

---

## 7.5 锁定与归档

Activity global lock 是全局 overlay。

子锁：

- Round lock；
- VoteSession lock；
- Ruleset freeze；
- Result lock；

必须保持自己的独立状态。

`ARCHIVED`：

- 默认业务只读；
- 普通 unlock 不等于 unarchive；
- 只有明确 Admin unarchive operation 可以恢复；
- ArchivePackage 必须版本化；
- 正式归档必须可重现并可审计。

---

## 7.6 文件

内部材料必须经过受控访问。

必须保留：

- owner；
- material slot / purpose；
- version；
- current；
- upload actor/time；
- file metadata。

正式 M1 迁移后，“一个 owner + 一个粗粒度 file purpose 只有一个 current”的旧模型不再足够，必须逐步迁移到更精确的材料槽位。

---

# 8. Activity 生命周期

保留当前阶段：

```text
DRAFT
TESTING
REGISTRATION_OPEN
REGISTRATION_CLOSED
REVIEWING
REHEARSAL
LIVE
RESULTS_PENDING
RESULTS_PUBLISHED
ARCHIVED
```

阶段转换必须是显式 graph。

禁止：

> “只要向后的 phase 都能跳。”

`ARCHIVED` 不允许 generic transition。

赛制节点和比赛轮次不是 Activity Phase。

不要把：

```text
Round 1
Round 2
PK
复活
```

塞进 Activity Phase。

---

# 9. 歌手比赛领域重新定义

M1 的核心是把当前“固定初赛+复赛模型”迁移成通用但有限的比赛模型。

---

## 9.1 ContestRound 不再以 PRELIMINARY/SEMI_FINAL 作为业务权威

Round 应逐步转向：

```text
name
sequence
scheduled_at（可选）
venue（可选）
rubric
judge panel
performance configuration
ruleset binding
```

旧 `round_type` 可以作为 migration compatibility 字段暂时保留。

禁止直接一次性 destructive migration。

---

## 9.2 Round roster 必须是显式 snapshot

真正参赛名单由 `RoundEntry`/等价 snapshot 表达。

来源可能是：

- 报名筛选；
- 上一阶段 Top N；
- 每组直通；
- 复活；
- 多来源合流；
- 人工确认；
- Admin emergency override。

不要依赖一个固定：

```text
previous_round_id
```

来推断所有来源。

---

## 9.3 Performance 与 Registration 分开

`SingerRegistration` 表示：

> 这个人报名参加活动。

`Performance` / `RoundPerformance` 表示：

> 这个人在某轮具体演什么。

至少需要表达：

- singer；
- round；
- song；
- sequence；
- group；
- guest/collaborator；
- duration；
- notes；
- material slots。

不要继续在 `SingerRegistration` 上增加：

```text
song2
song3
song4
```

---

## 9.4 分组表演与评分对象分开

需要支持：

```text
PerformanceGroup
```

例如：

```text
第一组：
A
B
C
```

共同表演一首歌。

但 Score 仍可以针对每个 singer。

不要把：

> 同组表演

误建成：

> 整组只有一个 Score。

---

# 10. Rubric / 评分表

评分维度必须模板化。

核心概念：

```text
ScoringRubric
RubricCriterion
```

Criterion 至少包含：

- name；
- max_score；
- sequence；
- description（可选）。

示例：

```text
第一轮合唱：
音准节奏 30
演唱技巧 30
情感表达 20
默契程度 20
```

不同 Round 可使用不同 Rubric。

---

## 10.1 评分输入方式

P0：

```text
纸质评分
→ Staff 快速录入
```

可选：

```text
评委网页打分
```

评委端不能成为唯一生产路径。

---

## 10.2 支持的基础聚合

至少：

```text
MEAN
TRIMMED_MEAN
```

未来按真实规则可扩展：

```text
WEIGHTED_JUDGE_PANEL
BALLOT_COUNT
MAJORITY_BALLOT
```

去最高最低必须配置参数，例如：

```text
trim_high=1
trim_low=1
```

如果 Judge 数量不足，Ruleset 不允许 Freeze/Prepare。

禁止静默退化成普通平均。

---

# 11. Audience Vote

VoteSession 永远负责：

> 收票与形成票数事实。

不要让 VoteSession 自己决定是否进入正式成绩。

Vote 至少有业务用途：

```text
POPULARITY
SCORE_COMPONENT
SELECTION
OTHER
```

### Popularity

```text
Vote
→ Award
```

不影响正式晋级。

### Score Component

```text
Vote result
→ VoteScoringRule
→ normalized AudienceScore
→ Composite
```

### Selection

例如：

```text
失败者池
→ 观众复活 Top1
```

直接产生 roster decision。

---

## 11.1 不允许猜 VoteCount → AudienceScore 公式

2025 院十佳工作人员表里已经存在：

```text
第一阶段观众打分
第四轮观众打分
```

但现有留痕没有给出：

> 原始票数如何转换成 0–100 观众分。

因此第一版可以支持：

```text
Staff 手工输入已归一化 AudienceScore
```

如果当年正式规则明确换算公式，再配置自动转换。

禁止开发者擅自假定：

```text
最高票 = 100
其他按比例
```

---

# 12. Versioned Ruleset

赛制必须从 Python 分支逻辑中抽离。

核心概念：

```text
ContestRuleset
RulesetVersion
```

RulesetVersion 至少：

- activity/template association；
- version；
- schema_version；
- definition；
- status：
  - DRAFT；
  - FROZEN；
  - SUPERSEDED；
- content_hash；
- created_by；
- created_at；
- frozen_by；
- frozen_at。

推荐赛制拓扑使用：

> **受 schema 严格约束的 versioned JSON definition**

而不是为每种赛制建一套 Python class。

---

# 13. Ruleset 是强类型规则图，不是任意低代码

M1 使用：

> **Forward-only Typed Rule Graph**

节点只能引用此前已经产生的输出。

禁止：

- 任意 Python；
- 任意 JS；
- 自定义 SQL；
- 自由数学表达式；
- 任意循环；
- 动态未知 node type。

---

## 13.1 核心 primitive

第一版目标支持以下有限原语。

### ROSTER

产生/引用候选人集合。

来源：

- approved registration；
- previous node；
- manual seed；
- merge result。

### PARTITION

按：

- 分组；
- 赛道；
- 队伍；
- 指定名单；

拆成多个 group。

### PAIR

根据：

- 相邻；
- 1 vs N；
- seeded；
- manual challenge；

生成 PK pair。

### ASSESS

产生原始评价结果。

可以是：

- judge score；
- judge ballot；
- audience vote；
- manual decision。

### AGGREGATE

把 Assessment 变成一个数值/结果。

至少支持：

- mean；
- trimmed mean；
- weighted source sum。

### RANK

根据某个 Score/Composite 对 roster 排序。

### SELECT

至少：

- Top N；
- Bottom N；
- Top N per group；
- Top percentage（后续需要再开放）。

### BRANCH

把同一 roster 分成受控 outcome：

- DIRECT；
- ADVANCED；
- REPECHAGE；
- PENDING；
- ELIMINATED；
- WILDCARD；
- 其他受控 outcome。

### SUBTRACT

从候选池排除已经：

- direct；
- selected；
- eliminated；

的选手。

### MERGE

合并多个 roster。

必须自动去重/检测重复。

### FILL_TO_QUOTA

已有选中人数不足目标时：

```text
target = N
current = X
need = N-X
```

自动从指定 pool 按指定 ranking 补足。

### MANUAL_SELECT

只用于赛制本身明确要求人作裁决。

必须配置：

- source roster；
- min；
- max；
- per-group / global；
- actor role。

### REPLACE

用于挑战/踢馆类：

```text
challenger wins
→ replace existing slot
```

### AWARD

根据：

- final rank；
- vote；
- manual selection；

产生奖项。

---

# 14. StageDecision 不再只有 is_advanced

未来不要把复杂赛制继续压成：

```text
is_advanced=True/False
```

至少需要：

```text
StageDecision
    contestant
    source_node
    outcome_code
    rank/score（可选）
    reason/details
    ruleset_version
    result_version
```

常见 outcome：

```text
DIRECT
ADVANCED
REPECHAGE
PENDING
ELIMINATED
WILDCARD
FINALIST
```

---

# 15. Composite Score

Composite 必须是正式一等公民。

支持：

```text
RoundScore × weight
CompositeScore × weight
AudienceScore × weight
```

例如 2025 院十佳：

```text
Stage1 =
R1 × 0.30
+ R2 × 0.60
+ Audience1 × 0.10
```

再：

```text
Stage2 =
Stage1 × 0.60
+ R3 × 0.40
```

禁止为具体 Stage 写：

```python
if round_number == 3:
```

---

# 16. Ruleset Validator / Compiler

Ruleset 不能只做到“JSON 能保存”。

Freeze 前必须静态验证。

至少包括：

---

## 16.1 图合法性

- node id 唯一；
- 所有 source 存在；
- 只能引用过去节点；
- 无循环；
- output type 与 input type 匹配。

---

## 16.2 Score dependency

对于 Composite 中的每个 source：

> 所有可能进入该 Composite 候选池的路径，都必须能产生对应 score。

若无法保证：

```text
Ruleset INVALID
```

2025 校十佳：

> 第一轮 direct 选手没有 R2，却可能进入引用 R2 的 fallback

必须作为 validator Golden Error。

---

## 16.3 Weight

需要归一化时：

```text
sum(weights) == 1.0 / 100%
```

禁止：

- 30+60+20；
- 漏 component；
- 重复 component。

---

## 16.4 Score scale

禁止未经转换直接混合：

- 10 分制；
- 100 分制；
- raw votes；
- rank ordinal。

如需转换，必须有明确 ScoringRule。

---

## 16.5 Judge count

如：

```text
TRIMMED_MEAN high=1 low=1
```

则 Judge 数必须足够。

---

## 16.6 Quota

检查：

- Top N 不超过理论候选人数；
- FillToQuota pool 足够；
- group top N 不超过组容量；
- manual min/max 合法。

---

## 16.7 Pairing

若人数为奇数：

必须明确：

- bye；
- wildcard；
- manual；
- reject。

---

## 16.8 Tie

所有决定性 cutoff 必须明确：

- 自动 tie-breaker；
- extra round；
- manual review；
- score component fallback。

若无规则：

```text
REVIEW
```

禁止按 PK/数据库顺序偷偷决定。

---

## 16.9 Vote dependency

如果某 Ranking 引用 Vote：

- VoteSession 必须在该 node 之前产生可用结果；
- Vote purpose 必须允许被该 component 使用；
- 如果需归一化，规则必须存在。

---

# 17. Ruleset Freeze

正式评分前：

```text
RulesetVersion = FROZEN
```

Freeze 后普通 Staff 不得修改：

- node；
- weight；
- scoring mode；
- advancement；
- vote role；
- tie rule；
- material/round critical binding。

如果规则临时变更：

```text
Admin unlock / supersede
→ 创建新 RulesetVersion
→ 重新验证
→ Freeze 新版本
→ Audit
```

禁止原地修改已经冻结 JSON。

正式结果必须记录：

```text
ruleset_version
content_hash
```

保证赛后可以回答：

> “当时到底按哪一版规则算？”

---

# 18. Runtime Resolver

正式现场不允许工作人员手工执行确定性规则。

Raw input：

- ScoreRecord；
- VoteResult；
- ManualDecision；
- roster snapshots。

进入：

```text
StageResolver
```

产生：

- Score/Composite；
- Rank；
- StageDecision；
- AnnouncementResult；
- execution state。

---

## 18.1 Resolver 状态

后台只允许三类主要状态：

```text
HOLD
REVIEW
READY
```

### HOLD

缺必要输入，例如：

- 评委漏分；
- Vote 未结束；
- manual node 未提交。

### REVIEW

系统已经算出，但存在规则要求的人工判断，例如：

- cutoff tie；
- manual group direct；
- emergency override。

### READY

所有必要输入完整；

所有 deterministic rule 已执行；

所有 manual node 已完成；

结果可锁定/宣布。

---

## 18.2 自动运行

最后一个必要输入写入后：

```text
commit raw input
↓
auto evaluate
↓
auto resolve
↓
update result state
```

不应要求工作人员：

```text
录完 → 点计算 → 打开排名 → 手工勾人
```

---

# 19. 现场性能目标

比赛人数通常只有几十人，数学计算量非常小。

目标：

```text
最后一个必要 input commit
→ resolver complete
< 200 ms（目标）
```

```text
最后一个必要 input
→ 后台结果页显示 READY
< 1 s（目标）
```

真正耗时应主要来自：

> 工作人员把纸上的原始分录入系统。

---

# 20. Rapid Score Entry

录分页面优先服务键盘速度。

必须考虑：

- Grid；
- Enter/方向键；
- 自动跳格；
- 分数范围即时验证；
- 批量粘贴表格；
- 缺失格高亮；
- 已录/总数；
- 多工作人员并发录不同 Judge；
- 最后一格完成自动触发 resolver；
- 不要求额外“计算”按钮。

UI 美观服从录入效率。

---

# 21. Backstage Result Board / 抄卡模式

这是 M1 现场核心能力。

结果页面应：

- 大字；
- 高对比；
- 少信息；
- 与主持手卡顺序一致；
- 清晰显示 HOLD/REVIEW/READY。

示例：

```text
READY

直接晋级第三轮（5）
1. ...
2. ...

进入复活赛（12）
1. ...
...

本轮淘汰（3）
1. ...
```

工作人员只需要照抄。

不要求主持人登录或联网。

可选后续：

- 一键复制纯文本；
- 生成打印小条；
- 与主持稿模板关联。

---

# 22. Material / Performance Slot

2025 院十佳证明：

> 后续轮次歌曲、伴奏、帮唱嘉宾可能在晋级前全部提前收集。

所以一个 Singer 不能只有：

```text
一个 current accompaniment
```

未来必须支持：

```text
MaterialSlot
```

例如：

```text
R1 accompaniment
R2 accompaniment
R3 accompaniment
R4 accompaniment
R3 guest material
lyrics
background video
```

材料槽可以提前完整准备。

晋级只决定：

> 哪些 Performance/MaterialSlot 真正在现场执行。

---

# 23. 初赛 / Screening

初赛优先简单。

至少支持：

### Manual Screening

Staff 对 approved registrations：

```text
选择进入决赛
```

### Simple Judge Ranking

```text
Round
→ Score
→ Top N
```

### 多校区

允许分别形成 shortlist，再由 Staff/Admin 合并为决赛 roster。

不要为了初赛先做复杂 multi-venue tournament engine。

---

# 24. Ruleset Templates

模板是：

> Ruleset definition 的可复制预设。

不是特殊 Python 类。

至少准备：

1. `Simple Screening`
2. `Single Round Top-N`
3. `Weighted Multi-Round`
4. `Judge + Audience Composite`
5. `Independent Popularity Award`
6. `Group Direct + Repechage`
7. `Seeded PK + Wildcard`
8. `Direct Bye + Middle PK + Bottom Elimination`
9. `Team / Track Quota`
10. `Multi-Venue Merge`
11. `Challenge / Replacement`（高级模板）

产品 UI 第一阶段不必一次展示全部。

---

# 25. Template 与 Instance 分离

```text
RulesetTemplate
```

只保存通用结构。

```text
RulesetVersion / ContestRulesetInstance
```

绑定某一实际活动。

复制模板后：

- 修改人数；
- 修改评委；
- 修改权重；
- 增删 Vote；
- 修改 Rubric；
- 修改晋级参数；

都只影响当前活动实例。

系统模板更新不能改变历史活动。

---

# 26. 2026 规则正式公布后的目标流程

规则出来后：

```text
选择最接近的模板
↓
复制为活动 Ruleset Draft
↓
调整参数
↓
运行 Validator
↓
用模拟数据 preview
↓
工作人员/负责人核对
↓
Freeze
↓
正式评分
```

理想情况：

> 0 行 Python 修改。

---

# 27. Emergency Override

现场必须有最后兜底。

如果由于：

- 主席团临时裁决；
- 选手退赛；
- 文档本身有歧义；
- 不可预见的特殊情况；

需要改变系统建议结果：

只有 Admin 可以：

```text
Emergency Override
```

必须保留：

- 原始评分；
- 原规则计算结果；
- old decision；
- new decision；
- actor；
- timestamp；
- optional note；
- audit。

禁止通过直接改 ScoreRecord 伪造人工裁决。

---

# 28. Score Workbook / Excel fallback

Excel 继续是重要现场 Plan B。

必须：

- 使用稳定 ID；
- 有 activity id；
- round id；
- snapshot entry ids；
- judge ids；
- schema version；
- snapshot fingerprint。

导入时必须严格验证当前 snapshot。

旧 workbook：

```text
reset / reprepare 后 roster 或 judge 变化
```

必须拒绝。

错误导入：

> 全表失败，0 partial ScoreRecord mutation。

---

# 29. 观众投票生产策略

保持：

```text
扫码 + 现场口令
```

轻量防刷。

第一生产目标：

- 能投；
- 能开关；
- 能锁；
- 能导出；
- 不误伤正常观众；
- 能作为 Ruleset source 或 Award source。

不做：

- 微信强实名；
- 手机号验证；
- 高复杂设备指纹。

---

# 30. 毕晚

毕晚不进入复杂评分 engine。

核心：

- 节目征集；
- 审核；
- 多材料槽；
- 彩排；
- 节目顺序；
- 负责人；
- 音频/视频/文字；
- 主持素材；
- 现场执行包；
- 归档。

Contest Ruleset 不能污染毕晚主流程。

---

# 31. Public Portal

继续支持：

- 当前活动；
- 报名；
- 通知；
- 往届风采；
- 结果；
- 活动回顾。

要求：

- TEST 内容普通用户不可见；
- 页面像真实学院活动网站；
- 不做明显 AI 风；
- 工作人员能维护；
- 不把 public portal 和后台核心交易耦合。

---

# 32. Material Review

保持：

```text
MISSING
UPLOADED
APPROVED / REVIEWED
NEEDS_SUPPLEMENT
```

或等价清晰状态。

选手：

- 报名开放时可修改允许字段；
- 审核阶段只补被退回内容；
- LIVE/归档后只读。

GET 不允许自动 reconciliation 写库。

---

# 33. Export

敏感数据默认必须 activity-scoped。

Staff：

> 默认只能导指定 Activity。

Admin：

> 可以显式跨 Activity 导出。

所有包含：

- 手机号；
- 微信；
- 学号；
- 私有材料；
- 成绩；

的导出必须 Audit。

---

# 34. Execution Package

现场执行包与归档包必须分开。

执行包是活动前/现场使用：

- 正式 roster；
- 顺序；
- 联系方式；
- 材料状态；
- 当前伴奏/音频索引；
- 评分空表；
- QR；
- 工作人员备注；
- 手卡待填项/结果抄写模板；
- 异常记录空表。

归档包是活动后事实。

---

# 35. Archive

正式归档至少包含：

- activity metadata；
- ruleset frozen version/hash；
- roster snapshots；
- raw scores；
- composite results；
- decisions；
- vote results；
- awards；
- materials index；
- GeneratedDocuments；
- incidents；
- audit summary；
- final exported results。

ArchivePackage：

- version 唯一；
- 一个 Activity 最多一个 current；
- 解归档后旧包保留历史；
- 重新归档产生新 version。

---

# 36. Backup / Restore

数据库备份不等于完整 ArtFlow 备份。

Application backup set：

```text
database
media
manifest
hashes
migration/version information
```

正式活动前必须完成真实恢复演练：

- 新 PostgreSQL；
- 新 media；
- 恢复；
- 登录；
- 分数；
- 投票；
- 文档；
- 伴奏真实可访问。

---

# 37. 第一场生产的大文件策略

大视频不是第一优先级。

第一场建议 ArtFlow 原生管理：

- 伴奏；
- 图片；
- Word/PDF/普通附件；
- 歌词/主持材料。

几百 MB 视频如果非刚需：

> 使用已有网盘/学校存储链接。

不要让三个慢速 500MB 上传占满 Web worker。

---

# 38. UI 总原则

公开端：

- 简洁；
- 大学活动门户感；
- 清楚；
- 少装饰；
- 不要 AI 风。

后台：

- 信息密度服从工作效率；
- 状态明显；
- 危险操作明确；
- 表格适合快速扫描；
- 现场模式优先键盘和大字；
- 不为“炫酷”牺牲可靠性。

---

# 39. 生产验收目标

正式十佳前必须完成：

### 数据与权限

- M0 invariants 全绿；
- PostgreSQL transaction tests；
- TEST/FORMAL 隔离；
- archive immutability；
- role authority。

### 赛制

- Ruleset 可 Freeze；
- Validator 全绿；
- 2025 院十佳 Golden Test；
- 2025 校十佳屏峰 Golden Test；
- 当前正式规则实例化后通过模拟。

### 现场

- 纸质评分 → 快速录入；
- 自动计算；
- HOLD/REVIEW/READY；
- 可直接抄主持手卡；
- deterministic selection 无人工筛选。

### 回退

- Excel fallback；
- backup/restore；
- Admin emergency override；
- 服务重启。

---

# 40. 现场 SLO

正式彩排时记录：

```text
最后一张必要评分纸到后台
→ READY
```

参考目标：

- 单人熟练录入：尽量 < 60 s；
- 两人并行录入：尽量 < 30 s；
- 最后一项输入 commit 后系统计算：< 1 s。

实际目标根据彩排数据调整。

---

# 41. M1 开发顺序

具体任务、原因、实现约束、验收详见 `ChatGPT.md`。

总体顺序：

```text
M1-A 迁移/黄金夹具/残余 P1 基线
M1-B Generic Contest Domain Foundation
M1-C Versioned Typed Ruleset Schema
M1-D Ruleset Compiler / Validator
M1-E Deterministic Resolver / StageDecision
M1-F 2025 院十佳 Golden Simulation
M1-G 2025 校十佳屏峰 Golden Simulation
M1-H Backstage Rapid Entry & Result Board
M1-I Template Library & Ruleset Editor
M1-J Production Rehearsal / DR / Operations
M1-K 2026 正式赛制实例化、Freeze 与上线 Gate
```

禁止跨阶段一次性大重构。

---

# 42. 当前明确未知、禁止擅自决定的事项

在正式规则公布前，任何 Agent 不得自行决定：

- 2026 院十佳决赛人数；
- 2026 校十佳屏峰是否举办；
- 评委人数；
- 是否去最高最低；
- 各轮权重；
- 观众是否计分；
- 观众原始票如何换分；
- 每轮晋级数；
- 是否复活；
- 是否 PK；
- 平分规则；
- 人气奖规则；
- 初赛具体形式。

这些必须留为配置。

---

# 43. 历史资料证据优先级

当历史资料互相冲突时：

```text
实际工作人员算分表 / 实际现场记录
>
最终赛制终稿
>
最终主持稿/议程
>
预热推送/宣传材料
>
早期策划草案
```

但即使高优先级文件仍存在歧义，也不得擅自补全。

应记录：

```text
UNRESOLVED
```

并让 Ruleset Validator / 当前负责人解决。

---

# 44. 关键历史资料

目前应长期保留为开发/测试依据：

### 2025 院十佳

- `第一阶段评分表.xlsx`
- `第三轮评分表.xlsx`
- `第四轮评分表xlsx.xlsx`
- 2025“逐星”十佳相关策划/主持/歌曲名单
- `artflow_2025_legacy_fixture`

### 2025 校十佳屏峰

- `“旷野”屏峰校区决赛赛制终稿.docx`
- `2025 旷野校十佳主持稿终稿...`
- `“旷野”校十佳歌手决赛议程...`
- `副本校十佳歌曲名单.xlsx`

这些是 Golden Test 来源，不是新赛季默认规则。

---

# 45. 最终原则

ArtFlow 第一目标不是功能多。

第一目标是：

> **活动能完整跑下来，尤其结果产生环节不能掉链子。**

第二目标是：

> **确定性规则不让人手工筛选；人只处理真正需要人判断的部分。**

第三目标是：

> **赛制变化尽可能只改配置，不改核心代码。**

第四目标是：

> **所有正式结果都能回答：谁输入、按哪版规则、如何算出、何时锁定、是否被改过。**

第五目标是：

> **不强迫真实现场改变所有既有习惯，而是先替换最危险、最耗时、最容易出事故的人工环节。**
