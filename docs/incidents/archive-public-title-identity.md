# 事故：归档导出了归档时的当前标题，而不是发布时的冻结标题

## 现象

活动发布结果时标题为 A，之后改为 B；归档 ZIP 的 `public_content_index` 用
当前活动名生成 `B · 正式赛果`，而 `result_release_history` 保留的是 A 的
snapshot；两张表互相矛盾。旧 release 的标题被 best-effort 回填后也无法证明
是历史标题。

## 触发条件

- release 的 snapshot 没有冻结 `activity_title` / `public_title`；
- 归档导出调用 `post.public_title` 或当前 activity.title；
- 旧数据升级时用当前值回填。

## 根因

公网身份在发布时没有被冻结，归档又把它当作“当前值”重新计算。历史记录不是
历史，而是“今天对历史的解释”。

## v1 修复

- release 时冻结 `activity_id` / `activity_title` / `public_title`；
- 归档 history 导出 Snapshot Activity ID/Title/Public Title；
- `public_content_index` 从该 release 的 snapshot 取标题，legacy 行留空；
- 0011 明确标注旧 ACTIVE 回填只是 best-effort。

## 不变量

- RES-02：公众事实只来自 release snapshot；
- RES-06：无法重建的历史保持空白，不伪造；
- RES-07：归档自包含且不导出完整 fingerprint/hash。

## 门禁

- Golden fixture：`tests/golden/archive-identity.json`；
- 归档 workbook 测试（v1）。

## Plus 要求

- release 命令一次冻结完整公众身份；
- 归档只消费 snapshot；
- 导出字段白名单，legacy 状态显式。
