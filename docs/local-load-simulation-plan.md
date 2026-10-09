# 本地大规模浏览器现场模拟 — 策划

> 状态：**待评审**（尚未执行，尚未提交代码）。执行对象固定为 `bebcb949`。
>
> 这份文档写给"跑之前先定清楚"用：证明什么、不证明什么、谁来演、材料从哪来、按什么顺序、拿什么当通过标准。

## 1. 目的与边界

**要证明的**：在真实浏览器、真实并发、真实故障下，ArtFlow 的 authority 判定与现场主链仍然正确 —— 上百人同时在场不会把正式事实写错、不会出现"两个评委坐同一席"、不会让已作废的票计入有效票、不会在 HOLD 期间静默写入。

**明确不证明的**：

- **不是 ECS 容量验收。** 后端若也跑在这台 9950X 上，跑得再顺也不代表 2C4G / 5Mbps 的线上实例扛得住。容量结论只能在最接近生产的机器上另做一轮。
- **不是 13 人真人彩排的替代。** 这里是脚本演员，真人会做出脚本想不到的事。
- **不是 UI/UX 验收。** 只记录 HTTP 5xx 与 authority 结果，不评价页面好不好用。

一句话：**这一轮测的是"并发正确性 + 浏览器真实行为"，不是吞吐上限。**

## 2. 冻结与运行对象

| 项 | 取值 |
|---|---|
| 代码 | **产品代码固定 `bebcb949`**，跑完之前不 merge、不改产品代码（否则证据立刻失效）。本策划文档与新增的 fixture/runner 是**见证工具**，会各自形成提交 |
| 栈 | `deploy/compose.event.yml`（Caddy 单入口 + web + media + realtime + redis + PostgreSQL） |
| 为什么不用 dev compose | dev 栈只有 web + db，没有代理、没有 media 池、没有 realtime/Redis —— 故障与降级路径根本不存在，模拟不出真实拓扑 |
| 入口 | `http://127.0.0.1:8000`（Caddy），所有演员只走这一个源 |
| 镜像戳记 | `.env.event` 的 `ARTFLOW_RELEASE_SHA` 置为 `bebcb949…` 后再 `--build`，让镜像自带的 revision 标签与证据对得上（`docs/` 在 `.dockerignore` 里，所以镜像内容就是该修订的代码） |
| 后端预算 | Docker/WSL2 VM：**16 vCPU / 36 GB**（`.wslconfig` 限定）。主机 95.6 GB 是主机的，不是后端的 |
| 浏览器侧 | 实测 ~68 MB / context、**1 渲染进程 / context**；150 context ≈ 10 GB。见 §8 |

**跑之前**：`.env.event` 已补齐 `QR_SIGNING_KEY`（本机现场库为零票据的旧 schema，换密钥不失效任何东西），`start-event.ps1` 已验证可拉起六个容器并跑通 `doctor` 与 `/healthz/`。

## 3. 角色与配比

**基数 150 个独立 context，峰值段加到 268。**

每个都是独立 context（各自的 cookie / localStorage / 会话）。**但不要把"context 比进程便宜"当前提**：本机实测是 **1 个渲染进程 / context**（Playwright 默认走 headless shell，每个 page 一个 renderer），所以 268 个 context 就是约 270 个进程。省下来的是**浏览器主进程**（1 个而不是 268 个），不是进程总数。

按现场人数取的量：院十佳决赛是一间报告厅，观众席上百人；工作人员当晚是分工的（不是一个人兼所有活）。所以下面这套配比是"会议室里真实会发生的样子"，而不是"脚本能开多少开多少"。

| 角色 | 基数 | 突发 | 拿什么进场 | 主要动作 |
|---|---|---|---|---|
| Admin | 1 | 1 | 账号 + 二次密钥 | 只读观察；一次撤销公示（验证它不破坏已确认结果） |
| Staff-评委台 | 1 | 1 | 工作人员账号 + 密钥 | 准备评委组 / 暂停 / 恢复 / 释放席位 / 开关入口 / 重发二维码 |
| Staff-录分 | 1 | 1 | 同上 | Rapid Score：批量录分、改旧分、**故意提交过期版本** |
| Staff-检票 | 1 | 1 | 同上 | 检票三态（成功/已检票/无效） |
| Staff-观众侧 | 1 | 1 | 同上 | 投票开关、Live 状态、Incident 登记 |
| Staff-后台 | 1 | 1 | 同上 | 结果板抄卡视角 + 导出（导出是重活，故意混在峰值里） |
| Judge | 5 | 5 | 共享二维码里的 capability（fragment） | 认领 J1–J5、提交评分、ACK 丢失后重试、刷新、锁屏再回来 |
| Judge-溢出 | 1 | 1 | 同一张 capability | 第 6 次认领（期望被拒并提示联系工作人员） |
| Audience-正常 | 100 | 200 | 各自票据 → 换入场会话 | Live 轮询 + 投票（现场观众的主体） |
| Audience-未检票 | 10 | 20 | 只有票据、未 check-in | 尝试换会话/投票（期望被拒） |
| Audience-已撤销 | 4 | 8 | 曾被撤销的票据 | 先投一票，撤销后再投（期望旧票退出有效集、新票被拒） |
| Audience-旧版二维码 | 4 | 8 | 上一版 credential 的二维码 | 期望被拒 |
| Participant/Public | 20 | 20 | 无需凭证或选手账号 | 活动页、Live、报名/材料页混合访问 |
| **合计** | **150** | **268** | | |

内存预算（按实测 68 MB/context 的地板值）：150 ≈ 10 GB，268 ≈ 18 GB。主机 79 GB 空闲，放得下；**要盯的是 36 GB VM 里的后端**。

> 峰值段的观众翻倍**是一项测量，不是一道门禁**：目的是看延迟从哪里开始弯、代理层会不会出 502/504。它不进 §6 的硬指标表（见 §5 的阶段划分与 §6 的 5xx 分类）。

**故障注入**不由浏览器演员承担，由脚本直接操作容器（停 redis、重启 realtime），见 §5 P3。

## 4. 模拟材料（fixture）

现有 fixture 命令都是给浏览器门禁用的小夹具，且多数是 **TEST 生命周期**。这一轮要的是一台"像正式演出"的活动，所以新增一个 fixture 生命周期，形状与既有的 `prepare_media_download_rehearsal` / `cleanup_media_download_rehearsal` 对齐：

```
prepare_site_load_rehearsal   → 建演员阵容并写出 manifest（唯一事实来源）
cleanup_site_load_rehearsal   → 只删本次造出来的行，幂等
```

manifest 至少要带（**演员脚本只读它，不自己查库**）：

```jsonc
{
  "release_sha": "bebcb949…",
  "activity": { "id": …, "public_code": "…", "lifecycle": "FORMAL", "judge_entry_open": true,
                "judge_entry_version": 1, "judge_entry_token": "AF1.J.…" },
  "round": { "id": …, "panel_snapshot_id": … },
  "performances": [ { "id": …, "singer_id": …, "sequence": 1, "label": "…" }, … ],
  "judge_seats": [ "J1", …, "J5" ],
  "staff": [ { "username": …, "password": …, "entry_path": "/staff/…" }, … ],
  "admin": { "username": …, "password": …, "admin_access_key": "…" },
  "tickets": {
    "valid_checked_in":  [ { "serial": …, "credential": "AF1.T.…", "ticket_id": … }, … ],
    "valid_not_checked": [ … ],
    "revoked":           [ … ],
    "stale_credential":  [ { "credential": "（上一版）", "ticket_id": … } ]
  },
  "vote_sessions": [ { "id": …, "name": "现场人气", "open": true, "options": [ … ] } ],
  "questionnaire": { "registration_id": …, "question_key": "r1.accompaniment", "upload_path": "/…" }
}
```

材料清单（每一条都要说清由谁提供）：

| 材料 | 来源 |
|---|---|
| 正式活动 + 冻结赛制 + 单轮次 + 名单 | fixture 新建（`freeze_ruleset_version`） |
| 评委组快照（5 席） + 当前表演 | 复用 `prepare_judge_panel` / `advance_performance` |
| 评委入口 capability | `judge_entry_credential(activity)`，写进 manifest |
| 票据（4 类） | 复用 `create_ticket` / `issue_ticket` / `check_in_ticket` / `revoke_ticket` / `rotate_ticket_credential` |
| 投票会话（开放一 + 已关闭一） | 复用 `open_vote_session` / `close_vote_session` |
| 报名与材料页 | 复用冻结问卷，造 1 个可上传的报名 |
| 上传要用的真实文件 | 运行时写进 `logs/load-sim/`（几 KB 的合法 mp3/jpg 头），**不引新资产、不进仓库** |

**访问密钥不进 manifest**：工作人员密钥与管理员密钥由 runner 从环境读（`ARTFLOW_LOAD_STAFF_ACCESS_KEY` / `ARTFLOW_LOAD_ADMIN_ACCESS_KEY`），manifest 只放账号密码 —— 同一个文件同时写着账号和密钥，等于把它变成一个可以直接登录的凭据包。

### 4.1 runner 脚本

演练还要一个**演员脚本**，形状对齐既有的 `scripts/media_download_load_rehearsal.mjs`：

```
scripts/site_load_rehearsal.mjs        演员调度器：按 §5 的阶段跑，输出 actors.log 与 report
scripts/tests/test_site_load_rehearsal_contract.py   契约测试（跟随既有 load 演练的写法）
```

它只做三件事：**开演员、按时刻表注入、收集证据**。它不查业务库（除 §6 的对账步骤，那一步走 fixture 提供的只读查询），也不做判定以外的动作。

**演员必须走浏览器真实路径**：打开页面、填表、点按钮、跟着重定向走，和 `tests/e2e/` 里那批 spec 用的是同一批 URL 与页面。绕开页面直接 POST 内部接口会把"浏览器会怎么做"这一整层测丢掉 —— 而这一层正是本轮要证的东西。唯一的例外是**故障注入**（停容器），那本来就不是浏览器行为。

**渲染产物不进仓库**：manifest、日志、报告写到 gitignore 的路径（`logs/`、`test-results/`）。

## 5. 步骤

### P0 准备（人工，约 8 分钟）

1. **把"产品代码是 `bebcb949`"变成一个断言，而不是一句话**：见证工具落在 `scripts/` 与 `common/management/commands/`（都会进镜像），所以镜像内容严格来说不等于 `bebcb949`。跑之前跑一次

   ```
   git diff --stat bebcb949 -- . ':(exclude)scripts' ':(exclude)common/management/commands'
   ```

   **必须为空**；manifest 里同时记 `product_revision`（bebcb949）与 `image_build_sha`（含见证工具的那次提交），并记下这次 diff 的输出（应为空字符串）。空不了就别跑 —— 那说明被测代码已经不是被审的那份了。
2. `.env.event` 的 `ARTFLOW_RELEASE_SHA` 置为 `bebcb949…`，`--build` 重建现场镜像并拉起栈；确认六容器 healthy、`/healthz/` 200。
3. `prepare_site_load_rehearsal` 写出 manifest。
4. **记录基线**：对 §6 的每一条对账查询先跑一遍存成 `baseline.json`（"脏的起点"必须先排除，否则事后无法归因）。本机现场库只剩 1 个旧活动、零票据，基线预期几乎全为零。

### P1 冷启动（T-1:00 ~ T+0:00，约 1 分钟）

按顺序把演员逐个拉起来（不是同时）：Admin → 5 Staff → 5 Judge → 第 6 个 Judge（预期被拒）→ Audience 分批 → Public/Participant。
**任一步出现 5xx 即中止**，先把冷启动修干净再谈并发。

### P2 稳定态（T+0:00 ~ T+5:00，基数 150）

主要动作：

- Judge 反复"提交 → 切选手 → 提交"，其中 2 台故意制造 ACK 丢失后重试同一命令号；1 台中途刷新页面（验证会话复用不需要重新扫码）。
- Staff-录分 在多个格子里快速录分，并插入**过期版本**提交。
- Audience 持续 Live 轮询 + 投票；已撤销票的 4 位先投后撤再投。
- Participant/Public 反复访问活动页、Live、报名页。

### P2b 峰值（T+5:00 ~ T+6:50）

在**不重启任何东西**的前提下把观众加到 200（新建 100 个 context，老的不动），持续 1 分 50 秒。

这一段记录的是**曲线**而不是通过/失败：每 15 秒采一次 Live 轮询的 p50/p95、投票提交耗时、`/healthz/` 探针延迟。目的是回答"最先弯的是什么"——gunicorn worker、PostgreSQL 连接、还是 16 vCPU。

**T+6:50 把突发那 100 个观众关掉，留 10 秒沉降，再进 P3。** 顺序不能反：如果一边降载一边注入故障，之后任何异常都无法归因到"是关闭入口的问题"还是"是撤掉 100 个 context 的问题"。

### P3 故障注入（T+7:00 ~ T+11:20）

负载回到基数 150，按固定时刻表注入。**每 20 秒一项**，四项一组记一次"之后发生了什么"：

| 时刻 | 注入 | 期望 |
|---|---|---|
| T+7:00 | Staff 点 HOLD | 评委终端显示现场暂停、提交被拒；**HOLD 窗口内新增正式 score = 0** |
| T+7:20 | Judge 在 HOLD 期间提交 | 被拒，且前端显示原因（不是静默丢弃） |
| T+7:40 | RESUME | 原会话继续，不需重新扫码 |
| T+8:00 | Staff 关闭评委入口 | 新 claim 被拒；**已入席的 5 台不受影响** |
| T+8:20 | 新 context 用同一 capability 认领 | 被拒，原因是"入口未开放" |
| T+8:40 | Staff 重发评委二维码 | 旧码认领被拒；新码可用；**已入席会话继续有效** |
| T+9:00 | 撤销一张已投票的票据 | 旧 ballot 仍在库（证据），但退出有效集 |
| T+9:20 | `docker stop` realtime（WebSocket 不可用） | HTTP 主链仍可提交评分；轮询照常 |
| T+9:40 | 重启 realtime | 已连接页面恢复，**不产生重复事实** |
| T+10:00 | 停 Redis 再起 | 同上；HTTP 不受影响 |
| T+10:20 | **重新开放评委入口** | 新 claim 恢复可用（T+8:00 关掉之后一直没开，不先开的话下一步测不了） |
| T+10:40 | 释放一个评委席位 → 新设备补位 | 新 context 拿到该席位，旧会话失效 |
| T+11:00 | 刷新全部观众页 | 无 5xx，无重复票 |

### P3b 复现那个 P2（T+11:20，**只记录，不改代码**）

评审说的 toggle 抵消。**先把性质说清：这不是竞态，是恒等式。** 接口取反，两次取反回到原值 —— 与并发、与时间窗口都无关，只要两次请求都成功，结果必然是"开放"。行锁保证的是"两个写不互相覆盖"，而这里根本不需要覆盖就已经错了。

所以这一段要产出的不是"能不能撞上"，而是**两个工作人员从过期页面各自点"关闭"时会发生什么**：

1. 两个 Staff context 同时打开活动工作台页面（都看到"关闭评委入口"这个按钮 —— 即页面渲染时是已开放）。
2. 两端在同一瞬间 POST（barrier 对齐，间隔 < 50 ms），**都不刷新页面**。重复 5 次。
3. 记录每次的最终 `judge_entry_open`、两条 AuditLog、以及两次响应的重定向目标。
4. **本轮不改代码**（已定）。产出是证据：预期 5/5 都出现 `open → closed → open`，且两条审计各自留痕。真正要留给下一轮判断的是**UI 语义**——按钮说"关闭"，提交后系统却是"开放"，而页面上没有任何东西提示工作人员这一点。

### P4 收尾（T+12:00 ~ T+13:30）

先把观众降到 0（逐个关 context），等 5 秒让在途请求落地，停掉其余演员 → 跑 §6 的对账查询 → 导出对账结果 → 最后才 `cleanup_site_load_rehearsal`。

**P3b 会把评委入口的最终状态翻一次**，对账前先把入口恢复成关（P3b 结束后它多半是"开放"）。状态没归位的话，"关闭入口后新 session = 0" 这条对账会算错窗口。

### P5 判定

出报告：硬指标逐条 PASS/FAIL + 对账差量 + 复现结论 + 原始日志与报告路径。

## 6. 硬指标与对账

**硬指标**（下表**除标注为"测量"的行**外，任一 FAIL 即整轮 FAIL）：

| 指标 | 怎么测 |
|---|---|
| **HTTP 500 = 0** | Django 自己抛的 5xx，**任何阶段出现即 FAIL**，峰值段也不例外 |
| 代理层 502/504（**测量**） | Caddy 因上游超时/过载产生的 5xx：只在 P2b 峰值段计入曲线；**在 P0/P1/P2/P3 出现仍算 FAIL**（那几段没有理由过载） |
| 重复正式 score fact = 0 | SQL：`(round, singer, judge)` 分组计数 > 1 的行数 |
| 一个 Seat 同时 ACTIVE JudgeSession > 1 = 0 | SQL：按 seat 分组统计 `state=ACTIVE` |
| 错误来源的正式 ScoreRecord = 0 | 落库行数与"演员实际提交成功的命令号"逐项比对 |
| 无效 Ticket 计入有效 ballot = 0 | 有效集口径与库内 revoked/void 票的票根交集 |
| 一 Ticket 多有效 ballot = 0 | SQL：按 ticket 分组统计有效 ballot |
| stale Rapid Score 静默覆盖 = 0 | 过期提交后旧值未被改写（前后取数比对） |
| HOLD 期间新 Judge score = 0 | HOLD 窗口内 `created_at` 落在区间内的 score 行数 |
| 关闭入口期间新 session = 0 | **限定在 T+8:00 ~ T+10:20 这个关闭窗口内**新建的 JudgeSession 数量 |
| rotate 后旧 QR 新 session = 0 | 同上窗口，按旧版本 capability 归因 |
| WebSocket 不可用时 HTTP 主链可用 | realtime 停止期间的成功提交数 > 0，且该期间无 500 |
| 最终对账 | 见下 |

**最终对账**（这一步比"页面看起来都正常"重要）：把每一类落库行与演员声明的动作逐项对上 ——

```
ScoreRecord / ScoreWriteReceipt / JudgeSession / JudgeSeat 状态
VoteBallot / VoteRecord / Ticket 状态 / TicketAccessSession
AuditLog（关键动作必须一条不少）
```

**允许的差量必须解释**：例如"被拒的提交不产生回执"是预期差量，要在报告里写明；**无法解释的差量一律按 FAIL 处理。**

## 7. 产物与证据

```
logs/load-sim/manifest.json          演员阵容（fixture 产物）
logs/load-sim/baseline.json          P0 基线对账
logs/load-sim/reconcile.json         P4 对账差量
logs/load-sim/actors.log             逐 action 的请求/响应/延迟
logs/load-sim/report.md              最终判定
```

约定沿用既有的 `scripts/media_download_load_rehearsal.mjs`：**测量值与硬检查分开**——测量只是数字，硬检查失败必须非零退出；脚本拒绝非 localhost 的 base URL；运行时长设上限（本轮到 T+12 分钟封顶）。

## 8. 已知本机预算（实测，不是估算）

| 项 | 实测 |
|---|---|
| 单个浏览器 context | ~68 MB、1 个渲染进程 |
| 100 context | 6.9 GB，创建 1.14 s，销毁 0.21 s |
| 100 页同时跑 200 ms 定时器 | 7.3 GB（+0.4 GB） |
| Node 驱动进程本身 | 165 MB |
| Docker/WSL2 后端 | 16 vCPU / 36 GB |

→ 150 个 context 约 10 GB、268 个约 18 GB，**浏览器侧不是瓶颈**；真正要盯的是 36 GB VM 里的 PostgreSQL 连接数、gunicorn worker 数与 CPU。

> 注：`68 MB/context` 是空白页地板值。真实终端页（更大 DOM + 轮询 + WebSocket）会更贵，这个数字只用来排除"内存不够"，不能用来推算容量上限。

## 9. 停止条件与红线

**立即停止并保全现场**：

- 任一硬指标 FAIL 且无法归因；
- 后端容器落进 unhealthy（`docker compose ps` 出 unhealthy），或 `/healthz/` 连续 30 秒不可用；
- 主机可用内存低于 8 GB（浏览器的 10~18 GB + 后端 VM 的 36 GB）；
- **任何阶段出现 Django 500** —— 500 不是容量现象，是缺陷，出现即停，先把栈保下来；
- 只有 P2b 峰值段另有一条自己的中止线：**代理层 5xx 超过该段请求的 5%，或 `/healthz/` 探针超过 5 秒**，就提前结束峰值段并记录当时的延迟曲线 —— 拐点已经找到了，继续压只会把证据淹掉。

**红线**：

- 不在本轮改代码、不 merge、不重建镜像（除了跑之前必须的 `--build`）。
- 不碰 `deploy_postgres_data` 之外的任何卷，不用 `docker volume prune`（本机 0 容器时它会把两个数据库一起删掉）。
- 不在模拟过程中执行 `cleanup_site_load_rehearsal`（证据要留着）。
- 报告不得用"页面都正常"替代对账结果。

## 10. 已定参数

| 项 | 决定 |
|---|---|
| 演员规模 | **基数 150 context，峰值段加到 268**（按现场人数配比，见 §3） |
| 时长 | **12 分钟负载 + 约 1 分钟收尾**，时刻表见 §5 |
| 那个 P2 | **本轮不改代码**，只在 §5 P3b 复现并记录证据 |
