# RES — 结果快照、公示、撤销与归档

**原则**：正式赛果的公众事实完全由发布时冻结的 snapshot 定义；修改任何被
消费的输入，必须走解锁 → 新候选 → 重新核定 → 新发布/纠错链。

v1 证据：50 条结果/公示类 fix，高频词 `result 21`、`release`、`snapshot`。

---

## RES-01 一个 CONFIRMED 结果对应一个确定的输入快照

**规则**：确认结果时记录 candidate revision、input fingerprint、
ruleset version/hash 和 stage key；之后任何被消费的事实变化都使旧结果失效。

**为什么**：v1 的 `StageResult` 增加 `candidate_revision`，确认命令要求
操作者提交他看到的 candidate；解锁也会 bump candidate，使旧确认页失效。

**必须攻击的形状**：

- 确认后再改分数/投票/分组；
- 用旧 candidate 页面确认；
- ruleset 换版后仍用旧结果；
- 同 facts 重复确认。

**Plus 要求**：结果聚合持有输入指纹与 revision；确认命令做 CAS；输入变化
产生新的 candidate，而不是原地覆盖。

---

## RES-02 公众只看到 release snapshot，不看到编辑面

**规则**：正式结果页、列表、首页、Live、SSR、PDF、归档只消费
`ResultRelease.result_snapshot`；不使用 `PublicPost.title/content/cover/
PublicMedia` 作为正式事实。找不到有效 release 就不展示。

**为什么**：v1 的详情页曾只渲染 `post.content`，正文为空也算合法发布；后来
还出现 SSR 标题、封面、媒体与 snapshot 矛盾。修复为 snapshot 驱动，并在
无 release 时 404。

**必须攻击的形状**：

- 编辑内容与 snapshot 矛盾；
- 活动改名后已发布标题变化；
- SSR 首屏用 editorial title；
- 列表/详情/Live 各自计算标题；
- 无 release 时回退到编辑正文。

**Plus 要求**：公开结果 read model 只有一个来源；snapshot 是发布命令的产物；
任何“回退到当前值”都是错误。

---

## RES-03 一个 post / 一个 stage 只能有一个 ACTIVE release

**规则**：同一文章、同一赛段最多一条 ACTIVE release；新结果或解锁必须把旧
release 置为 SUPERSEDED/REVOKED，保留历史，不能删除。

**为什么**：v1 用 partial unique constraint 保证单 ACTIVE，撤销/替代保留
历史；release 行本身受 authority 保护，不能直接改。

**必须攻击的形状**：

- 并发创建两条 ACTIVE；
- 删除旧 release 而不是 supersede；
- 撤销后仍可访问旧 URL/媒体；
- 用旧 release 重新发布。

**Plus 要求**：release 是 append-only 的权威记录；状态迁移只能 ACTIVE →
SUPERSEDED/REVOKED；重发布创建新行或复用同构行，但历史不可改写。

---

## RES-04 撤销/替代后旧结果的所有出口立即失效

**规则**：ACTIVE 变为 REVOKED/SUPERSEDED 后，旧 URL、媒体、列表、SSR、
PDF、归档缓存都不能继续展示旧事实。

**为什么**：v1 修复过撤销后媒体仍可匿名访问、旧详情页仍 200、结果媒体
通过 `/media/...` 泄漏。

**必须攻击的形状**：

- 撤销后直接访问旧 URL；
- 撤销后访问旧媒体；
- 列表/首页仍包含旧结果；
- 浏览器缓存/轮询仍显示旧快照。

**Plus 要求**：所有出口以 ACTIVE release 为条件；媒体授权在网关层检查
release 状态；缓存键包含 release revision。

---

## RES-05 公开媒体的可见性独立于父对象

**规则**：正式结果的 editorial 封面/媒体不因 release 生效而匿名可读；正式
海报应是 release-owned 资产，而不是自由上传。

**为什么**：v1 的 `controlled_media` 曾把 `RESULT_PUBLICATION` 当作普通公开
post，导致 release 后旧海报从 404 变成 200。

**必须攻击的形状**：

- ACTIVE 后请求 editorial cover/media；
- REVOKED/SUPERSEDED 后请求旧资产；
- 普通公告共享同一路径；
- 结果媒体被归档/导出间接暴露。

**Plus 要求**：公开资产有独立 authority；结果海报与 release 绑定；媒体网关
不按“父 post 可见”推导子资产可见。

---

## RES-06 历史缺 snapshot 时保持空白，不伪造

**规则**：无法重建的历史（旧 SUPERSEDED/REVOKED release、旧 ACTIVE 的标题）
只能标记 legacy/best-effort；不能用当前活动名、当前候选或当前标题回填成
“历史事实”。

**为什么**：v1 的 0011 明确把旧 ACTIVE 标题回填标为 best-effort；归档历史
对 legacy 行留空。

**必须攻击的形状**：

- 用当前标题回填历史 release；
- 用当前候选重建旧 snapshot；
- 归档把 legacy 行写成完整记录；
- UI 把 best-effort 显示成“原发布标题”。

**Plus 要求**：snapshot 缺失是显式状态；展示/导出标注 legacy；迁移只做可
证明的转换。

---

## RES-07 归档必须自包含，并且不携带内部指纹

**规则**：归档包必须包含每条 release 的冻结身份、候选、决策、奖项和状态
历史；不得导出完整 input fingerprint、authority hash、token、学生隐私。

**为什么**：v1 的 `result_release_history.xlsx` 曾导出完整 fingerprint，与
production-readiness 契约冲突；`public_content_index` 曾用当前活动名而不是
冻结标题。

**必须攻击的形状**：

- 归档缺少冻结标题/身份；
- 导出完整 fingerprint/hash；
- 旧 release 用当前值填充；
- 归档与在线页面描述不一致。

**Plus 要求**：归档导出的是 release 自己的 snapshot；敏感字段有白名单；
归档是离线可解释的，不依赖当前数据库。

---

## RES-08 手卡/PDF/导出与在线结果共用同一 authority

**规则**：主持手卡、PDF、导出中心、归档都只能消费 CONFIRMED/ACTIVE 的正式
结果；候选、HOLD、REVIEW、旧版本不得生成“正式”文档。

**为什么**：v1 的 PDF 曾只要“最新结果”就能下载，HOLD/READY 也能生成名为
主持手卡的 PDF；修复为仅 CONFIRMED，unlock 后旧 URL 404。

**必须攻击的形状**：

- READY/HOLD 时下载手卡；
- unlock 后用旧 URL 下载；
- 导出候选而不是正式结果；
- PDF 与页面 snapshot 不一致。

**Plus 要求**：文档生成是 authority 的消费者；输入是 snapshot ID，不是
“最新结果”查询；生成物记录来源 revision。

---

## RES-09 投票结果在确认时冻结，预览指纹必须一致

**规则**：从已关闭投票场次生成赛果时，确认命令必须在同一事务内重算 tally，
并要求 `expectedSessionRevision` 与 `expectedInputFingerprint` 同时匹配；写入
`stage_result` 后，公开结果只读这份冻结快照，不再回读投票场次。

**为什么**：关闭场次后票据撤销或数据修正会改变 tally；预览与确认之间必须有
一个显式的指纹闸门，否则公示的内容可能与运营看到的不一致。

**必须攻击的形状**：预览后撤销票据、关闭后改票、用旧指纹确认、rehearsal 场次
进入公开结果。
