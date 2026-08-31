这版我按“**M1 尚未完成的开发分支**”审，不会把还没做到的 M1-J/K 当缺陷。重点是两件事：

1. 已经做出来的 M1-A～I，方向和语义对不对；
2. 新代码有没有把 M0 好不容易建立起来的权限、事务、生命周期、锁顺序重新打穿。

结论先放前面：

> **M1 推进量很大，但目前不适合继续往模板 UI 和现场彩排扩张。**
>
> 不是因为“M1 没做完”，而是已经实现的 Ruleset/Resolver/H 部分存在几处**核心语义错误 + M0 回归**。
>
> 当前最重要的不是继续加功能，而是先做一次 **M1 Core Correction**。
>
> 我给当前 M1 分支大约 **5.5～6/10 的 M1 完成质量**。
> 上一版稳定的 M0 基线本身仍然不错，但**当前这个 M1 branch 暂时 NO-GO，连正式封闭彩排都建议先缓一下**。

好消息也很明确：**方向没有走歪到需要推倒重来。** `ruleset/`、typed schema、compiler、pure resolver、Golden Test、Rapid Entry、Result Board 的总体路线都是对的。真正要修的是 authority 和 resolver semantics。

---

# 一、这版实际已经做到哪里了

这已经远远不是 M1 刚开工。

新增加了完整的：

```text
ruleset/
├ models.py
├ schema.py
├ compiler.py
├ resolver.py
├ editor.py
├ templates.py
├ services.py
└ 大量 tests
```

同时还增加了：

* `RulesetTemplate`
* `ContestRuleset`
* `RulesetVersion`
* `StageResult`
* `StageDecision`
* `CompositeResult`
* `Performance`
* `PerformanceGroup`
* `ScoringRubric`
* `RubricCriterion`
* `CriterionScore`
* `MaterialSlot`
* Rapid Score Entry
* Backstage Result Board
* 10 类赛制模板
* 2025 院十佳 Golden
* 2025 校十佳屏峰 Golden/validator cases
* ArchivePackage DB constraints
* Excel snapshot fingerprint

代码规模也已经明显增长。

`compileall` 我实际跑过：

```text
python -m compileall -q .
```

**PASS。**

完整动态 suite 我仍然没法在当前沙箱执行：仓库允许 Python 3.13，但离线缓存缺 `Django 6.0.8 / pytest 9.1.1 / psycopg2-binary 2.9.12`，所以 `uv sync --offline` 无法完成。下面不冒充 pytest 已绿。

---

# 二、先说文档：`ChatGPT.md` 丢了

当前仓库根目录：

```text
AGENTS.md
CLAUDE.md
GOAL.md
```

但是：

# **没有 `ChatGPT.md`。**

而新版 `GOAL.md` 已经明确说：

> M1 实施细节、阶段边界、验收和审核结果以 `ChatGPT.md` 为基线。

这不是小文档问题。

这版代码已经明显出现：

> M1-I 编辑器和模板库推进得比 M1-E/F/G 的语义成熟度更快。

这正好就是 `ChatGPT.md` 本来要防止的事情。

### 先把我们上一轮生成的 `ChatGPT.md` 放回仓库。

后续审核结果继续追加，不覆盖旧审核。

---

# 三、当前第一组 P0：M1 把 M0 的 Activity-first 锁顺序重新打穿了

这是我最先要求修的。

---

## P0-1：Freeze 是 `RulesetVersion → Activity`

当前：

`ruleset/services.py`

```python
@transaction.atomic
def freeze_ruleset_version(...):
    locked = (
        RulesetVersion.objects
        .select_for_update()
        ...
        .get(...)
    )

    ...

    lock_activity_for_action(
        locked.ruleset.activity
    )
```

实际锁顺序：

```text
RulesetVersion
→ Activity
```

但 M0 已冻结的 canonical invariant 是：

```text
Activity
→ child aggregate
→ dependent rows
```

RulesetVersion 显然是 Activity-owned child。

### 为什么危险

等你把 Ruleset edit/create 也修成正确的：

```text
Activity → RulesetVersion
```

就会形成：

```text
T1 freeze:
RulesetVersion → wait Activity

T2 edit/supersede:
Activity → wait RulesetVersion
```

标准 deadlock。

### 正确顺序

```text
BEGIN
↓
Activity FOR UPDATE
↓
ContestRuleset FOR UPDATE
↓
RulesetVersion FOR UPDATE
↓
重新验证 Admin / Activity / Version
↓
Compile
↓
Freeze
↓
Audit
COMMIT
```

---

# 四、P0-2：Ruleset 创建、编辑、从模板复制根本没有 Activity authority

例如创建：

```python
activity = get_object_or_404(Activity, ...)

ContestRuleset.objects.create(...)
RulesetVersion.objects.create(...)
```

编辑：

```python
version.definition = ...
version.save()
```

模板复制：

```python
ContestRuleset.objects.get_or_create(...)
ruleset.save()
RulesetVersion.objects.create(...)
```

这些全是：

> Staff 写 Activity-owned state，但不锁 Activity。

因此可以发生：

```text
Staff 开始编辑赛制
         ↓
Admin lock / archive Activity
         ↓
Staff 最后 save RulesetVersion
```

于是：

> Activity 已锁/归档之后，赛制仍发生 mutation。

这就是标准 M0 regression。

### 不要在 View 里一行一行补锁

收成 authoritative services：

```text
create_contest_ruleset(...)
update_ruleset_draft(...)
clone_ruleset_template(...)
create_successor_version(...)
freeze_ruleset_version(...)
```

全部统一：

```text
Activity
→ ContestRuleset
→ RulesetVersion
```

---

# 五、P0-3：Rapid Score Entry 又回到了 `Round → Activity`

这个尤其需要马上修。

现在 API：

```python
with transaction.atomic():
    locked_round = (
        ContestRound.objects
        .select_for_update()
        .get(...)
    )

    ...

    apply_scores(locked_round, ...)
```

但 `apply_scores()` 自己正确地：

```text
Activity
→ ContestRound
```

问题是 caller 已经先锁 Round 了。

实际 transaction 还是：

```text
ContestRound
→ Activity
```

也就是我们 M0-T 当时专门消灭的锁反序重新出现了。

---

## 它为什么会出现

你为了做：

```text
score_version
stale editing protection
```

需要先检查 `base_version`。

这个需求没错。

错的是：

> stale version check 被放在 View 自己的 Round transaction 里。

正确做法是做：

```python
apply_scores_if_version(
    round_id,
    base_version,
    score_values,
    actor,
)
```

service 自己：

```text
BEGIN
↓
Activity FOR UPDATE
↓
Round FOR UPDATE
↓
compare score_version
↓
apply
↓
increment score_version
↓
COMMIT
```

View 不拥有任何 row lock。

---

# 六、P0-4：TEST → FORMAL 完全不知道新 M1 数据

这个很严重，而且很容易因为目前都在 unit test 中没暴露。

当前：

```python
clear_activity_test_data()
```

仍然只处理旧模型。

它不知道：

```text
ContestRuleset
RulesetVersion
StageResult
StageDecision
CompositeResult
Performance
PerformanceGroup
ScoringRubric
RubricCriterion
CriterionScore
MaterialSlot
```

---

## 可以产生什么

TEST Activity：

```text
Activity lifecycle = TEST

ContestRuleset.is_test_data = True

StageResult.is_test_data = True
```

执行：

```text
clear test
→ leave_test_mode
```

Activity 变成：

```text
FORMAL
```

但 ContestRuleset 仍：

```text
is_test_data=True
```

现在它自己的 `clean()` 都已经认为：

> marker 与 Activity lifecycle 不匹配。

StageResult 也可能继续留着。

结果板又没有严格 runtime scope 的话，就可能把：

> TEST 彩排结果

带到 FORMAL 世界。

---

# 七、这里不能简单“所有 M1 数据全部删除”

需要先分类。

### Runtime facts：清除

例如：

```text
StageResult
StageDecision
CompositeResult
CriterionScore test results
test Performance runtime data
```

### Config：通常保留

GOAL 明确：

> Test rehearsal 后保留配置/草稿。

例如：

```text
ScoringRubric
RubricCriterion
Ruleset Draft
MaterialSlot definition
Round configuration
```

这类应该：

> retain / promote lifecycle

而不是删掉。

所以 M1 必须重新定义：

# **每一个新 model 是 runtime fact，还是 retained configuration。**

然后扩展：

```text
get_test_data_counts()
clear_activity_test_data()
leave_test_mode()
mixed-marker guard
```

并做完整 M1 TEST→FORMAL regression。

---

# 八、M1 本身最大的结构性问题：Frozen Ruleset 其实没有真正 Freeze

这个比单个 bug 更重要。

现在冻结的是：

```text
RulesetVersion.definition
RulesetVersion.content_hash
RulesetVersion.execution_plan
```

但真正生产 runtime 又依赖：

```python
ContestRuleset.stage_key
ContestRuleset.round_keys
ContestRuleset.announcement_blocks
```

而这些字段：

# **在 RulesetVersion 外面。**

---

## 这意味着什么

假设：

```text
RulesetVersion v4
definition frozen
content_hash = ABC
```

绑定：

```text
r1 → ContestRound #12
r2 → ContestRound #13
```

Freeze 后。

如果有人/以后某段代码改：

```text
r1 → ContestRound #19
```

Ruleset Version：

```text
仍然 v4
仍然 hash ABC
```

但是 Resolver 算的是另一场比赛。

所以现在：

> `Frozen RulesetVersion` 不能独立重现当时结果。

这违反了新版 GOAL 最关键的一条：

> 要能回答“按哪一版规则、绑定哪些正式事实算出来”。

---

# 九、Freeze 必须冻结“定义 + binding snapshot”

建议 Frozen Version 至少固化：

```text
definition
stage/checkpoint definitions
round bindings
vote bindings
vote purposes
group source bindings
critical announcement binding
schema version
```

最终 hash：

```text
SHA256(
    canonical definition
    +
    canonical binding snapshot
)
```

`ContestRuleset.round_keys` 可以继续作为：

> Draft 编辑方便字段。

但正式 runtime：

# **只读 Frozen Version snapshot。**

不能再读 mutable ContestRuleset binding。

---

# 十、另一个 authority bug：`run_ruleset()` 可以直接跑 DRAFT Version

当前：

```python
def run_ruleset(version, activity, ...):
    ...
    result = resolve(version.definition, ...)
    return persist_stage_result(...)
```

没有：

```text
version.status == FROZEN
```

防御。

Golden DB tests 甚至直接拿 DRAFT Version 跑。

对于纯 preview：

> 跑 Draft 完全合理。

但 preview 应调用：

```text
resolve()
```

不能调用：

> 正式持久化 runtime result service。

所以应明确分开：

```text
preview_ruleset(...)
```

可以 Draft，不持久化正式 StageResult。

```text
run_frozen_ruleset(...)
```

只接受 Frozen。

---

# 十一、当前最严重的 Resolver 设计问题：你现在实际上只有“整场比赛一个 Stage”

这个会直接卡现场。

拿 2025 院十佳举例。

当前 Golden graph：

```text
R1
R2
↓
Stage1
↓
Top10

R3
↓
Stage2
↓
Top5

R4
↓
Final
↓
Top3
```

全部在：

# **一个 Ruleset graph**

里。

这看着很漂亮。

但现场第一阶段结束时：

```text
R1 已有
R2 已有
Audience1 已有
```

这时候后台要马上拿：

> Top10

填手卡。

但是：

```text
R3
R4
Audience4
```

显然还不存在。

当前 resolver 会继续遍历整个 graph。

所以后面：

```text
ASSESS R3
```

缺输入：

→ HOLD。

最终整场 result：

# HOLD

---

# 十二、因此“未来轮次没发生”会阻止当前阶段 READY

这和真实现场完全相反。

真实需要：

```text
Checkpoint Stage1
依赖：
R1
R2
Audience1

READY
↓
抄 Top10 手卡
↓
锁 Stage1
↓
继续 R3
```

不是：

> 等 R4 都结束才能说第一阶段 READY。

---

# 十三、需要正式引入 `Checkpoint / Stage Output`

Ruleset graph 可以继续是一张总图。

但是必须声明：

```text
checkpoint: stage1
output: top10

checkpoint: stage2
output: top5

checkpoint: final
output: top3
```

Resolver 运行：

```python
resolve_to_checkpoint(
    version,
    checkpoint="stage1"
)
```

只求：

> `top10` 的 dependency closure。

后面的 R3/R4：

> 完全不执行。

这样：

```text
Stage1 READY
```

不受未来比赛影响。

---

# 十四、当前 `StageDecision` 还有一个更明显的问题：第一次被选中以后就不再更新 outcome

Resolver 中很多地方都是：

```python
if c not in st.outcome:
    st.outcome[c] = OutcomeCode.DIRECT
```

于是院十佳：

### Top10

```text
c1~c10 → DIRECT
```

到了：

### Top5

这 5 人已经有 outcome。

不会更新。

到了：

### Top3

更不会更新。

最终整场 graph 的 `StageDecision` 很可能仍然告诉你：

```text
c1~c10 = DIRECT
```

而不是：

```text
这个 checkpoint 的 top3 是谁
```

当前 Golden tests 某些地方甚至把这种行为写进 assertion 保护了。

这证明：

> Resolver 现在是在给“整条图上的第一次选择事件”贴标签，

而不是：

> 表达某一个可宣布阶段的正式结果。

---

# 十五、这个必须在 M1-E 层纠正，不要用 Result Board 补

正确模型应该是：

```text
Checkpoint Stage1
StageResult #1
→ StageDecision 15 rows
→ top10 / eliminated

Checkpoint Stage2
StageResult #2
→ StageDecision 10 rows
→ top5 / eliminated

Checkpoint Final
StageResult #3
→ StageDecision 5 rows
→ champion/top3/etc
```

每个 StageResult：

> 自己有完整、明确、独立的业务输出。

---

# 十六、当前 `StageResult` 版本机制也会在第二次算分时炸

现在：

```python
UniqueConstraint(
    fields=[
        "activity",
        "stage_key",
        "content_hash",
    ]
)
```

问题是 Resolver 的：

```text
content_hash
```

实际上来自：

> Ruleset/ExecutionPlan hash。

不是：

> raw input hash。

---

## 场景

第一次录完分：

```text
Ruleset v4 hash ABC

scores version 1
↓
StageResult(
 stage=第一阶段,
 content_hash=ABC
)
```

后来发现评委4的一格录错：

```text
改 Score
↓
自动 recompute
```

Ruleset 没变：

```text
hash 还是 ABC
```

于是又试图创建：

```text
Activity
+ same stage
+ same ABC
```

直接撞 UniqueConstraint。

而：

```text
result_version
```

当前又固定：

```text
1
```

所以它没有真正版本化结果。

---

# 十七、Rapid Entry 自动 recompute 会把这个问题变成现场 500

`round_scores_api`：

```python
apply_scores(...)
...
recompute_activity_result(...)
```

recompute 对一些 ValidationError 有 catch。

但这种：

```text
IntegrityError
```

并不会按预期变成正常 conflict。

甚至可能导致整个 score correction transaction rollback。

所以这是实际现场 blocker。

---

# 十八、结果 identity 要拆成三个概念

不要继续一个 `content_hash` 什么都干。

至少：

### `ruleset_hash`

哪版正式规则。

### `input_fingerprint`

这次 Resolver 消费的原始事实快照。

例如包含：

```text
round score versions
vote result versions
manual decision versions
roster snapshot IDs
```

### `result_version`

同一 checkpoint 的第几次计算/核定。

---

## 理想语义

同一个：

```text
ruleset_hash
+
input_fingerprint
```

重复计算：

> idempotent，复用同结果。

输入变化：

> 新 StageResult version。

---

# 十九、当前最大的校十佳语义错误：`FILL_TO_QUOTA` 实现错了

这个一定要重新设计。

当前 `_fill()`：

```python
into = manual group map
pool = roster
quota = 2

for each group:
    need = quota - len(group selected)
    从 pool 顺序依次塞进这个组
```

它实际表达：

> **把每组补到2人。**

但 2025 校十佳规则是：

> 各组人工直通 0～2 人；
> 如果**全场总数**不足 6 人，就按综合成绩从剩余人中全局补到 6。

这不是同一个规则。

---

# 二十、举一个能直接看出错误的例子

第三轮人工选择：

```text
第一组：2人
第二组：2人
第三组：0人
```

当前人数：

```text
4
```

真正历史规则：

```text
需要再补2人
↓
全局剩余候选
↓
按 fallback ranking
↓
最高2人
```

这两个人完全可能：

```text
都来自第一组
```

因为赛制没有说：

> 每组最后必须2人。

但当前 `_fill()`：

```text
第一组已经2 → 不补
第二组已经2 → 不补
第三组0 → 强行给第三组补2
```

直接改变比赛规则。

---

# 二十一、更严重的是：当前 `FILL_TO_QUOTA` 根本没有 ranking source

当前：

```python
pool_iter = list(pool)
```

然后：

```python
nxt = pool_iter.pop(0)
```

也就是：

> roster 顺序谁靠前就补谁。

不是：

```text
R1 20%
R2 30%
R3 50%
```

也不是任何 ranking。

所以现在这个 primitive 不能用于你们去年那种：

> “按分数补足”。

---

# 二十二、`FILL_TO_QUOTA` 应改成全局语义

至少：

```text
selected_source
candidate_pool
ranking_source
target_total
exclude_selected = true
```

算法：

```text
current = selected count

need = target_total - current

remaining =
candidate_pool
- selected

ranked_remaining =
remaining ordered by ranking_source

take top need
```

如果未来真的遇到：

> 每组必须补够2人

另做：

```text
FILL_EACH_GROUP_TO_QUOTA
```

或者 mode。

不要把两种完全不同的业务语义塞一个 primitive。

---

# 二十三、当前所谓“2025 校十佳屏峰 Golden”不能叫 Golden

现在：

```python
golden_xiaofeng()
```

包含：

```text
R1
5组直通
剩余Top12
R2 Top7
Merge
3组 manual 0~2
FILL each group to 2
```

但：

* 没有 R3 分；
* 没有 20/30/50 fallback；
* fill 不是历史算法；
* fill 是 roster order。

与此同时 Compiler test 反而已经正确写了：

> 原始历史 fallback 因 direct 选手缺 R2，应 `MISSING_SCORE_DEPENDENCY`。

这个 Compiler test 是好的。

问题是你随后又创造了一条：

> “看起来像历史赛制，但其实改了规则”

的 valid Golden。

这违反我们最开始立的原则：

> 历史资料有歧义时不能偷偷补答案。

---

# 二十四、应该拆成三份

### 1. `historical_xiaofeng_control_flow`

只表示确定事实：

```text
5组直通
remainder top12
R2 top7
merge12
manual 0..2/group
```

### 2. `historical_xiaofeng_fallback_unresolved`

原样表达：

```text
R1 20 + R2 30 + R3 50
```

然后：

# validator 必须 FAIL

原因：

> direct path 无 R2。

### 3. `synthetic_fill_to_quota_demo`

如果为了测试 resolver：

> 自己造一套明确、无歧义、合法的 fallback。

但名字一定写：

```text
synthetic
```

不能叫：

> 2025 校十佳 Golden。

---

# 二十五、`MANUAL_SELECT` 现在也没有执行自己的规则

Schema 有：

```text
quota = 2
```

但 Resolver：

```python
chosen = tuple(
    c
    for c in decisions.get(g, ())
    if c in pool_set
)
```

并没有验证：

```text
chosen count <= quota
```

所以：

> 一组允许 0～2，

API input 给：

```text
4人
```

Resolver照收。

---

# 二十六、还有一个更隐蔽的问题：可以把别组的人选进当前组

当前 grouped manual：

```python
pool_set =
所有组成员的 union
```

之后 Group A 的 chosen 只检查：

```text
c in pool_set
```

不是：

```text
c in Group A
```

所以可以：

```text
在第一组 manual decision
选择第三组选手
```

照样通过。

必须 runtime enforce：

```text
chosen ⊆ src[group]
len(chosen) <= quota
group key 合法
同一 singer 不能多组重复
```

这是 P0 级 resolver correctness。

---

# 二十七、Compiler 现在允许冻结 Resolver 根本不会执行的节点

Schema 有：

```text
BRANCH
AWARD
```

Compiler 也能识别。

但是 Resolver 明确：

```python
elif ntype in ("BRANCH", "AWARD"):
    raise UnsupportedNodeError(...)
```

结果：

```text
Editor
→ 可以添加 BRANCH/AWARD

Validate
→ 可以 PASS

Freeze
→ 可以成功

现场 Run
→ UnsupportedNodeError
```

这是最不能接受的状态：

# **Compiler 说可执行，Runtime 说不会。**

---

# 二十八、必须有 Runtime Capability Matrix

例如：

```text
plan_version = 1

supported runtime nodes:
ROSTER
PARTITION
PAIR
ASSESS
AGGREGATE
RANK
SELECT
SUBTRACT
MERGE
FILL_TO_QUOTA
MANUAL_SELECT
```

当前没实现的：

```text
BRANCH
AWARD
```

Compiler：

```text
ERROR:
NODE_UNSUPPORTED_RUNTIME
```

不允许 Freeze。

Editor 也先隐藏。

等 resolver 真实现了再开放。

---

# 二十九、Scale Conversion 现在更危险：Compiler 认为支持，Resolver完全忽略

Schema 支持：

```text
conversion
factor
minmax
rank
```

Compiler：

> 有 conversion 就不报 SCALE_MIXED。

但 `_aggregate()`：

```python
value = w * v
```

没有任何 conversion。

因此你可以冻结：

```text
100分制 judge score
+
10分制 audience score
```

并声明 conversion。

Compiler：

> PASS。

Resolver：

> 直接 70%×90 + 30%×8。

数学结果当然错。

这比“不支持”更危险，因为它会**静默给出错误成绩**。

---

# 三十、这一阶段建议二选一

### A. 现在完整实现 conversion

并且有 Golden Test。

或者更安全：

### B. M1 当前先禁止 conversion

Compiler：

```text
CONVERSION_UNSUPPORTED
ERROR
```

直到 M1 真实现。

我倾向 **B**。

别为了模板丰富度提前开放半成品。

---

# 三十一、Tie 配置也存在“看着支持，其实没实现”

当前：

```text
auto_break
extra_round
manual
score_fallback
```

但：

* schema 并没有完整字段去表达 extra_round/fallback；
* resolver 没有完整 tie resolution input path；
* `manual` 主要只是把状态置 REVIEW。

所以这里也应该收缩能力。

第一版最稳：

```text
auto_break
manual_review
```

其中 `manual_review` 必须真有：

```text
ManualDecision
→ resolve again
```

的闭环。

后续真实规则需要：

```text
extra_round
```

再实现 typed primitive。

---

# 三十二、M1-H 还有一个生产集成缺口：Golden Test 能跑，不代表数据库里能跑

`bind_resolve_input()` 支持：

```text
vote_scores
group_of
manual
```

但是：

```python
recompute_activity_result()
```

现在只绑定：

```text
round_keys
```

没有从 DB 获取：

* PerformanceGroup/group assignment；
* VoteSession result；
* normalized AudienceScore；
* ManualDecision。

也就是说：

### Unit Golden Test

可以：

```python
ResolveInput(
    group_of={...},
    manual={...},
    vote_scores={...}
)
```

手工塞进去。

### 真正后台 Rapid Entry

```python
recompute_activity_result(...)
```

没有这些输入。

所以：

> 院十佳 30/60/10 的 vote component；

> 校十佳分组/manual；

目前**并没有真正串到生产 UI**。

这个属于“尚未完成”，不是回归。

但因此 M1-E/G/H 绝对不能判 Complete。

---

# 三十三、M1-B 也是明显“模型先立了，业务还没迁过去”

现在已经有：

```text
ScoringRubric
RubricCriterion
CriterionScore
PerformanceGroup
Performance
MaterialSlot
```

这很好。

但我全仓扫 usages 后，基本仍处于：

> model + migration + tests。

真正生产：

* Round create 仍主要围绕 legacy `round_type/scoring_mode`；
* 评分 UI 仍录总 ScoreRecord；
* `CriterionScore` 没进入 workflow；
* `Performance` 没成为歌曲 authority；
* grid 仍在使用 SingerRegistration.song_name；
* `MaterialSlot` 还没成为 SubmissionFile uniqueness authority。

所以：

# M1-B = PARTIAL

这正常。

不要为了“阶段已做完”强行删 legacy。

---

# 三十四、Excel stale protection 有进展，但现在有一个 fail-open

现在已经有：

```text
ArtFlowMeta
schema_version
activity_id
round_id
entry_ids
judge_ids
snapshot_fingerprint
```

导出方向很好。

问题在 import：

```python
meta = _read_artflow_meta(workbook)

if meta.get("round_id"):
    modern parser
else:
    legacy name parser
```

所以如果 workbook 明明有：

```text
ArtFlowMeta
```

但：

```text
round_id 缺失
```

它不是：

> “metadata damaged → reject”。

而是：

# **降级成 legacy 姓名模式。**

同样，很多 metadata 都是：

```python
if meta.get(...)
```

才检查。

---

# 三十五、正确语义应该是

### 完全没有 `ArtFlowMeta`

如果还决定保留 legacy：

```text
显式 Legacy Import
```

可以。

### 存在 `ArtFlowMeta`

那么必须全部要求：

```text
schema_version
activity_id
round_id
entry_ids
judge_ids
snapshot_fingerprint
```

缺一个：

# reject。

不能 fail-open downgrade。

---

# 三十六、还有一个概念问题：`READY` 现在同时代表“算完了”和“正式锁了”

`StageResult.Status.READY` 中文：

```text
可发布
```

但 QuerySet 又写：

> READY stage decisions are immutable。

resolver：

> 一旦输入完整就自动 READY。

于是三个不同事实混成一个：

```text
系统已经算出来
工作人员已经核对
结果已经锁定，可以抄主持手卡
```

但真实现场这三个不是一个动作。

---

# 三十七、尤其你们纸质手卡场景，应该很明确

### 1. Resolver readiness

```text
HOLD
REVIEW
READY_TO_CONFIRM
```

表示：

> 机器算完了。

### 2. Result finalization

工作人员确认：

```text
[核定并锁定]
```

### 3. Handcard

只有正式 finalized 后：

```text
READY / 可抄卡
```

不然会发生：

```text
机器算完 Top10
↓
后台的人开始抄
↓
另一个 Staff 改一格分数
↓
结果重新变化
```

这个是现场层面不能接受的。

---

# 三十八、Ruleset Freeze 目前还有一个“只编译 definition、不编译真实绑定”的问题

Freeze：

```python
compile_version(locked)
```

Compiler 能接 context。

但正式 freeze 没把实际：

* round binding；
* judge count；
* vote binding；
* entry size；

带进去。

因此有些东西 Compiler 只能：

```text
WARN:
无法校验 judge_count
```

但随后：

> Freeze 还是成功。

这和：

> Template 校验

可以接受。

但对：

# **Activity 实例正式 Freeze**

不应该。

---

# 三十九、应该分两个编译层级

### Template compile

允许：

```text
WARN: judge count not bound
WARN: vote not bound
```

因为模板天然没真实实体。

### Bound Contest Ruleset freeze

必须：

```text
definition
+
actual bindings
+
actual Round config
+
Judge count
+
Vote purpose/config
+
roster constraints
```

全部 compile。

需要的信息缺失：

# ERROR

不能 Freeze。

---

# 四十、模板库现在也做得太早，里面已经出现语义名不副实

例如：

```text
Seeded PK + Wildcard
```

模板虽然创建了：

```text
PAIR
```

但之后 `ASSESS` 还是直接对整个 seed roster。

没有：

> pair winner。

最后只是全局 Top4。

所以它不是真 PK。

---

`Direct Bye + Middle PK`

也没有真正的：

> Pair → pair winner。

只是：

```text
direct top5
remaining global rank
top4
merge
```

也不是真 PK。

---

`Independent Popularity Award`

当前：

```text
Vote assess
→ rank
→ select1
```

而 SELECT 默认 outcome 还是：

```text
DIRECT
```

并没有产生：

```text
Award
```

所以也不是真“人气奖 workflow”。

---

# 四十一、因此 M1-I 现在应该暂停

这些模板可以留在开发分支。

但不要继续扩充数量和前端。

先把：

```text
Compiler
Resolver
Checkpoint
Fill
Manual
Tie
Award
Pair semantics
```

打对。

否则继续做 UI，最后只是：

> 给错误语义穿漂亮衣服。

---

# 四十二、我对当前各阶段的正式判定

| 阶段           | 当前状态                          | 评价                                                                                  |
| ------------ | ----------------------------- | ----------------------------------------------------------------------------------- |
| **M1-A**     | **PARTIAL**                   | Archive DB constraint 做得好；Excel fingerprint 有了但 importer fail-open；fixture/文档基线还不完整 |
| **M1-B**     | **PARTIAL**                   | Generic models 基本建立，但生产业务尚未迁入                                                       |
| **M1-C**     | **PARTIAL**                   | Typed/versioned schema 方向正确；关键 binding 不在 frozen version                            |
| **M1-D**     | **PARTIAL / BLOCKED**         | Compiler 很有价值，但能 Freeze runtime 不支持的节点；bound compile 不完整                            |
| **M1-E**     | **BLOCKED**                   | Resolver纯函数方向好，但 checkpoint/result identity/fill/manual/tie 语义有核心错误                 |
| **M1-F 院十佳** | **PARTIAL**                   | 30/60/10、60/40、30/50/20 数据化正确；但无法逐阶段现场 READY                                        |
| **M1-G 校十佳** | **FAIL as historical Golden** | 稳定控制流能表达，但 fallback 被改成错误的 per-group roster-order fill                              |
| **M1-H**     | **PARTIAL**                   | Rapid Entry/Result Board 产品方向对；事务锁序回归、recompute/result-version 有问题                  |
| **M1-I**     | **TOO EARLY**                 | 编辑器/模板已有，但核心语义没成熟，不应继续扩                                                             |
| **M1-J**     | 未开始                           | 正常                                                                                  |
| **M1-K**     | 未开始                           | 正常                                                                                  |

---

# 四十三、这版做得好的地方也要明确保留

不要让 Claude/DeepSeek因为这份审核又全部推倒。

### 1. Typed schema 方向正确

没有搞：

```text
任意 Python
任意公式表达式
```

这是对的。

---

### 2. Compiler 有真正价值

已经有：

```text
ValidationReport
ExecutionPlan
weight
scale
judge count
quota
tie
vote
score dependency
```

尤其：

> 校十佳 direct path 缺 R2 → MISSING_SCORE_DEPENDENCY

这个测试是非常好的。

不要删。

---

### 3. Resolver 是 pure / deterministic

基本：

* 不读 DB；
* 不用 clock；
* 不 random；
* Decimal；
* same input → same output。

这个架构一定保留。

---

### 4. 2025 院十佳公式没有写进 Python 特判

而是模板数据：

```text
30/60/10
60/40
30/50/20
```

这是正确方向。

---

### 5. 校十佳前半段控制流已经证明原语思路可行

```text
group direct
subtract
top12
R2 top7
merge12
```

这些用通用 primitive 表达得出来。

说明整体方案不用推翻。

---

### 6. Rapid Entry `score_version` 思路是好的

问题只是事务 ownership。

不要删除 stale edit protection。

---

### 7. Result Board 符合真实纸质手卡流程

后台：

```text
HOLD / REVIEW / READY
```

* 按 announcement block 大字名单，

非常契合实际工作。

修“READY 何时才算正式”即可。

---

# 四十四、下一步我不建议继续“按 M1-I 往后开发”

我建议插入四个纠偏批次。

不是重启 M1。

是：

# **M1-R0 ～ M1-R4**

把地基纠正之后，再回 M1-H/I。

---

## M1-R0 — Restore M0 Boundaries

只修基础 authority。

### 必须解决

* Ruleset create/edit/clone/freeze：
  `Activity → Ruleset → Version`
* Rapid Score：
  `Activity → Round`
* M1 TEST/FORMAL cleanup；
* `ChatGPT.md` 回仓库。

### 必须有 PostgreSQL 测试

```text
Activity lock vs ruleset edit
Activity archive vs ruleset clone
Freeze vs ruleset edit
Activity lock vs rapid score
TEST M1 data → clear → FORMAL
```

目标：

> M1 不再破坏 M0。

---

# 四十五、M1-R1 — Frozen Ruleset Authority

### 做：

Frozen Version 持有完整：

```text
definition
binding snapshot
hash
```

runtime 不再读取 mutable：

```text
ContestRuleset.round_keys
stage_key
...
```

同时：

* `run_ruleset()` 拒绝 Draft；
* preview 与 formal run 分开；
  -正式 Freeze 用 bound compiler；
* 补 successor/supersede version service；
* clone existing ruleset 不撞 one-current constraint；
* Ruleset 只能绑定 Singer Contest Activity。

---

# 四十六、M1-R2 — Checkpoint & Result Version Semantics

这是最关键的一批。

### 增加：

```text
Checkpoint / Stage output
```

例如：

```text
stage1 → top10
stage2 → top5
final → top3
```

Resolver：

```text
resolve_to_checkpoint()
```

只执行 dependency closure。

### StageResult：

拆：

```text
ruleset_hash
input_fingerprint
result_version
```

同输入：

> idempotent。

输入变化：

> new result version。

### 结果状态：

```text
HOLD
REVIEW
READY_TO_CONFIRM
```

然后：

```text
CONFIRMED / LOCKED
```

之后 Result Board 才：

> 可抄手卡。

---

# 四十七、M1-R3 — Resolver Semantic Correction

集中修：

### FILL_TO_QUOTA

全局：

```text
selected_source
candidate_pool
ranking_source
target_total
```

不要按组硬补。

### MANUAL_SELECT

严格：

```text
group membership
min/max
quota
no duplicate
valid groups
```

### Unsupported nodes

Compiler 不允许 Freeze：

```text
BRANCH
AWARD
```

直到 runtime 实现。

### Conversion

要么实现；

要么当前 Compiler ERROR。

### Tie

只暴露真正闭环的策略。

---

# 四十八、M1-R4 — Golden Correction

### 院十佳

要验证：

```text
只有 R1/R2/Audience1
```

时：

```text
Stage1 READY
```

不能因为 R3/R4 未发生 HOLD。

然后 Stage2/Final 各自独立。

---

### 校十佳

拆：

```text
historical stable control flow
```

和：

```text
historical unresolved fallback
```

原始 20/30/50 缺依赖：

> Validator FAIL。

不要假装历史已经有答案。

另造 synthetic valid fill ruleset 专门测：

```text
global ranked FillToQuota
```

---

# 四十九、R0～R4 完成以后再回 M1-H/I

那时候：

Rapid Entry：

```text
输入 raw facts
↓
checkpoint recompute
↓
READY_TO_CONFIRM
↓
核定
↓
READY FOR HANDCARD
```

这条链才真正有意义。

然后模板 UI 才值得继续。

---

# 五十、我建议当前暂停的内容

暂时不要继续：

* 增加更多模板；
* 做更漂亮的拖拽；
* 新增高级赛制；
* 扩写 BRANCH/AWARD UI；
* 多做 Result Board 美化；
* 开始 M1-J 现场彩排。

先把 core semantics 修掉。

否则每扩一个 UI，就多一个以后要迁的地方。

---

## 当前整体判断

上一轮 M0 稳定版我大约给了 **8.7/10 的基础生产成熟度**。

这版并不是“退步到 6 分的 ArtFlow”。

更准确地说：

> **M0 的成熟地基上正在盖 M1，但新楼层有几根梁还没接到地基上。**

M1 的架构方向大体正确，甚至进度比我预期快：

* Ruleset；
* compiler；
* resolver；
* Golden test；
* Rapid Entry；
* Result Board；

都已经成形。

但现在正好是最危险的时期：

> “看起来已经能跑复杂赛制”，但若立刻进入现场测试，很容易把**语义上错误的结果当成正确结果**。

尤其我现在最不允许放过的是四件事：

1. **M1 新写操作必须重新服从 Activity authority；**
2. **一个完整赛制必须能按阶段 checkpoint 单独 READY；**
3. **历史校十佳的补位规则不能被错误的 per-group roster-order fill 代替；**
4. **Frozen Ruleset 必须真正冻结所有影响结果的 binding，而不只是 JSON definition。**

把这四个核心纠正，我认为 M1 会一下从“功能很多但还不可信”进入真正可继续开发的状态。

**当前 verdict：M1 substantial progress，核心纠偏前 NO-GO；建议下一步只做 M1-R0，不继续往 M1-I/J 扩。**
