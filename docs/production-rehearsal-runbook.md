# 2026 校园十佳正式彩排与交付运行手册

本手册面向 Staff/Admin 和发布前值班人员。正式成绩、席位、配对和最终名单只能通过 Staff 页面调用的 authority service 产生；Redis/WebSocket 只负责通知，断开时继续使用 HTTP 页面。系统不提供公开实时成绩页或主持人大屏。

正式生产部署必须使用明确的 `deploy/compose.production.yml`，唯一的 canonical production deployment path 是：

```bash
bash scripts/deploy.sh .env.production
```

不要用根目录开发 Compose 文件承载生产流量，也不要绕过该入口手工拼接生产服务。

## 一、彩排前置条件

1. 活动类型为“歌手比赛”，已进入允许现场执行的阶段，数据库使用 PostgreSQL。
2. 赛制来自系统内置条目「2026 院十佳·渡梦 现场踢馆（系统内置）」：选中它就会建好第一轮评分轮，并预填 15 人 / 5 组×3 人 / 10 个席位的形态。这些数字**都可以改**（配置页见 `/staff/rulesets/<版本 ID>/live-2026/`），系统只检查改完是否自洽：第一轮参赛人数必须大于晋级数、**踢馆人数由「参赛人数 − 晋级数」决定且不可单独填写**、第三轮人数等于晋级数；分组只要求「恰好这么多组、每个人出现且只出现一次、没有空组」，**每组人数是建议值而非等式**（临时有人退赛时 5 组可以是 3+3+3+3+2）。规则版本已冻结，业务页配置为：「第一轮权重」与「踢馆轮权重」显式填写且合计 100%，「冠亚季军第一轮权重」与「冠亚季军第三轮权重」也显式填写且合计 100%（注意这两套是不同的公式，踢馆成绩只决定席位，不计入冠亚季军）。2026 现场赛制的评分方式固定为评委平均分，不接受“去最高最低”。冻结时必须存在第一轮分组材料、组数与配置一致的分组，以及每名选手的第二轮、第三轮个人歌曲和伴奏问题。
3. 正式选手都有唯一官方选手编号；第一轮已经分成与配置一致的组数（默认 5 组，每组人数可以不等，如 3+3+3+3+2），且已准备评委面板。
4. 现场工作人员确认文件检查状态。图片必须经过 ImageField 和 `files.imaging.sanitize_upload`，补交仍走原有文件 authority、历史和审计链。

2026 赛制的筹备顺序固定为：先完成选手审核、官方编号和五组分组合唱名单，再绑定并冻结正式赛制；赛制冻结后开放问卷收集第二、第三轮个人材料，材料核验完成后才开始第一轮。**冻结在前这一半是系统阻断**：只有当前冻结赛制绑定的轮次才能准备开赛，后继草稿复制出来的第一轮要等它自己冻结之后；反过来，那一轮一旦已经开始（已准备、评分中、已锁定，或现场评委组已建立），就不能再冻结后继版本。材料那一半仍是运营顺序——材料未齐时系统不会替工作人员开赛，而是在第一轮控制台显示仍缺材料的小组数，由负责人确认是否继续。内置赛制创建时就会建好第一轮，但这条顺序不变：冻结仍要求分组、评委、评分表与两套权重齐备。

## 二、发布前门禁

在仓库根目录依次执行：

```powershell
uv sync --locked --extra dev
uv run python manage.py migrate --noinput
uv run python manage.py check
uv run python manage.py makemigrations --check --dry-run
uv run ruff check
npm run check:pyright
pwsh -NoProfile -File scripts/check_docs.ps1
```

现场赛制定向回归：

```powershell
uv run python manage.py test singer_contest.test_challenge --noinput
uv run python manage.py test singer_contest.test_live_materials --noinput
uv run python manage.py test staff_panel.test_live_challenge_console --noinput
uv run python manage.py test singer_contest.test_judge_http --noinput
uv run python manage.py test ruleset.test_compiler.BindingValidationTests --noinput
uv run python manage.py test ruleset.test_live_format --noinput
```

客户端和浏览器门禁：

```powershell
npm run check:css
npm run check:client
npm run test:client
npm run check:e2e
npx playwright install chromium
npm run test:e2e
```

`test:e2e` 需要已经运行的本地或 Compose Web 服务；没有服务时先记录为“环境未提供”，不能把未执行写成通过。PostgreSQL 验收和备份恢复演练使用：

```powershell
pwsh -NoProfile -File scripts/verify_postgres_acceptance.ps1 -StartCompose -VerifyResetSafety
pwsh -NoProfile -File scripts/verify_postgres_backup_restore.ps1 -ComposeProjectName artflow -BackupPath backups/artflow-rehearsal.dump
```

备份恢复脚本只能创建临时目标数据库，禁止对源数据库执行 `down --volumes`、reset 或 drop。

恶意彩排的完整 authority、会话、输入解析、竞态、资源消耗、学校身份接入和恢复矩阵见 [M2-C malicious rehearsal matrix](m2-c-malicious-rehearsal-matrix.md)。该矩阵只允许在授权、隔离、限时环境执行。

正式链路严格为 `AWARD → StageAwardDecision → CONFIRM → Award`。`StageResult.status == CONFIRMED` 才是赛段来源 Award 的正式 authority；Staff 正式奖项列表和 `award_list` 导出只显示无赛段来源的历史 Award，或 `source_stage_result.status == CONFIRMED` 的 Award。`VoteSession 锁定本身不会创建 Award`；首次核定只物化一份来源完整的 Award，重复核定不重复；input fingerprint 或 result version 已变化的 stale 候选不能物化；解锁后旧来源赛段不再 `CONFIRMED`，所以旧 Award 不进入正式列表/导出，新候选必须重新核定。

`Award.source_vote_session` 只解释可能存在的历史行，不是当前 Award authority。删除或迁移前先核查历史数据，不得用它恢复 vote-lock 自动颁奖。

## 三、工作人员彩排流程

### 1. 材料核验

打开 `/staff/activities/<活动 ID>/live-materials/`。页面分别显示：第一轮分组共享材料、第二轮个人材料、第三轮个人材料。先处理缺失或待复核项，再进入评分；不要通过直接修改文件字段绕过检查。

### 2. 第一轮

按分组依次在工作人员页面准备并开启评委面板。组内逐人独立开分；开启下一组不要求上一组评分全部提交，上一组的已开启表演仍可迟交。每名选手达到最低有效评委数后，页面只显示“可以结束收分”，工作人员必须人工锁定并确认。锁定后新评分应被拒绝。

第一轮确认后，进入 `/staff/activities/<活动 ID>/live-challenge/`，创建挑战会话。系统按已确认的正式两位小数成绩排定：第一轮晋级者按官方选手编号升序占据前 N 个固定席位（N = 配置的晋级数），其余人按成绩从低到高进入踢馆队列（队列长度 = 参赛人数 − 晋级数）。队列顺序一经建立不再改写。

### 3. 连续挑战

每一次只处理当前队列位置：

1. 点击“开始当前挑战者选择”。
2. 从后端给出的合法席位中记录口头选择；不要手工填写不在列表中的席位。
3. 配对确认前可点击“放弃本次机会”，该操作不消耗席位挑战机会并推进队列。
4. 配对确认后先开启挑战者评分，再开启守擂者评分；双方可以使用不同的有效评委集合。
5. 双方达到各自最低有效评委数后，分别结束收分并锁定，然后确认胜负。胜负按冻结的「第一轮权重」与「挑战轮权重」对第一轮正式成绩和本场挑战成绩加权；两人综合分完全相等时不能自动确认，必须按数据异常处理。
6. 胜者自动继承守擂者原第三轮位置。已挑战席位不能再次被选择。

所有按钮都带 `command_id` 和会话 revision。重复点击同一命令应返回原结果；页面提示版本过期时，刷新页面确认现场状态后再操作，不要用旧表单强行提交。

### 4. 最终十强和第三轮

五次挑战全部放弃或确认后，点击“确认最终十强”。确认后点击“生成第三轮十人名单”，系统按席位顺序生成唯一的 10 人第三轮名单；该名单绑定当前冻结规则和已确认挑战会话。

第三轮的出场顺序就是席位顺序，生成时不会重排：第一轮前十名的位置在建立挑战会话时就已按官方编号固定，踢馆成功者继承被挑战守擂者的席位。因此官方编号在这里只是身份标识——若按编号重排，会把踢馆成功者挪回守擂者的位置。

第三轮评分与前两轮使用同一正式评分核心。冠亚季军不是只看第三轮，而是按冻结赛制里的「冠亚季军第一轮权重」与「冠亚季军第三轮权重」对第一轮和第三轮的正式成绩加权；挑战场次的比分不进入该加权，挑战只决定谁占住哪个席位。

## 四、18 项验收清单

| 编号 | 验收动作 | 通过标准 |
| --- | --- | --- |
| 1 | 按内置初稿创建选手与第一轮分组并开分 | 组内材料共享，评分对象仍逐人独立 |
| 2 | 未结束第一组时开启第二组，再补交第一组 | 两组都可正常收分 |
| 3 | 5 名评委、最低 4 人，给不同选手提交不同的 4 人组合 | 每人按自己的有效分计算，不补 0 |
| 4 | 达到最低人数但不点锁定 | 仍可提交；人工锁定后拒绝新分 |
| 5 | 先直接输入 `90.005`；再让四位评委给 `90.00`、`90.00`、`90.01`、`90.01` 并完成汇总 | 前者被拒（最多两位小数）；后者平均 `90.005` 按 `ROUND_HALF_UP` 得正式值 `90.01` |
| 6 | 确认第一轮 | 固定 5 人挑战队列和 10 个席位 |
| 7 | 第一位挑战者在配对前放弃 | 队列推进，席位保持未挑战 |
| 8 | 确认一场比赛后再次选择同一席位 | 后端拒绝，不能产生第二场正式配对 |
| 9 | 先开挑战者、后开守擂者 | 先后顺序和双方评分单元独立 |
| 10 | 完成 5 次机会 | 最终十强恰好 10 名且无重复持有人 |
| 11 | 确认挑战胜者 | 胜者继承守擂者第三轮位置 |
| 12 | 完成第三轮并查看 podium | 冠亚季军按冻结的第一轮/第三轮权重加权，挑战场次比分不参与 |
| 13 | Staff 执行日常确认，尝试高风险解锁 | 日常确认可用，高风险操作只允许 Admin |
| 14 | 两个浏览器提交同一 revision | 至多一个正式结果，另一个得到明确 stale/retry 提示 |
| 15 | 重复同一 `command_id` | 返回同一结果，不创建重复事实 |
| 16 | 更正第一轮或改变冻结规则后继续旧挑战 | 旧会话被依赖指纹保护阻止 |
| 17 | 停止 Redis/WebSocket 后继续 HTTP 操作 | authority 流程仍可完成，只有通知缺失 |
| 18 | 制造完全相等的正式两位小数成绩 | 自动胜负确认被阻止，要求人工处理数据异常 |

## 五、失败注入和证据

- 记录每个命令的 `command_id`、页面提示、AuditLog、会话 revision 和数据库最终状态；不要只截图页面。
- 用旧 revision、旧规则版本、已锁定轮次和已挑战席位各重放一次，确认都被服务层拒绝。
- 用直接 ORM `save/update/delete` 尝试改写 ChallengeSession、ChallengeTurn、ChallengeSeat、ChallengeMatch 和 ChallengeCommand；必须得到 authority 错误。
- 并发测试必须在 PostgreSQL 运行，SQLite 仅适合串行单元测试。若多个 SQLite 测试进程同时创建测试库，出现“table already exists”或“database is locked”属于测试环境竞争，应改为串行或使用 PostgreSQL 重跑。
- Redis/WebSocket 只做通知故障注入；不得修改 HTTP authority 的结果。

## 六、交付记录

交付前保存以下信息：Git 提交和合并 SHA、迁移列表、门禁命令及结果、PostgreSQL/浏览器环境、18 项清单证据、未执行项及原因。任何未通过项都必须写明是代码失败、环境缺失还是预先记录的 SQLite 并发限制。
