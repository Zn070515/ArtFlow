# Grouping / Group Chorus

## 目的

把外部抽签得到的分组结果变成可审计、可冻结的领域事实：谁和谁一组、按什么名单
来源分组、何时确认/冻结、材料窗口是否开放。分组发生在报名截止之后，甚至现场；
它可以不存在（当年赛制没有分组合唱），也可以先录草稿再废弃。

## 实体

| 实体 | 关键字段 |
| --- | --- |
| `GroupingStage` | `stageKey`、名称、四态状态、`rosterSource`（全部已批准 / 指定轮次晋级）、来源轮次、来源指纹、材料窗口 |
| `Group` | 顺序、名称、是否 active |
| `GroupMembership` | 组、参与者、`isCurrent`、加入/离开时间、移除人、原因；只追加 |

## 生命周期

```text
draft ──confirm──▶ confirmed ──freeze──▶ frozen
  │                    │
  └────cancel──────────┴──▶ cancelled
```

- 确认要求完整覆盖来源名单；冻结重新解析来源并比对指纹。
- 冻结后不可取消；确认/冻结可修正，必须带原因且只追加成员历史。
- 材料窗口（closed/open/supplement_only）只在 confirmed/frozen 可设；取消时关闭。
- 未冻结且未取消的赛段阻止归档。

## 不变量

见 [`docs/invariants/lifecycle.md`](../invariants/lifecycle.md) 的 **GRP-01…09**：
赛段内一人一组、完整覆盖、来源指纹、冻结不可取消、归档阻塞、来源未定 fail closed、
组数由 release 约束而组大小自由、来源不可变、已确认结果后拒绝修正/取消。

## 领域事件

`GroupingStageCreated`、`GroupingGroupsRecorded`、`GroupingStageConfirmed`、
`GroupingStageFrozen`、`GroupingStageCorrected`、`GroupingStageCancelled`、
`GroupingMaterialWindowChanged`。

## v1 证据

`singer_contest.GroupStage` / `Group` / `GroupMembership` 与
`singer_contest/group_chorus.py`。v1 的 2026 工作台把冻结分组绑定进赛制版本；
v2 没有可编辑赛制草稿，release 不可变，因此改为确认时对照 release 的 `groupCount`，
并用活动级「已确认结果」守卫修正/取消。

## Plus 要求

- 独立 `grouping` capability（依赖 registration + competition），不塞进 competition。
- 每次订阅/命令都在 Activity 锁内；成员唯一性由数据库部分唯一索引兜底。
- 归档包携带 `grouping.json` / `grouping.csv`；legacy 导入按原状态导入。
- 组级材料文件与「补交限定」仍归媒体 slice；当前只保留材料窗口状态。

## 待决问题

- 组材料字节与补交题目绑定何时随媒体 slice 实现。
- 分组修正的消费边界采用活动级保守判断（任何已确认 stage result 即拒绝），
  比 v1 的精确引用更粗；若将来 release 记录消费引用可收紧。
