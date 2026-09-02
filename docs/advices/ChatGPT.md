按你这份 **`ArtFlow-main(20260902-120457).zip`** 的最新状态，**不要机械地理解成“现在开始做 M1-I，然后做 M1-J”**。仓库里的旧 `GOAL.md` 还是原始编号，但最新审核已经把实际开发顺序纠正了。

原始定义确实是：

* **M1-I — Template Library & Ruleset Editor**

  * 赛制模板库
  * 从模板/去年赛制克隆
  * 可视化表单编辑规则节点
  * Validate
  * Preview
  * Freeze
* **M1-J — Production Rehearsal / DR / Operations**

  * 正式彩排
  * Excel fallback / workbook snapshot
  * backup/restore
  * 服务重启
  * 现场 SLO
  * 生产运维和灾备

但这两个阶段现在的真实状态已经变了。

### M1-I：主体其实已经做了，下一步**不是继续扩编辑器**

当前包已经有：

`ruleset/templates.py`、`ruleset/editor.py`、模板 seeder、Ruleset Editor、Validate/Preview/Freeze、Clone Last Year / instantiate template 等东西。

所以我在这版审核里已经把它判成：

> **M1-I 🟡 已有，不应继续扩。**

也就是说，现在不要再去做拖拽画布、更复杂的节点编辑体验、更漂亮的规则设计器之类东西。那些东西对 11 月院十佳能否稳定跑起来没有当前价值。

### M1-J：现在**还不能正式开始**

原因很简单：目前缺的不是“灾备按钮”，而是**生产链路本身还没闭环**。

你现在真正应该按下面顺序推进：

```text
M1-CORE-CLOSE
        ↓
M1-INTEGRATION-1
Roster & Advancement
        ↓
M1-INTEGRATION-2
Onsite Checkpoint
        ↓
2025 院十佳 Shadow Rehearsal
        ↓
2025 校十佳压力测试
        ↓
M1-J Production Rehearsal / DR / Operations
```

其中下一步最直接的是 **M1-CORE-CLOSE**。它只干一次，把核心权威边界彻底封死，包括 ORM 不能绕过服务直接制造 FROZEN Ruleset、不能直接制造/篡改 CONFIRMED StageResult、formal recompute 必须绑定 frozen round，以及几条历史 migration 修复。**这批验收过了，我会把 M1 Core 正式判 CLOSED。**

然后马上进入真正重要的 **M1-INTEGRATION-1: Roster & Advancement**：

```text
报名 60 人
↓
初赛
↓
决赛名单 snapshot = 15 人
↓
Final Ruleset 的 entry 必须只有这 15 人
```

以及：

```text
Stage1 Top10
↓
StageDecision
↓
自动生成下一 Round 的 RoundEntry = 10 人
```

这里必须做到：

> **下一轮名单由 StageDecision 决定，而不是继续偷偷依赖旧 `ScoreSummary.is_advanced`。**

再下一批是 **M1-INTEGRATION-2: Onsite Checkpoint**。这批才真正把 M1-H 补完整：

```text
R1/R2 输入完成
→ 自动 resolve stage1

R3 输入完成
→ 自动 resolve stage2

R4 输入完成
→ 自动 resolve final
```

同时补上最小的 **Staff AudienceScore**，这样去年院十佳真正用过的：

```text
评委分 + 观众分
30 / 60 / 10
```

才能从真实数据库输入一路进入 Composite，而不是只存在 Golden Test 里。

还要收掉 Vote 的边界：原始票数可以做 `POPULARITY / SELECTION / TopN / 复活`，但在没有明确换算规则时，**绝不能擅自把 raw vote count 转成 weighted score**。

等这两批 integration 做完，才真正开始你可以称为 **M1-J 前半段核心验收** 的东西——**2025 Shadow Rehearsal**：

```text
15 人
5组×3
5评委
R1 + R2 + AudienceScore
↓
30/60/10
↓
Top10
↓
确认
↓
Result Board
↓
工作人员抄纸质主持手卡
↓
R3
↓
60/40
↓
Top5
↓
R4
↓
30/50/20
↓
Top3
```

最重要的验收不是“测试绿了”，而是：

> **最后一格必要分数录入后 → 自动变成 READY_TO_CONFIRM → 核定/锁定 → 后台结果板 → 主持人纸质手卡。**

然后再拿 2025 校十佳那种复杂控制流做压力测试，故意走到历史资料无法确定规则的位置。系统应给出：

```text
INVALID / NEEDS RULE CLARIFICATION
```

而不是 AI/代码自己脑补一个答案。

所以，你问“下一步的 M1-I/J 是什么”，我现在会重新概括成一句：

> **M1-I 功能主体已经够了，冻结功能扩张；M1-J 暂不开工。下一步先 Core Close，然后补 Roster/Advancement 和 Onsite Checkpoint 两个生产集成缺口，之后直接拿 2025 院十佳做全链路 Shadow Rehearsal。**

这也是这份包里目前最重要的结论：**Ruleset Engine 已经不是最大风险，真正的风险已经转移到“真实参赛名单 → 下一轮名单 → 现场输入 → checkpoint → 主持手卡”这一整条生产链。**
