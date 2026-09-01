继续审完了。这一包相对上一包的进步依然很明显，而且 **R9-Final 里最核心的 A→B→A、数值 scale、tie-break 一致性、DB 唯一约束等都真正落了地**。

但我现在不建议再把时间花在继续“磨 Ruleset 编译器细枝末节”上，因为这次审核把一个更重要的问题彻底暴露出来了：

> **Ruleset Engine 本身已经接近能用，但它和真实十佳业务之间还没有真正接通。**
>
> 现在最大的风险已经从“引擎算错”逐渐转变成：
>
> **引擎算的是正确东西，但喂给它的 roster、轮次、晋级、分组等事实还来自旧 PRELIMINARY/SEMI_FINAL 系统。**

所以这一轮之后，我建议只做一次很小的 **M1-Core-Close**，然后马上进入真正的 M1 integration，不能继续无限 R10、R11、R12 式架构打磨。

---

# 一、当前总判定

我实际重新解压了：

```text
ArtFlow-main(20260901-050901).zip
```

并重新读了当前源码。

实际执行：

```text
python -m compileall -q .
```

**PASS。**

当前仓库约：

* 224 个 Python 文件；
* 约 39k Python LOC；
* 约 790 个测试函数量级。

完整 Django/pytest/ruff/mypy 依然无法在我的当前离线沙箱完整执行，所以我不会说“全套测试已通过”。

### 当前评分

我会给：

* **Ruleset/Resolver Core：8.6/10 左右**
* **M1 整体真实生产闭环：约 7.5/10**

两者为什么有差距，下面会非常明显。

当前结论：

> **R9-Final：PARTIAL PASS，尚不能 CLOSED。**
>
> **M1-J Shadow Rehearsal：NO-GO。**
>
> 但已经不需要再重构 Ruleset Engine 的总体架构。

---

# 二、先说这包已经真正修好的东西

这几个不要再让 DeepSeek 回头重构。

## 1. A → B → A 的结果版本问题，已经修对

之前：

```text
输入 A → v1
输入 B → v2
重新改回 A → 复用旧 v1
```

导致 v1 无法再核定。

现在 `persist_stage_result()` 改成只比较：

> **当前 latest StageResult**

所以：

```text
A → v1
B → v2
A → v3
```

正确。

这个设计符合现场实际：

> 第三次算出来虽然数值和第一次一样，但它确实是经过一次修正后的新发布结果。

### PASS。

---

# 三、`RulesetVersion.is_current` 的基础 DB 语义也终于正确

现在：

```python
is_current = models.BooleanField(default=False)
```

而不是以前：

```text
DRAFT 默认 current=True
```

并且有：

```text
is_current ⇒ FROZEN
```

DB CheckConstraint。

`ContestRuleset` 也终于有：

```text
UNIQUE(activity)
```

。

### 方向 PASS。

---

# 四、Scale 不再只有“10分/100分”的二元假模型

现在 `_round_scale()` 已经根据 Rubric 总分计算：

```text
30 + 30 + 20 + 20 = 100
```

而不是以前看：

```text
max criterion = 30
```

然后错误判为“10分制”。

并且现在可以产生：

```text
"100"
"50"
"10"
```

这比：

```text
ten / hundred
```

合理很多。

### Core PASS。

不过编辑器还有兼容问题，后面说。

---

# 五、Tie-break 也比上一版严谨很多

Compiler 现在明确要求：

```text
SELECT auto_break 的 tie_break_source
==
来源 RANK 的 tie_break_source
```

避免：

```text
RANK 实际按 roster 排
SELECT 却声称按另一个成绩破平
```

的假规则。

Resolver 的 cutoff 判断也改成真正看：

> 截止线两侧是否被 secondary source 区分。

而不是：

> 整个 tie group 内只要出现两个 secondary 值就算解决。

这是正确修复。

---

# 六、Fill 最后一名同分不会再偷偷按 roster 顺序补了

这是非常重要的一项。

现在：

```text
还差 1 个名额

A = 90
B = 90
```

不会：

```text
谁 roster 在前就补谁
```

而是：

```text
REVIEW
```

。

### PASS。

---

# 七、校十佳历史 fixture 现在基本忠实了

目前已经真正分开：

```text
historical_xiaofeng_control_flow
```

```text
historical_xiaofeng_fallback_unresolved
```

```text
synthetic fill demo
```

而不是把 synthetic per-group fill 假装成“2025屏峰赛制”。

历史 fallback 也已经恢复：

```text
R1 20%
R2 30%
R3 50%
```

并按真实路线：

```text
20
↓
分组直通
↓
remainder
↓
Top12复活
↓
R2 Top7
↓
merge12
↓
R3
↓
20/30/50
```

这终于能准确暴露：

> direct path 有 R1、R3，但没有 R2。

这一块我基本可以判：

# **历史真实性 PASS。**

只剩少量测试注释文字问题。

---

# 八、Preview 也彻底不污染正式结果了

现在：

```text
preview=True
```

只返回内存：

```text
ResolveResult
```

不会再写：

```text
StageResult
StageDecision
CompositeResult
```

。

### PASS。

---

# 九、但当前第一个 P0：所谓“service-only 状态跃迁”仍可以被公开 bypass 参数绕过去

这是 R9-Final 还不能关的第一原因。

现在为了让正式 service 能写：

```text
DRAFT → FROZEN
```

引入了：

```python
_allow_freeze=True
```

为了：

```text
READY_TO_CONFIRM → CONFIRMED
```

引入：

```python
_bypass_confirmed=True
```

。

问题是：

# 它们只是名字以下划线开头，并不是真的私有。

任何仓库代码都可以：

```python
RulesetVersion.objects.create(
    status="frozen",
    is_current=True,
    ...,
    _allow_freeze=True,
)
```

。

直接绕掉：

* Admin 权限；
* Activity lock；
* bound compiler；
* authority hash；
* Audit。

StageResult 同理：

```python
StageResult.objects.create(
    status="confirmed",
    ...,
    _bypass_confirmed=True,
)
```

。

当前 tests 里甚至大量直接这么造。

---

# 十、这和我们的 invariant 不一致

我们想要的是：

> `freeze_ruleset_version()` 是唯一正式 Freeze authority。

不是：

> “大家约定除了测试以外不要传 `_allow_freeze=True`。”

同理：

> `confirm_stage_result()` 应该是唯一 Confirm authority。

---

## 推荐修法

你已经在 `ManualDecision` 用了 thread-local/internal authorization 思路。

RulesetVersion 和 StageResult 也照这个方向统一即可：

```text
with _authorized_ruleset_freeze():
    ...
```

内部 service 使用。

Model/QuerySet 不接受：

```text
_allow_freeze
_bypass_confirmed
```

这类公开参数。

测试也不要自己造官方 Frozen/Confirmed。

测试需要 Frozen：

> 调正式 service 或 test fixture helper，而 fixture helper 内部使用同一 internal authorization context。

---

# 十一、P0：CONFIRMED StageResult 仍然可以被添加新 Decision

这也是一个真实 finality 缺口。

虽然：

```text
StageDecision.bulk_create()
CompositeResult.bulk_create()
```

现在已经会检查：

> parent 是否 CONFIRMED。

很好。

但是普通：

```python
StageDecision.objects.create(
    stage_result=confirmed_stage,
    ...
)
```

仍可以。

因为 instance `save()`：

```text
_state.adding=True
```

时 `_parent_confirmed()` 不检查父记录。

CompositeResult 一样。

于是：

```text
StageResult CONFIRMED
```

之后仍可以：

```text
+ 新 StageDecision
+ 新 CompositeResult
```

。

这就不是 immutable。

---

## 必须加测试

以下全部必须拒绝：

```text
confirmed.decisions.create(...)
StageDecision(...).save()
StageDecision.objects.create(...)
StageDecision.objects.bulk_create(...)
```

Composite 同理。

---

# 十二、P0：ManualDecision 仍然可以通过 QuerySet 绕掉正式 service

现在正常：

```text
set_manual_decision()
delete_manual_decision()
```

已经是：

```text
Activity
→ RulesetVersion
→ ManualDecision
```

，这很好。

但是 `ManualDecision` 没有 guarded QuerySet。

因此：

```python
ManualDecision.objects.filter(...).update(...)
```

可以直接绕过：

* Activity lock；
* current version；
* CONFIRMED dependency；
* Audit；
* thread-local write authorization。

同样：

```text
QuerySet.delete()
bulk_create()
```

也能绕。

---

## 所以 ManualDecision 需要和 StageResult 同等级的 Manager guard

生产 mutation：

> 只有 authorization context 中允许。

默认：

```text
create
update
delete
bulk_create
bulk_update
```

全部禁止正式修改。

---

# 十三、P0：真正的“正式发布结果”仍然有三个 API

现在概念上已经说：

```text
recompute_activity_result()
```

是：

> AUTHORITATIVE publication path

但是实际上还有公开：

```python
run_ruleset(...)
```

以及：

```python
persist_stage_result(...)
```

。

---

## `run_ruleset()` 允许调用者手塞事实

比如：

```python
run_ruleset(
    current_frozen_version,
    activity,
    round_keys=my_rounds,
    vote_scores=my_scores,
    manual=my_manual,
)
```

只要：

```text
current Frozen
```

，它就会持久化一个：

# 正式 StageResult。

这些输入不一定来自：

> Frozen binding + DB 当前正式事实。

---

# 十四、`recompute_activity_result()` 自己甚至仍支持 `round_keys` override

当前：

```python
def recompute_activity_result(
    ...,
    round_keys=None,
)
```

。

于是正式结果可以：

```text
Frozen binding:
r1 → Round #10

但调用：
round_keys={"r1": #99}
```

。

StageResult 最终记录：

```text
RulesetVersion v4
authority_hash = v4 frozen binding
```

但实际算的是：

```text
Round #99
```

。

这破坏了最核心的可重现性：

> 看 StageResult 根本无法知道正式结果使用了 override。

---

# 十五、这里已经没必要保留“灵活低层 API”

现在 production API 应该只剩两个：

### Preview

```python
preview_ruleset(...)
```

* 可传 synthetic facts；
* 可运行历史 version；
* 不落正式 StageResult。

### Formal

```python
recompute_activity_result(activity, actor, checkpoint)
```

必须：

```text
current FROZEN
+
Frozen binding
+
DB raw facts
```

。

不允许：

```text
ruleset override
round_keys override
vote_scores override
manual override
```

。

当前 `run_ruleset()` / `persist_stage_result()` 可以改：

```text
_run_ruleset
_persist_stage_result
```

只作为内部实现。

---

# 十六、P0：三个 migration 对已有脏数据还不够安全

这是这包另一个明确问题。

## 16.1 `ruleset 0011`

重复 Activity 的两个 Ruleset：

```text
Ruleset A v1
Ruleset B v1
```

migration 要把 B reparent 到 A。

发现：

```text
A 已经存在 version=1
```

直接：

```python
raise ValueError(...)
```

。

但 migration 本来的目的就是：

> 清理旧版本允许产生的重复数据。

两个独立 Ruleset 都从 v1 开始是非常自然的。

所以：

# migration 很容易自己卡死。

---

## 正确方案

稳定重编号：

```text
canonical max_version = 3

dup:
v1 → v4
v2 → v5
...
```

按：

```text
version, pk
```

确定顺序。

然后 reparent。

不要删除历史 Version。

---

# 十七、16.2 `StageResult 0018` 先加 UNIQUE，却没有先清重复

现在：

```text
0018
→ AddConstraint(
    activity,
    stage_key,
    result_version
)
```

。

但上一版本代码本来就存在：

> 并发产生相同 result_version

的可能。

如果旧 DB 已经出现：

```text
Stage A v5
Stage A v5
```

0018 会：

# 直接 migration FAIL。

应该先：

```text
RunPython stable renumber
```

再 AddConstraint。

---

# 十八、16.3 `0019` 对旧 CONFIRMED trail 清洗仍可能失败

现在会补：

```text
confirmed_at
```

。

但是旧 DB 如果存在：

```text
status = CONFIRMED
confirmed_by = NULL
```

。

migration 不补 actor。

随后 DB Check 要求：

```text
CONFIRMED
→ confirmed_by NOT NULL
```

。

于是：

# migration 仍然失败。

由于旧版本确实允许：

```text
QuerySet.update(status="confirmed")
```

，所以这种数据并不是理论上不可能。

---

## 安全做法

如果无法可靠恢复 confirmer：

```text
status=CONFIRMED
but confirmed_by NULL
```

不要编造用户。

应：

```text
demote → READY_TO_CONFIRM
confirmed_at = NULL
confirmed_by = NULL
```

。

然后由工作人员重新核定。

---

# 十九、现在还有一个很关键的编辑器/Compiler scale 不一致

底层现在正确地开始用：

```text
100
50
10
```

数值 scale。

但 `schema.py` / editor 仍然只允许：

```text
hundred
ten
raw
ordinal
votes
```

。

后台选择：

```text
scale = hundred
```

真实 Rubric：

```text
scale = 100
```

Compiler bound validation：

```text
"hundred" != "100"
```

然后：

```text
ASSESS_SCALE_BINDING_MISMATCH
```

。

也就是说：

> 编辑器现在提供了一个用户根本不应该填写、而且会和实际绑定打架的字段。

---

## 最好的方案

对于绑定 Round/Vote 的 ASSESS：

# 不让 Staff 配 scale。

直接从：

```text
Rubric.total_max_score
Vote source type
```

推导。

只有没有实际 binding 的 Template：

> 才允许声明 expected scale。

如果保留 UI alias，则最少需要 normalize：

```text
hundred → 100
ten → 10
```

。

但既然要支持 50 分制，长期还是：

```text
positive numeric max
```

更正确。

---

# 二十、Vote 模型当前进入了“安全但功能不完整”的阶段

好的一面：

```text
RawVoteCount
```

终于不再被当 Score。

但 Compiler 目前：

> 任何 vote ASSESS 只要不是 `SCORE_COMPONENT` 就 ERROR。

所以：

```text
POPULARITY
SELECTION
```

这两种原本应该合法的 raw-vote 用途也不能 Freeze。

---

## 例如非常常见的复活

```text
Loser Pool
↓
Audience raw votes
↓
RANK
↓
Top1 revive
```

完全合法。

它根本不需要 AudienceScore。

---

## 正确语义

### SCORE_COMPONENT

```text
raw votes
```

→ **ERROR**

必须有：

```text
AudienceScore / VoteScoringRule
```

。

### POPULARITY

```text
raw votes
→ RANK
→ Award
```

合法。

### SELECTION

```text
raw votes
→ RANK
→ SELECT
```

合法。

这个要在 M1-I 模板真正开放前补。

---

# 二十一、但更大的问题来了：现在 Final Ruleset 的初始 roster 根本不是真正决赛名单

这是这轮最重要的**集成级问题**。

当前：

```python
bind_resolve_input()
```

把初始：

```text
entry
```

定义成：

```python
SingerRegistration.objects.filter(
    activity=activity,
    pre_status=APPROVED,
)
```

。

也就是说：

# 所有审核通过的报名者。

---

## 现实院十佳

比如：

```text
报名 60 人
↓
初赛
↓
15 人进决赛
```

。

Final Ruleset 应该从：

```text
15 finalists
```

开始。

当前 Ruleset Engine 却会得到：

```text
60 approved registrations
```

。

---

# 二十二、现有 Golden Test 为什么没发现

因为测试直接造：

```text
exactly 15 approved
```

或者：

```text
exactly 20 approved
```

。

于是：

```text
approved roster
==
final roster
```

恰巧相等。

这掩盖了真正业务问题。

---

# 二十三、这个必须改成 Explicit Seed Roster

GOAL 其实早就写对了：

> Round roster 必须是显式 snapshot。

所以 Ruleset initial `entry` 应绑定一个真正的：

```text
RosterSnapshot
```

或者最低成本直接绑定：

```text
first final RoundEntry snapshot
```

。

比如：

```text
binding:
  seed_round_id = 123
```

然后：

```text
entry roster
=
RoundEntry(round=123)
```

。

Compiler：

```text
entry_size
```

也必须从同一个 snapshot 来。

Input fingerprint 也必须包含：

```text
seed roster ids
```

。

---

# 二十四、这个不是“以后优化”，它直接阻止真实十佳 Shadow Rehearsal

因为你要拿：

> 去年15名院十佳决赛选手

模拟真实流程。

如果前面还有初赛/报名：

Ruleset Final 现在根本不知道：

> 哪15个人才是决赛人。

所以：

# **Explicit Finalist Roster = 下一个 Integration P0。**

---

# 二十五、第二个 Integration P0：Round prepare 还是旧的“初赛 → 复赛”硬编码

现在 `prepare_round()`：

```python
if PRELIMINARY:
    singers = all approved
else:
    previous = PRELIMINARY
    singers = previous ScoreSummary.is_advanced
```

。

`reset_round_to_draft()` 甚至：

```python
round_order = {
    PRELIMINARY: 0,
    SEMI_FINAL: 1,
}
```

。

`downstream_rounds()`：

```text
PRELIMINARY → SEMI_FINAL
```

。

---

## 这意味着

Ruleset Engine 已经能表达：

```text
R1
R2
R3
R4
```

。

但是数据库真正准备比赛轮次时：

> 仍然只能理解 PRELIMINARY / SEMI_FINAL。

---

# 二十六、2025 院十佳当前实际无法真正准备四轮

Golden：

```text
能算。
```

真实 DB workflow：

```text
不能准备。
```

。

这是非常重要的区别：

> **单元引擎支持 ≠ ArtFlow 已经支持。**

---

# 二十七、第三个 Integration P0：现在有两套晋级 authority

旧系统：

```text
ScoreSummary.rank
ScoreSummary.is_advanced
```

。

而新系统：

```text
StageDecision
```

。

旧：

```python
prepare_round()
```

仍然消费：

```text
ScoreSummary.is_advanced=True
```

。

新 Ruleset 即使算出：

```text
A 晋级
B 淘汰
```

旧 `ScoreSummary` 完全可能说：

```text
B 晋级
A 淘汰
```

。

然后下一轮：

> 仍然按旧 ScoreSummary 准备 B。

这是绝对不能带进真实比赛的。

---

# 二十八、新 Ruleset 必须成为唯一晋级 authority

至少 M1 正式模式：

```text
StageDecision
↓
下一 RoundEntry snapshot
```

。

而：

```text
ScoreSummary.is_advanced
```

只保留：

* legacy；
* simple screening；
* 兼容旧页面；

不能继续控制通用 Ruleset 的下游 roster。

---

# 二十九、第四个 Integration P0：Rapid Entry 仍然没有使用 checkpoint

这一点之前已经提过，但现在 core 足够成熟，可以正式把它列为下一步。

现在：

```python
round_scores_api()
```

录完一轮：

```python
recompute_activity_result(activity, user)
```

没有：

```text
checkpoint
```

。

---

## 对院十佳完整 graph

R1、R2 完成以后：

你要的是：

```text
Stage1 Top10
READY_TO_CONFIRM
```

。

但是完整 graph 后面还有：

```text
R3
R4
Audience4
```

不存在。

全图 resolve：

```text
HOLD
```

。

---

# 三十、Checkpoint 引擎其实已经做好了，差的是最后的 wiring

需要 Frozen binding 知道：

```text
R2 完成
→ checkpoint stage1

R3 完成
→ checkpoint stage2

R4 + Audience4
→ checkpoint final
```

。

于是：

```text
最后一格 R2 分写入
↓
recompute checkpoint=stage1
↓
READY_TO_CONFIRM
```

。

这才真正解决你们去年：

> “后台算完后立刻填纸质主持手卡”

的事故。

---

# 三十一、第五个 Integration P0：AudienceScore 目前只有测试数据，没有生产事实模型

现在这一点反而已经非常清楚。

Golden Test：

```text
AudienceScore = 86
```

手工 inject。

正式 DB：

```text
只有 Raw VoteRecord
```

。

而现在我们又正确地规定：

> Raw votes 不能自动变 AudienceScore。

所以正式院十佳 30/60/10：

# 还缺一个数据来源。

---

## 最小方案，不用做 VoteScoringRule

直接加：

```text
ExternalScore / AudienceScore
```

例如：

```text
activity
source_key
singer
value
score_max
entered_by
entered_at
is_test_data
```

。

工作人员把现场已经确定的：

```text
观众分
```

人工录进去。

这完全符合去年实际：

> 所有东西本来就是人工收集填写。

未来正式规则明确：

> raw票数怎么换分

再让：

```text
VoteScoringRule
```

自动产生这个事实。

---

# 三十二、第六个 Integration P0：分组数据其实没有被冻结

你现在 `StageResult confirm` 会要求：

```text
Round locked
```

。

然后 `_ensure_stage_dependencies_final()` 注释认为：

> group map 是 round 的 view，所以 Round lock 就覆盖 group。

但实际：

```text
PerformanceGroup
Performance
```

的 model 没有检查：

```text
Round is PREPARED/LOCKED
```

。

---

## 所以可以

```text
Round LOCKED
StageResult CONFIRMED

↓

Performance A
group = 1
改成
group = 2
```

。

而：

```python
_source_group_of()
```

下次会读新 group。

已核定结果所依据的分组事实被改掉了。

---

# 三十三、Performance / PerformanceGroup 必须变成 round snapshot 的一部分

至少这些字段：

```text
Performance.round
Performance.singer
Performance.group

PerformanceGroup.round
PerformanceGroup.name
```

。

Round Prepare 以后：

> 不得随意修改。

需要调整：

```text
先 reset round
```

。

这和 `RoundEntry/RoundJudge` 当前 frozen snapshot 语义完全一致。

---

# 三十四、VoteOption 也存在同样问题

VoteSession：

```text
LOCKED
```

。

但是：

```text
VoteOption
```

没有锁保护。

甚至可以：

```text
delete VoteOption
```

。

因为 VoteRecord：

```text
FK VoteOption CASCADE
```

。

结果：

# 删除候选项会连 VoteRecord 一起删。

即使某个 StageResult 已 CONFIRMED。

这直接破坏：

> 已锁 VoteSession = final raw fact。

---

## 必须保证

VoteSession 非 Draft/已打开/locked 后：

```text
VoteOption candidate set
```

不能任意改。

尤其：

```text
LOCKED
```

以后：

```text
create/update/delete VoteOption
```

全部拒绝。

---

# 三十五、这轮我还抓到两个文档/process 回归

## 1. 根目录 `ChatGPT.md` 又消失了

当前根目录：

```text
AGENTS.md
CLAUDE.md
GOAL.md
```

没有：

```text
ChatGPT.md
```

。

但是 `GOAL.md` 两处明确写：

> 具体实施与审核见 `ChatGPT.md`。

而：

```text
docs/advices/ChatGPT.md
```

有一份。

但它只是很旧的一轮审核：

> M1 5.5～6/10。

没有：

* R5；
* R6；
* R7；
* R8；
* R9；
* 当前审核。

也没有完整的 M1 roadmap。

这和你明确说的：

> ChatGPT.md 用来盛放我每次审核结果

不一致。

### 必须恢复根目录 `ChatGPT.md`

并持续 append。

---

# 三十六、2. CHANGELOG 现在明显夸大 M1 完成状态

当前写：

```text
M1-B → M1-J — shipped
```

甚至：

```text
M1-J
```

已经列成完成。

但你刚刚明确：

> M1 还没做完。

而代码本身也证明：

* explicit finalist roster 未接；
* generic round prepare 未接；
* StageDecision advancement 未接；
* Rapid Entry checkpoint 未接；
* AudienceScore production source 未接。

所以 CHANGELOG 会误导 Claude：

> “M1-J 已经完成，不要动。”

---

## 建议改成

```text
M1-B → M1-I — in progress / partial
```

或者更严格：

只记录：

> 已经通过审核的实际功能。

---

# 三十七、还有几个 P1，但我不想让你们现在继续无限 hardening

记录即可。

### P1-1

`Ruleset schema/editor` 的：

```text
hundred / ten
```

要和 numeric score_max 统一。

### P1-2

Raw Vote：

```text
POPULARITY
SELECTION
```

应该允许。

### P1-3

`FILL_TO_QUOTA global`

最终应：

```text
→ ROSTER
```

而不是硬塞回 GroupMap。

### P1-4

ManualDecision service：

* 要求 current Frozen；
* Audit 保存 old chosen；
* QuerySet guard。

### P1-5

`confirm_stage_result` / `unlock_stage_result` 等新 M1 service 自己也最好验证 Staff/Admin 权限，不只靠 View decorator。

---

# 三十八、我现在不建议再做“R10 Engine Hardening”

这一点很重要。

你已经连续让 DeepSeek修了很多轮 Core。

再继续往：

```text
更完美的 generic typed workflow
```

挖，很容易重新进入我之前担心的：

# architecture hardening addiction。

现在真正该做的是：

> 先把最后几个 authority 漏洞关掉，然后把已经做好的引擎接进真实十佳。

---

# 三十九、我建议下一步拆成三个非常明确的 Batch

## Batch A — `M1-CORE-CLOSE`

只修安全边界，不加业务功能。

### A1

去掉公开：

```text
_allow_freeze
_bypass_confirmed
```

用 internal authorization context。

### A2

封：

```text
StageDecision/CompositeResult create
```

到 CONFIRMED parent。

### A3

封：

```text
ManualDecision QuerySet mutations
```

。

### A4

正式 publication 只允许：

```text
recompute_activity_result()
```

而且强制 Frozen binding。

去掉：

```text
formal round_keys override
```

。

### A5

修三条 migration：

```text
Ruleset duplicate version stable renumber
StageResult duplicate result_version stable renumber
invalid historical CONFIRMED trail demote
```

。

### A6

恢复：

```text
/ChatGPT.md
```

并修 CHANGELOG。

---

# 四十、Batch A 的验收

必须新增这些 regression：

```text
ORM cannot manufacture FROZEN current RulesetVersion
ORM cannot manufacture CONFIRMED StageResult
CONFIRMED StageResult cannot gain StageDecision through .objects.create()
CONFIRMED StageResult cannot gain CompositeResult through .save()
ManualDecision QuerySet.update/delete/bulk_create rejected
formal recompute cannot override frozen round binding
migration duplicate ruleset v1/v1 succeeds deterministically
migration duplicate stage result_version succeeds deterministically
legacy CONFIRMED with null actor migration succeeds safely
```

这些过了：

# 我会正式宣布 `M1 Core CLOSED`。

---

# 四十一、然后立刻 Batch B — `M1-INTEGRATION-1: Roster & Advancement`

这才是现在真正重要的开发。

### B1 Explicit seed roster

不能：

```text
all approved registrations
```

。

必须：

```text
finalist snapshot
```

。

### B2 Generic round prepare

删除 workflow authority：

```text
PRELIMINARY / SEMI_FINAL
```

。

Round 就是：

```text
name
sequence
roster snapshot
```

。

### B3 StageDecision → next RoundEntry

新 Ruleset mode：

# 只有 StageDecision 决定下一轮 roster。

旧：

```text
ScoreSummary.is_advanced
```

只保留 legacy/simple screening。

### B4 Performance/Group snapshot freeze

Round Prepare 后禁止结构性修改。

---

# 四十二、Batch B 的最关键测试

模拟真实情况：

```text
60 approved registrations
↓
初赛
↓
finalist snapshot = 15
```

然后 Final Ruleset：

```text
entry count == 15
```

而不是：

```text
60
```

。

接着：

```text
Stage1 Top10
↓
prepare R3
```

必须：

```text
RoundEntry exactly = 10 StageDecision ADVANCED singers
```

。

绝不能查：

```text
ScoreSummary.is_advanced
```

。

---

# 四十三、再 Batch C — `M1-INTEGRATION-2: Onsite Checkpoint`

这一批做现场闭环。

### C1 Rapid Entry → checkpoint

配置：

```text
R1/R2完成 → stage1
R3完成 → stage2
R4完成 → final
```

。

最后必要一格输入以后：

```text
当前 checkpoint auto-resolve
```

。

---

### C2 Staff AudienceScore

加最小事实模型。

不要做 Vote conversion engine。

支持：

```text
后台工作人员：
陈某 85
李某 91
...
```

。

然后：

```text
30/60/10
```

正常进入 Composite。

---

### C3 Vote POPULARITY / SELECTION

允许：

```text
raw vote count
```

用于：

* 人气奖；
* 复活；
* TopN。

继续禁止：

```text
raw vote count
→ weighted score
```

。

---

### C4 VoteOption snapshot/finality

Vote 开始后候选不可乱改；

locked 后彻底 immutable。

---

# 四十四、这三批结束以后就不要再静态审核了

直接开始：

# **2025 Shadow Rehearsal**

院十佳：

```text
15人
5组×3
5评委
R1
R2
AudienceScore
↓
30/60/10
↓
Top10
```

确认：

```text
最后一格输入
→ READY_TO_CONFIRM
```

。

然后：

```text
lock
→ confirm
→ Backstage Result Board
→ 抄纸手卡
```

。

再继续：

```text
R3
→ 60/40
→ Top5
→ R4
→ 30/50/20
→ Top3
```

。

---

# 四十五、再跑校十佳压力测试

```text
20
↓
5组 Top1 direct
↓
remaining Top12
↓
R2 Top7
↓
merge12
↓
manual 0~2/group
```

直到历史未决 fallback：

```text
20/30/50
```

。

这里系统必须明确：

# INVALID / NEEDS RULE CLARIFICATION

而不是自己给答案。

这正好证明：

> Ruleset Validator 真正发挥了作用。

---

# 四十六、我现在对 M1 的阶段状态会改成这样

| 阶段                            | 当前                                         |
| ----------------------------- | ------------------------------------------ |
| M1-A                          | ✅/基本完成                                     |
| M1-B Domain Model             | 🟡 **模型完成，生产集成未完成**                        |
| M1-C Typed Ruleset            | ✅ Core                                     |
| M1-D Compiler                 | ✅ Core，vote用途仍补                            |
| M1-E Resolver                 | ✅ Core，少量语义债                               |
| M1-F 院十佳 Golden               | ✅ **算法 Golden** / ❌ production integration |
| M1-G 校十佳 Golden               | ✅ historical/control-flow                  |
| M1-H Rapid Entry/Result Board | 🟡 UI 有了，checkpoint/input未闭环               |
| M1-I Templates/Editor         | 🟡 已有，不应继续扩                                |
| M1-J Production Rehearsal     | ❌ 未到条件                                     |
| M1-K Official Rules           | 未开始，正常                                     |

---

# 最终判断

这一包让我反而比较放心的一点是：

> **Ruleset Engine 已经不再是当前最大风险。**

现在的问题非常具体：

```text
Who exactly is in the final?
↓
Which StageDecision creates the next roster?
↓
Which checkpoint should this score entry resolve?
↓
Where does manual AudienceScore come from?
↓
Can group/vote candidate facts change after confirmation?
```

这些才是真实十佳会遇到的问题。

因此下一步不要再让 DeepSeek继续“丰富赛制原语”。

我建议非常严格地：

> **先做 M1-CORE-CLOSE，一次收掉 ORM authority + migration；然后立即转 M1-INTEGRATION-1。**

如果 Batch A 按上面的验收全部通过，我下一轮不会再继续给你 invent 一个 R10/R11。我会直接把：

# **M1 Core 判 CLOSED**

然后我们开始审：

> **这套引擎到底能不能真的把去年十佳从报名名单一路跑到主持人手里的那张纸质手卡。**

这是现在最值得做的事情。
