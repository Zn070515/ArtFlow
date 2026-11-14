# Private Test Data Usage Implementation Plan

> **For agentic workers:** Execute this plan inline in the primary agent conversation. Do not spawn subagents or use worktrees. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将 `ArtFlow_2025院十佳_全量私测资料包_v3_test_ready` 安全、可重复地装载到云服务器专用 TEST 活动，覆盖四轮评分、轮换评委、脱敏观众票、合成票券、媒体输入、结果闭场、备份恢复和清理，同时严格隔离历史来源、合成数据、FORMAL 数据和原始个人信息。

**Architecture:** 新增一个“manifest 校验器 + TEST fixture loader + evidence verifier”窄边界。loader 只接受 TEST activity，先 dry-run，再按现有 account/round/panel/score/vote/ticket/file/result services 写入；不把原始资料包复制进仓库，不在脚本中直接 bulk-update 受 authority 保护的事实。媒体按当前 `SubmissionFile` 的 owner/purpose/version 语义处理，round-specific 关系只存在于外部 manifest，避免伪造当前 schema 不支持的 round foreign key。

**Tech Stack:** Django management commands, Python `csv`/`json`/`hashlib`/`zipfile`, existing domain services, Django `TestCase`, FFprobe preflight, Docker Compose PostgreSQL, existing backup/restore scripts, Pyright/Pylance.

**Spec:** `docs/superpowers/specs/2026-09-28-private-test-data-usage.md`

## Global Constraints

- 所有工作 inline 完成；不创建 `.worktree/`，不 spawn subagent。
- 原始资料包、原始投票 Excel、生成媒体和 `.env` 不进入 Git；只把可复用的 loader、验证器、文档和无隐私测试夹具提交到仓库。
- 远端只使用专用 `TEST` event service；不得使用生产 compose、FORMAL activity 或生产 volumes。
- loader 必须 fail closed：活动不是 TEST、manifest 不匹配、出现原始 IP/凭据、source path 越界、目标数据已有 FORMAL 依赖时立即停止。
- 受保护的 score/vote/ticket/file/result 事实必须走既有 service/authority context；禁止为方便导入而绕过 model guard。
- 每个逻辑变更单独小步提交；先跑聚焦 gate，再提交，最后才合并 main 并 push。
- 私测完成前不得把任何测试结果标成正式生产证据，不得发布公开结果。

---

## Task 1: 固定私测包边界并实现离线 manifest verifier

**Files:**

- Create `scripts/verify_private_test_package.py`
- Create `scripts/tests/test_private_test_package.py`
- Create `docs/private-test-data-runbook.md`

- [ ] 定义 verifier CLI：`--root`, `--manifest`, `--json-report`, `--require-sanitized-votes`；默认只读，不导入 Django。
- [ ] 校验包根目录、manifest 中每个文件的相对路径、bytes、SHA-256、文件数量、无越界路径和无未列文件。
- [ ] 校验 fixture 必须包含 15 名选手、4 轮、5 名合成评委、P1R2 190 行、P2R2 120 行、280 张合成票券、60 个媒体 assignment 和 60 个媒体文件。
- [ ] 校验投票 CSV 不出现原始 voter name/raw IP 字段或原始 Excel 扩展名；只接受 sanitized option/candidate mapping。
- [ ] 对音频/视频/图片执行可配置的 `ffprobe`/签名检查；缺少 FFprobe 时报告为 preflight unavailable，而不是伪造 PASS。
- [ ] 输出 `source_count`, `synthetic_count`, `upload_allowlist`, `excluded_private_files` 和 hash 摘要，不输出原始 IP/凭据。
- [ ] 为 verifier 写临时目录测试：hash mismatch、path traversal、extra file、raw IP column、缺媒体、错误 count 都必须失败。
- [ ] 在 `docs/private-test-data-runbook.md` 写清楚原始包留在本机、远端允许清单、脱敏流程和执行前后证据目录。
- [ ] 运行：`python scripts/verify_private_test_package.py --root <v3-root> --json-report <report>`。
- [ ] 运行：`python -m pytest scripts/tests/test_private_test_package.py`。
- [ ] 提交：`test: validate private rehearsal package boundary`。

## Task 2: 建立可审计的 fixture parser 与 dry-run loader contract

**Files:**

- Create `common/private_test_fixture.py`
- Create `common/management/commands/load_private_test_fixture.py`
- Create `common/test_private_test_fixture.py`
- Create `common/test_private_test_loader.py`

- [ ] 定义 typed fixture objects，解析 `artflow_2025_full_reference_fixture.json`、panel CSV、score CSV、ticket CSV、media assignment CSV 和 sanitized vote CSV。
- [ ] 解析阶段只做 schema/count/provenance 校验，不触碰数据库；所有合成对象带 `SYNTHETIC_TEST_ONLY` 标识。
- [ ] 命令参数固定为：`--root`, `--activity-key`, `--operator-username`, `--dry-run`, `--apply`, `--reset-test-runtime`；禁止接受“任意 activity id + 任意 raw SQL”。
- [ ] `--dry-run` 必须输出将创建/更新的 activity、registrations、rounds、panels、score cells、vote rows、tickets、media versions 和预期前三，但数据库和 media root 都不得变化。
- [ ] `--apply` 只能在 `Activity.is_test_mode=True` 的专用 activity 中运行；活动不存在时通过受控 bootstrap 创建，活动已存在时做 ownership/fingerprint 检查。
- [ ] 重复运行必须返回 deterministic “already loaded/no-op” 或要求显式 `--reset-test-runtime`；不得静默重复创建业务事实。
- [ ] `--reset-test-runtime` 只能调用 `clear_activity_test_data`/现有 TEST cleanup service；不得删除 FORMAL rows、source volumes 或非 TEST rows。
- [ ] 以 Django `TestCase` 覆盖 dry-run no-write、formal activity reject、manifest mismatch、repeat load、reset safety 和 provenance marker。
- [ ] 运行：`python manage.py test common.test_private_test_fixture common.test_private_test_loader`。
- [ ] 提交：`feat: add private test fixture loader contract`。

## Task 3: 通过正式服务建立 TEST 活动、账号、选手、轮次和材料槽

**Files:**

- Modify `common/management/commands/load_private_test_fixture.py`
- Modify `common/private_test_fixture.py`
- Extend `common/test_private_test_loader.py`
- Add/update `docs/private-test-data-runbook.md`

- [ ] 用 account service 创建/复用合成操作员和 15 个 participant accounts；禁止把真实学号、手机号、IP 或原始凭据写入账号。
- [ ] 在 TEST 活动下创建 15 个 `SingerRegistration`，通过受控 service/authority 写入 synthetic student_id/mobile，确保 `is_test_data=True`、activity ownership 和 idempotency。
- [ ] 创建四个 draft `ContestRound`，配置 round sequence、roster source、advance count、minimum judge count 和 rubric 引用；轮次状态推进只通过 `prepare_round` 等正式服务。
- [ ] 为四轮创建/校验 `MaterialSlot` 和材料检查项；明确记录当前模型没有 round-bound `SubmissionFile`，不得在数据库中虚构该关系。
- [ ] 创建 5 名合成 `Judge`，保存 panel assignment 但不提前写 score；通过 `prepare_judge_panel` 为每轮冻结 3 名 attending judges。
- [ ] 对上述步骤加入 activity ownership、TEST marker、operator audit 和重复执行断言。
- [ ] 聚焦运行：`python manage.py test common.test_private_test_loader singer_contest.test_judge_authority files.tests`。
- [ ] 提交：`feat: bootstrap private test contest domain`。

## Task 4: 配置 TEST ruleset、冻结 panel snapshot 并导入 synthetic scores

**Files:**

- Modify `common/management/commands/load_private_test_fixture.py`
- Create `singer_contest/test_private_fixture_scores.py`
- Extend `common/test_private_test_loader.py`

- [ ] 从 TEST 可用的 Production template 克隆定义到该 TEST activity，不修改全局 template、不改变正式活动模板。
- [ ] 让 binding 明确列出四轮、checkpoint、vote source 和 roster source；冻结后 loader 只读取 frozen binding。
- [ ] 按 v3 panel assignment 调用 `prepare_judge_panel`，验证每轮 exactly 3 active members、expected/minimum judge count 一致，非 panel judge 不会进入 expected cells。
- [ ] 将 criterion-level synthetic score 聚合成当前 service 所需的 score payload，使用 `apply_scores_if_version` 的 base version/command id；不得直接 `ScoreRecord.objects.create/update` 或 `CriterionScore.objects.bulk_create` 绕过 authority。
- [ ] 每轮评分后调用正式 recalculate/lock/advancement flow；不完整 active matrix 必须失败而不是写入默认分。
- [ ] 加入结果断言：四轮 active panel 完整、非 panel cells 为零、stage input fingerprints 可追溯、最终前三是 A1/J10/C3。
- [ ] 聚焦运行：`python manage.py test singer_contest.test_private_fixture_scores common.test_private_test_loader`。
- [ ] 提交：`feat: load private test panels and synthetic scores`。

## Task 5: 通过 voting/tickets services 导入脱敏票和合成票券

**Files:**

- Modify `common/management/commands/load_private_test_fixture.py`
- Create `voting/test_private_fixture_votes.py`
- Extend `common/test_private_test_loader.py`

- [ ] 创建并配置 P1R2/P2R2 TEST vote sessions、options 和 `VoteScoringRule`；purpose 与 frozen ruleset binding 必须一致。
- [ ] 用 `create_ticket`/`issue_ticket_batch`/`issue_ticket` 建立 280 张合成票券；只用合成 serial/token，保留一小批用于 check-in/redeem/replay/void 测试。
- [ ] 用 `submit_ballot` 或同等正式 voting service 逐条/批量受控提交 190/120 条脱敏 ballots；不写原始 voter name/IP，不直接更新已锁 session。
- [ ] 对重复 ballot、重复 ticket redemption、foreign option、locked session mutation 执行拒绝断言。
- [ ] 运行 ballot count/option aggregate 与脱敏 fixture 比对，确认 resolver 所读 score source 与 UI 显示一致。
- [ ] 聚焦运行：`python manage.py test voting.test_private_fixture_votes voting.tests tickets.tests common.test_private_test_loader`。
- [ ] 提交：`feat: load sanitized private test votes and tickets`。

## Task 6: 通过文件服务导入媒体并生成覆盖 evidence

**Files:**

- Modify `common/management/commands/load_private_test_fixture.py`
- Create `files/test_private_fixture_media.py`
- Extend `common/test_private_test_loader.py`
- Update `docs/private-test-data-runbook.md`

- [ ] 对 3 名代表选手 × 4 轮 × 5 用途的 60 个包内文件逐一做 manifest/hash/type/size preflight。
- [ ] 通过 `store_submission_file` 写入，不使用 `SubmissionFile.objects.bulk_create`；在 TEST 活动验证大视频允许、正式活动大视频仍被拒绝。
- [ ] 处理当前模型的唯一 current 语义：每个选手/用途保留最后版本为 current，历史版本按 `original_name` 和 loader evidence 标识 round；不声称数据库存在 round FK。
- [ ] 如果上传配额或最大版本数会淘汰数据，dry-run 必须提前报告并停止，不能静默减少覆盖率；由操作者显式选择“版本压力模式”或“仅 canonical current 模式”。
- [ ] 生成 `media_import_evidence.json`：每个 assignment 的源 hash、上传结果、SubmissionFile id/version/current、round label、ffprobe 摘要；不包含本机绝对路径以外的敏感信息。
- [ ] 覆盖伴奏、图片、文本、10MB 级和几十 MB 级视频；记录磁盘、上传耗时和最终 media backup 大小。
- [ ] 运行：`python manage.py test files.test_private_fixture_media common.test_private_test_loader`。
- [ ] 提交：`test: cover private rehearsal media versions`。

## Task 7: 完成闭场、结果验证、攻击性回归和证据汇总

**Files:**

- Create `scripts/private_test_rehearsal.mjs`
- Create `scripts/tests/test_private_test_rehearsal_contract.py`
- Create `docs/private-test-evidence-template.md`
- Extend `common/test_private_test_loader.py` if needed for result assertions

- [ ] 用 `maybe_resolve_checkpoints`/`recompute_activity_result`、`build_result_closure` 和现有 confirm/unlock/release services 完成 TEST 结果生命周期；不直接创建 Award。
- [ ] 验证最终前三、confirmed result、official award queryset、stage input fingerprint 和 result version。
- [ ] 执行负向场景：stale score、confirm replay、跨 activity forged path、未完成 panel、重复 ballot、重复 redemption、unlock 后旧 result/release 不可见。
- [ ] 保持 TEST post DRAFT；若覆盖 release/revoke API，则验证 public query 对 TEST activity fail closed，且不允许对外公开 URL 成功。
- [ ] Playwright/Node harness 只读取一次性 fixture evidence，不把密码、raw token、raw IP 写入输出；错误页不能用模糊包含关系判定成功。
- [ ] 生成 JSON/Markdown 报告：counts、hash、latency、HTTP status、blocked reason、result target、cleanup status。
- [ ] 运行聚焦命令：`node scripts/private_test_rehearsal.mjs`，再运行 `npm run test:e2e`（仅针对已启动的私有 event service）。
- [ ] 提交：`test: rehearse private contest lifecycle`。

## Task 8: 备份、隔离恢复、清理和不变量核对

**Files:**

- Create `scripts/private_test_cleanup.ps1`
- Create `scripts/tests/test_private_test_cleanup_contract.py`
- Update `docs/private-test-data-runbook.md`

- [ ] 装载前/后分别调用既有 backup 命令，记录 PostgreSQL manifest、media manifest、release SHA 和 source volume 名称。
- [ ] 用 `scripts/restore-verify.sh` 或现有 PostgreSQL acceptance wrapper 恢复到独立临时容器；不得 `docker compose down --volumes`，不得 reset/drop source DB。
- [ ] 在隔离恢复库运行 `check`、fixture counts、result/authority assertions 和 media hash checks。
- [ ] 只对专用 TEST activity 调用 `clear_activity_test_data`/既有清理服务；清理前锁活动并验证没有 mixed formal dependents。
- [ ] 清理后确认 FORMAL activity/rows、source volumes、原始本机包、远端配置和 secrets 未被删除/覆盖；TEST runtime rows 为 0，保留配置行符合白名单。
- [ ] 脚本默认 `--dry-run`，真正清理需要显式 activity key 和 confirmation token；输出只包含计数和资源名称，不输出 secret/token。
- [ ] 运行：`python manage.py test common.test_private_test_loader scripts.tests.test_private_test_cleanup_contract`，再运行 `python manage.py doctor`。
- [ ] 提交：`chore: add private rehearsal backup and cleanup runbook`。

## Task 9: 全门禁、自审两轮和交付到 ECS 私有环境

**Files:**

- No new production code; update `docs/private-test-evidence-template.md` with final SHA and reports.

- [ ] 第一轮契约审查：逐项对照本 spec、AGENTS.md、Authority Baseline、用户确认前三和“3 人四轮媒体/轮换评委”要求；特别检查没有 raw xlsx、direct ORM、FORMAL activity、公开 release。
- [ ] 第二轮语义审查：核对 fixture count、panel expected cells、score criterion/record 数量、vote purpose/binding、media current/version 语义、cleanup scope 和 restore target；对所有报告中的 PASS 逐条找到命令输出证据。
- [ ] 运行 repository gates：`python manage.py check`、`python manage.py makemigrations --check --dry-run`、相关 Django tests、`npm run check:pyright`、`npm run check:pyright:entry-access`、client/CSS/doc gates；仅在相关门禁通过后提交。
- [ ] 在本机先以 `--dry-run` 验证 package，再按云主机 SSH 作业规程传输“最小上传包”和 loader artifact；不要传原始 ZIP、raw Excel 或未脱敏目录。
- [ ] 云端先做 source backup，再部署/启动专用 event service，执行 dry-run，人工核对报告后再 `--apply`。
- [ ] 私测期间保留 SSH-only/loopback 边界，不开放公网；所有临时文件和 evidence 存在受控目录，结束后按 cleanup plan 处理。
- [ ] 汇总最终报告：release SHA、数据包 manifest hash、activity key、counts、媒体覆盖、前三、备份恢复、攻击性负向场景、清理结果和未覆盖项。
- [ ] 只有代码门禁、私测证据和清理证据都通过，才允许按仓库规则小步提交、no-ff merge 到 main、push main；不要把本地私测数据作为提交内容。
