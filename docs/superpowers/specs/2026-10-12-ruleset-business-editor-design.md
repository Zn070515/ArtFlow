# ArtFlow 赛制编辑与分数换算设计

## 目标

完成赛制编辑审计中 A、B、C 三批改造：

1. 让固定满分比例换算在 Schema、Compiler、Resolver 和冻结快照之间闭环；
2. 让空白赛制可以从名单骨架开始，并以自然语言显示空白、部分填写和完整状态；
3. 让普通工作人员按比赛环节编辑轮次、成绩组成和晋级人数，同时对无法无损表达的复杂旧赛制只读；
4. 保留现有 Django、Ruleset Compiler/Resolver、版本、冻结、绑定、问卷和审计机制。

## 范围与不做事项

- 支持的换算方法只有 `factor`；`minmax` 和 `rank` 继续在编译阶段拒绝。
- 换算发生在 `AGGREGATE` 的权重计算之前，使用 `Decimal`，不使用前端显示值。
- 不新增分数实体、规则图替代模型或前端框架。
- 业务编辑只生成线性“评分 → 综合 → 排名 → 晋级”图；分组、复活、对决、人工选择、分支等复杂图完整阅读但禁止有损编辑。
- 空白创建保留一个合法 `ROSTER` 节点；冻结时拒绝只有名单骨架、没有比赛规则或检查点的版本。

## 换算契约

`AGGREGATE.conversion` 使用下面的规范形态：

```json
{
  "to": 100,
  "conversions": [
    {
      "source": "assess_r1",
      "from": 10,
      "to": 100,
      "method": "factor",
      "factor": 10
    }
  ]
}
```

`to`、每个转换项的 `from`/`to` 和 `factor` 都必须是正数；来源必须是当前 aggregate 的直接 component；转换项必须覆盖所有不同于目标尺度的 component，且不能为同一来源重复声明。目标尺度统一为 `Decimal` 数值，`hundred` 等现有符号只作为兼容的 100 分尺度输入，不能掩盖绑定后的真实满分。Compiler 会同时校验来源实际尺度、声明尺度、目标尺度和 `factor == to / from`，并把转换后的 aggregate 规模写入 `ExecutionPlan`。

### 分数计算

Resolver 对每个 component：

1. 读取原始 `Decimal` 分数；
2. 根据 component source 查找转换项；
3. 对 `factor` 执行 `value * factor`；
4. 再执行权重乘法和合成。

没有明确满分的 raw votes 不能进入固定比例换算；投票仍只能经现有 `VoteScoringRule` 转成支持率后参与成绩。

## 业务编辑数据流

业务编辑器使用 `RulesetVersion.definition.context.business` 保存经过验证的筹备信息。节点、检查点和筹备信息在同一个带 `base_content_hash` 的事务中写入，`questionnaire` 和其他 definition section 原样保留。需要绑定实际轮次时，服务在同一 Activity 锁内更新 `ContestRuleset.round_keys`，只允许创建或修改 `DRAFT` 轮次。

业务阶段包含：轮次标识/名称、评分来源、评委/上一阶段/观众成绩权重和晋级人数。服务从这些阶段生成确定性的 ASSESS、AGGREGATE、RANK、SELECT 节点和 checkpoint。删除中间阶段若会被后续阶段继承则拒绝，并说明受影响的阶段；不自动删除复杂历史节点。

## 阅读与权限

`human_ruleset_summary()` 返回明确的 `state`：`empty`、`partial`、`complete`，以及安全的 `notice`。不能归纳的节点显示“此处有尚不能完整解释的规则”，不根据节点名称猜测含义。普通 Staff 页面隐藏冻结按钮，服务端仍由 `@admin_required` 和冻结服务作最终权限检查。

## 冻结与兼容性

- `freeze_ruleset_version()` 在绑定编译前执行完整性门槛；骨架版本拒绝冻结。
- 已冻结版本不原地修改；绑定、内容哈希、Activity-first 锁、事务和 AuditLog 继续有效。
- 历史无 `context.business` 的线性定义可以被推导成业务阶段；复杂定义仅展示安全阅读结果。
- 所有新增节点都经过现有 `parse_definition()`，所有最终计算都使用现有 `ExecutionPlan`/Resolver。

## 验收

- 10 分制 9 分与 100 分制 86 分各占 50% 得到 88；
- 50 分制与百分制混合且无换算、来源/满分/系数不匹配、raw votes 直接参与均拒绝；
- 换算后的结果可重复计算且精确；
- 新建空白版本只有 `ROSTER`，不能冻结；
- Staff 无冻结按钮，Admin 可以看到并通过完整校验冻结；
- 业务保存保留 checkpoints、questionnaire、context 其他字段；
- 两个 Staff 使用旧 `base_content_hash` 保存时，后者得到版本冲突；
- 复杂历史赛制可读但业务编辑被明确阻止。
