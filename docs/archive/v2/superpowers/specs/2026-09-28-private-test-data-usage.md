# ArtFlow 2025 院十佳私测数据使用规格

## 目标

在不污染 FORMAL 数据、不泄露原始个人信息、不绕过 authority service 的前提下，使用本地准备好的 `v3_test_ready` 数据包，在云服务器的私有 event 环境完成一次可重复的全生命周期私测：报名、材料、评委面板、评分、观众票、票券、晋级、结果闭场、备份恢复和清理。

本规格只针对 `TEST` 活动。它不是历史事实修复，也不是把合成数据伪装成 2025 年真实业务记录。

## 数据分层

### A. 历史来源层

保留在本机原始资料包中，仅作为人工核对和 provenance 依据：

- 原始策划案、主持稿、现场照片、原始表格和截图；
- 原始 P1R2 190 票、P2R2 120 票 Excel；
- 原始材料中能确认的 15 名选手、轮次、节目、投票汇总和赛制信息；
- 用户确认的最终前三：陈昭艺、任在天、冷沐阳。

原始投票 Excel 含投票人姓名和 IP，不能上传到云服务器、不能导入 ArtFlow 数据库、不能出现在仓库或日志中。

### B. TEST 合成层

允许进入私测活动，但每条记录都必须带 `is_test_mode`/`is_test_data` 语义或等价 provenance：

- 合成账号、学号、手机号和评委身份；
- 合成评委分；
- 合成票券和签到状态；
- FFmpeg 生成的伴奏、演唱视频、背景视频、节目图片和歌词文本；
- 从原始票数重建的、已脱敏的 P1R2/P2R2 ballot 输入。

合成评委分的唯一业务目标是：在合法的 active panel、评分规则和 resolver 链路下稳定得到用户确认的前三。它不能被标记为历史真实评委分。

### C. REVIEW/HOLD 层

原始资料没有提供的事实保持未知，不强行补成历史事实：

- 真实评委逐项评分；
- 真实票券序列号和真实检票记录；
- 真实选手学号、手机号、微信号；
- 原始材料中互相冲突的字段。

这些内容只在 TEST 数据中使用合成值，并在私测报告中明确标注。

## 远端上传边界

云服务器只接收经过 manifest 校验的最小私测装载包，不直接上传整个原始资料包。默认允许上传：

- `01_结构化事实` 中已经确认且不含原始联系方式的结构化字段；
- `02_私测夹具`；
- `07_realistic_test_addendum`；
- 已脱敏的 P1R2/P2R2 CSV；
- 由 FFmpeg 生成的合成媒体。

默认不上传：

- 原始投票 Excel；
- `03_原始来源`、原始邀请/短信/通告单和不必要的现场照片；
- 任何包含姓名/IP 关联、手机号、学号或其他未脱敏个人信息的文件；
- 原始资料包 ZIP 本身。

装载前必须验证：文件路径没有越出包根目录、manifest hash/size 全部匹配、媒体可被 FFprobe 读取、压缩包中没有 `.env`/数据库/凭据/原始 IP 字段。

## 活动与权限

1. 只创建一个专用 TEST 活动，例如 `ArtFlow-2025-院十佳-私测`，`is_test_mode=True`。
2. 使用已配置的 Staff/Admin 账号和现有 account authority；不创建 superuser 绕过权限，不用原始资料中的身份信息作为认证凭据。
3. 选手账号、工作人员操作、评委身份和操作员全部使用合成身份，并把私测凭据放在云主机 `.env`/密码管理器中，不写入数据包和日志。
4. 装载命令只能接受 TEST 活动上下文；活动不存在、不是 TEST、已离开测试模式或存在同名 FORMAL 活动时必须 fail closed。

## 轮次、面板和评分

### 轮次

使用四个 TEST 轮次，并保留数据包中的晋级链：

- 第 1 轮：15 人，晋级 10 人；
- 第 2 轮：10 人，晋级 10/进入下一计算节点，使用 P1R2 观众票作为相应规则输入；
- 第 3 轮：10 人，晋级 5 人；
- 第 4 轮：5 人，产生最终排序，使用 P2R2 观众票作为相应规则输入。

实际 `advance_count`、`roster_source`、checkpoint 和规则 binding 必须从冻结的 TEST ruleset 读取，不能由装载器在 resolve 时临时覆盖。

### 轮换评委面板

创建 5 名合成评委，但每轮只冻结 3 名 active panel，严格使用 v3 数据包中的轮换：

- 第 1 轮：judge_01、judge_02、judge_03；
- 第 2 轮：judge_02、judge_03、judge_04；
- 第 3 轮：judge_01、judge_04、judge_05；
- 第 4 轮：judge_01、judge_02、judge_05。

必须通过 `prepare_judge_panel(..., attending_judge_ids=...)` 或等价的正式面板服务冻结快照。不能把 3 名评委的分数导入一个宣称有 5 名 active judge 的轮次；否则结果应 HOLD，而不是靠补造冗余评分掩盖缺口。

### 评分

- 评分记录必须通过 `apply_scores`/`apply_scores_if_version`；
- 评分完成后通过 `recalculate_round`、`lock_round` 和 `finalize_advancement` 等正式流程推进；
- 预计 active judge/singer score cell 为 135 个，criterion-level synthetic values 为 555 个，实际数量以规则和 loader evidence 为准；
- 非 active panel 的评分单元必须不存在；
- 任意缺失 active panel 单元必须让闭场检查失败，不能由脚本静默补 0；
- 所有评分备注、导入 evidence 和报告都标注 `SYNTHETIC_TEST_ONLY`。

## 投票与票券

1. P1R2 使用 190 条已脱敏 ballot，P2R2 使用 120 条已脱敏 ballot；只保留序号、时间、选项和合成 IP group 等私测需要的信息，不保留原始姓名/IP。
2. 投票 session 必须声明正确 purpose；规则中作为 audience score source 的 session 必须使用 `score_component`，并在 frozen ruleset binding 中固定。
3. VoteOption、VoteRecord/VoteBallot 必须通过正式投票服务或受控的 TEST loader 写入，不能对已锁定 session 直接 bulk update。
4. 票券使用 280 张合成票券（标准票 180、VIP 100），通过 `create_ticket`/`issue_ticket_batch`/`issue_ticket` 写入；私测中只安排一个明确的小子集做签到、兑换、重复提交和作废测试。
5. 每个投票 session 的有效票数、选项汇总和 resolver 使用的 score source 必须与脱敏 fixture 一致；原始 Excel 的姓名/IP 不得出现在数据库、备份、日志和报告中。

## 媒体策略：避免制造错误的“轮次关联”

当前 `SubmissionFile` 的 authority 语义是“同一选手 + 同一用途的 current/version history”，模型没有 `round` 外键，并且每个选手/用途只有一个 current 文件。因此：

1. 不把 60 个 round-specific 文件伪装成 60 条相互独立的 current submission；
2. 为 3 名代表选手建立 5 个用途的正式 current 材料，并通过 `store_submission_file` 写入；
3. 若要覆盖四轮存储压力，可按 v3 manifest 顺序通过同一正式上传服务写入版本历史，保留 `original_name` 中的 round 标识，并在 evidence 中记录“文件版本对应的测试轮次”；
4. 不能在报告中声称数据库已经具备 round-bound media authority。若产品要求每轮分别查看和锁定媒体，必须另立 schema/功能 spec，不在本次数据导入中偷改语义；
5. 为每轮建立对应 `MaterialSlot`/检查项时，只能把当前模型能表达的 owner/purpose 关系作为检查依据；四轮文件的完整性以 fixture manifest、上传版本链和服务返回结果共同证明。

这套处理同时满足“至少 3 人每轮有完整媒体样本”和“避免把冗余数据误读成真实业务关系”：3 名选手 × 4 轮 × 5 用途的 60 个生成文件用于覆盖输入、版本和大文件场景，但不会被错误建模为不存在的 round foreign key。

## 结果与安全闭场

- 通过冻结 ruleset、阶段 resolve、`build_result_closure`、confirm/unlock/re-resolve 检验完整链路；
- 预期最终排序前三为：陈昭艺、任在天、冷沐阳；该结果必须由 TEST 规则和合成原始事实计算得到，不能直接创建 Award 伪造结果；
- 只有 confirmed stage 才能 materialize stage Award；
- TEST 结果不得创建可公开发布的正式内容。若为覆盖 M2-D2 release/revoke 流程需要创建测试 post，必须保持 DRAFT 或验证 `published_public()` 对 TEST 活动 fail closed；
- 解锁后必须重新 resolve，旧结果版本、旧 Award 和旧 release provenance 不能继续作为当前权威；
- 运行一次跨活动 forged activity、重复确认、stale score、重复 ballot、重复 ticket redemption 和旧 release 可见性检查。

## 备份、恢复与清理

1. 装载前做一次 source volume backup；装载后做一次带 manifest 的 PostgreSQL + media backup。
2. 用 `restore-verify.sh` 在隔离的临时目标容器中恢复并运行 Django check/fixture count；不得对 source database 执行 `down --volumes`、reset 或 drop。
3. 私测结束只对专用 TEST 活动执行 `clear_activity_test_data`/既有 TEST cleanup service；不得用裸 SQL 或全库 delete。
4. 清理后验证：FORMAL 活动、FORMAL 票券、FORMAL 投票、FORMAL 评分、原始资料文件和生产 volumes 的计数与 hash 未变化；TEST 活动和 TEST media/ticket/session/runtime rows 均为 0 或符合保留的配置白名单。

## 验收指标

- dry-run 不写数据库、不写 media；
- apply 重复执行具有明确的 idempotency 或先清理再装载，不产生重复选手、轮次、session、票券和 current 文件；
- 15 名选手、4 轮、5 名评委、每轮 3 名冻结面板可追溯；
- active panel score matrix 完整，非 panel score 不存在；
- P1/P2 脱敏票数分别为 190/120，票券库存为 280；
- 3 名代表选手每轮 5 个媒体用途的 60 个输入全部通过 manifest/FFprobe，应用侧 current/version 语义符合模型；
- 最终前三与用户确认结果一致；
- 全过程无原始姓名/IP Excel 上云、无 FORMAL 数据写入、无公开发布、无 direct ORM authority bypass；
- 备份可在隔离目标恢复，清理不影响 source volumes。
