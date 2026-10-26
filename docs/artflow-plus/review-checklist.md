# ArtFlow-Plus PR 审查清单

每个 PR 在合并前逐项确认。不能确认的项要写明原因，并由 reviewer 决定是否
接受例外；例外需要跟进项。

## 领域规则

- [ ] 改动对应的不变量编号（`docs/invariants/`）已列出；没有新增隐式规则。
- [ ] 改动属于一个明确的 capability；没有把 capability 状态塞回 Activity。
- [ ] 写路径只有一个 command；没有跨 capability 直接读写表。
- [ ] Activity 仍保持薄容器（身份/粗生命周期/enabled capabilities/active release）。
- [ ] Definition 改动走 Package + 对应 capability compiler + cross-capability
      binding 校验；没有把 package 当成一个通用 workflow 图。
- [ ] Release 冻结 execution policy / capability versions / bindings；启动只读 release
      快照，不从当前 registry 重新推导语义。
- [ ] 每个被接受的 command 在同一事务内写 receipt、outbox 与 audit；actor 由 transport
      注入，不从请求 body 读取。
- [ ] Execution Session 带 scope 与 mode；并行/冲突策略由组合声明；TEST/REHEARSAL
      与 FORMAL 不在冲突 scope 上重叠。
- [ ] Studio/Ops/Live/Portal 消费同一 authority；没有哪个面自行解释事实。
- [ ] 新增/修改的状态迁移在显式状态机表中；没有 `save(status=...)`。
- [ ] OCC token 是必填；缺 token/旧 token 被拒绝。
- [ ] 错误是带 code 的领域错误，消息可执行；没有裸异常/堆栈。

### M4 Registration / Questionnaire / Materials

- [ ] M4 HTTP 写入只接受由 `local_session` bearer 解析出的 actor；body 不能指定
      actor id、角色或权限。
- [ ] 报名与材料命令只读取 active Definition Release 的问卷/文件槽位；未知题目和
      不允许的材料在 receipt 事务内拒绝且不产生事件。
- [ ] 私有材料读取按报名参与者或 `materials.read`/`materials.review`/`materials.manage`
      授权；响应不得生成 public/static media URL。
- [ ] roster 的 `unknown` 与 `final(0)` 区分；所有 round/执行准备命令在名单未知时
      返回 `ROSTER_UNKNOWN`，并保持事件、receipt 与轮次状态不变。

### M5 Competition / Evaluation / Podium

- [x] round、panel snapshot、seat、performance score gate 都由 competition-owned
  command 管理；锁顺序为 Activity → round → panel/performance → score fact。
- [x] score fact 由数据库 partial unique index 与 command 双重保证；direct、rapid、
  proxy、paper 共用同一事实，重复返回 `DUPLICATE_SCORE_FACT`。
- [x] panel/seat/performance/context version 在锁内复核；HOLD、superseded、closed
  performance 和 stale context 都在写入前拒绝。
- [x] performance context 递增只退役旧 current score facts；resolver 要求每个
  locked performance 都有 current panel + exact context 的事实，不能用旧事实过门。
- [x] 编辑追加 immutable `score_revision`；纠错持久化 base version 与 input
  fingerprint，按 `open → revise → close → recalculate` 状态机写审计事件，不能把
  locked fact 变成无理由的普通更新。
- [x] ranking 使用 frozen score snapshot；同分默认 HOLD，晋级 cutoff 的 tie 需要
  显式 decision；podium 从 frozen release 的完整 required rounds 读取并保存 source
  score versions，只保存 candidate，不提前确认 Award。
- [x] performance 只能绑定 final approved roster；`competition.round.prepare` 只负责
  prepare，其余比赛生命周期命令需要 `competition.manage`。
- [x] HTTP mutation 将 path resource ID 传入 command，在事务内先校验 performance、
  score fact 与 tie identity，不用 mutation 后检查补救。
- [x] duplicate-score golden、panel/score 双连接 PostgreSQL 并发、runtime/API focused
  tests 已通过；root Django 全量 test 按 Plus 重构约束未运行。

### M6 Voting / Ticketing

- [x] VoteSession 冻结显式 `identityPolicy`（ticket/browser/anonymous）；提交时身份必须
  与策略一致，客户端不能把 ticket/browser 降级成 anonymous；anonymous 只在规则显式
  选择时开放。
- [x] ballot 的 ticket identity 只接受服务端注入的 redeemed ticket session；同活动、
  expiry、revoke、ticket state 与数据库唯一约束均在锁内复核，原始 token 不进入
  command payload/receipt/audit。
- [x] judge score 消费 HttpOnly judge session；session 绑定 activity/seat、expiry 与
  revoke 状态，staff bearer 仍保留独立路径。
- [x] vote open/submit/close 使用 execution session 的 frozen definition version；
  运行 session 存在时禁止 release，漂移返回 `STALE_CONTEXT`。
- [x] ticket/judge 状态迁移拒绝重复终态副作用；judge claim 使用单进程 IP bucket，
  多实例共享限流器明确列为生产部署要求。
- [x] 正式计票统一走 valid-ballot selector；revoked/expired ticket ballot 保留审计但
  不计入结果；零有效 ballot 返回 `HOLD/NO_VALID_BALLOTS`，不伪造 0 分。
- [x] voting 不再静态依赖 ticketing；只有 ticket identity policy 的组合要求 ticketing，
  compiler 在 release 前执行 cross-capability 校验。
- [x] 评委分数、加权总分、平均、排名比较、票数百分比使用 Decimal.js 与
  PostgreSQL numeric 的 `ROUND_HALF_UP` 语义；不使用 `Number(row.total)` authority 读回。
- [x] ticket redeem、ticket ballot、judge seat claim 使用真实 PostgreSQL 双连接并发
  回归；runtime/API focused gates 已通过，root Django 全量 test 按 Plus 重构约束未运行。

### M6.5 / Plus authority follow-up

- [x] voting release artifact 已版本化为 v2；旧的双布尔 artifact 只能触发
  `RELEASE_REISSUE_REQUIRED`，不能在运行时猜测身份策略；已打开 session 继续使用冻结行。
- [x] closed vote tally 由单条 PostgreSQL snapshot 同时读取有效 ballot、vote record 与
  frozen option，正式计票不再拼接分离查询。
- [x] consequential decimal authority 值以 canonical string 保留；Decimal.js 与
  PostgreSQL numeric 均使用 `ROUND_HALF_UP`，authority mapper 不调用 `.toNumber()`。
- [x] `0011_voting_identity_policy` rollback 恢复旧 identity constraint；Pack 不再暴露
  与 baseline `competition` 重复的 `judges` 开关。

### M7a Publishing / Results

- [x] 结果发布只读 release snapshot，不读 activity/post 编辑字段。
- [x] 公开 selector 排除 fingerprint、hash、actor、note 与编辑字段。
- [x] 同一 stage 最多一条 ACTIVE release，部分唯一索引真实存在。
- [x] unlock 在同一事务写 StageResultUnlocked 与 ResultReleaseSuperseded。
- [x] 核定只接受 runtime 读取的 podium candidate；HTTP 不能自带名次。

### M7b Archive

- [x] 归档包只含白名单字段；fingerprint/hash/token/问卷答案/ballot 身份/存储路径
      没有进入 ZIP。
- [x] 归档闭环 fail-closed：running session、未锁轮次、未完成 correction、未关闭
      票场、缺失 ACTIVE release 都拒绝且无副作用。
- [x] 文件写入有反向补偿；下载前校验 size/SHA-256；不一致返回
      `ARCHIVE_INTEGRITY_FAILED`。
- [x] ARCHIVED 是终态；unarchive 是独立命令并保留包历史。
- [x] legacy 无 snapshot 的 release 在归档中保持空白，不伪造。

### M8a Web / Portal

- [x] 公开页只消费唯一 selector；不读编辑字段、fingerprint/hash/token。
- [x] WebGL 场景为懒加载；`prefers-reduced-motion` 不创建 context，错误边界回退
      到静态背景。
- [x] 结果在 DOM 语义表格/列表中；Canvas `aria-hidden`。
- [x] E2E 用独立 schema 种子，不依赖开发者数据库内容。

### M8b Registration Loop

- [x] 会话 cookie 是 HttpOnly/SameSite=Strict；Web 不把 token 写入 storage。
- [x] Cookie 认证的 mutation 必须带会话绑定的 CSRF header；Bearer 客户端豁免；
      login/register/logout 豁免。
- [x] 参与者只能读自己的报名；Ops 读/审核需要 `registration.review`/`manage`；
      名单定稿需要 `registration.roster.finalize`。
- [x] 问卷详情使用报名冻结的 release hash，不跟随当前活动定义。
- [x] 材料只有 metadata，UI/API 不暗示字节已存储；文件题仍需登记 metadata。
- [x] E2E seed 每次重置自己的报名活动数据，避免上一次运行污染断言。

### M8c Studio

- [x] Studio 的 create/activate/compile/release/execution start/close 都要求
      `studio.manage`，且 actor 来自请求而非 base/system。
- [x] Guided 创建与 Expert JSON 编辑都只走同一条 compile/release 命令路径。
- [x] Studio 状态只返回 draft 包、当前编译摘要、release 元数据与会话；不返回
      完整 compiled artifact。
- [x] release 需要 active activity + 当前 draft 的编译；session 只能使用 release
      冻结的 declaredScopes。
- [x] 旧的无鉴权 engine mutation 测试已更新为 studio actor/token。

### M8d Live / Judge

- [x] Live 读取需要 `competition.manage` 或 `judge.manage`；只返回比赛投影，
      不返回完整 release。
- [x] judging execution start/close 接受 `competition.manage`（或 `studio.manage`），
      actor 仍来自请求。
- [x] 评委页不落 token：capability 认领后换成 HttpOnly `artflow_judge_session`，
      capability 从地址栏移除。
- [x] judge session 绑定的入口座位按 seat key 解析到当前 panel 的 competition seat；
      没有用跨 panel 的 seat id 猜测。
- [x] direct_judge 写入在锁内复核 activity/round/panel/performance/seat/context 与
      judge session 绑定；分数归属 panel member 的 judgeId。
- [x] 面板激活只在 activity 启用 ticketing 时创建入口座位，并按
      `(activity, seat key)` 幂等。
- [x] competition score body schema 是单一封闭对象；没有用两个 closed object 的
      Intersect（Fastify AJV `removeAdditional` 会互相删字段）。
- [x] Live 页 SSE 失败退化为 5s 轮询；events/execution-state 仍是恢复权威。
- [x] E2E 覆盖启动会话 → 准备 → 评委组 → 开表演 → 链接 → 评分 → 锁表演/锁轮 →
      排名 → 关闭会话。

### 2026-10-26 M7/M8 review fixes

- [x] `activity.close` / `activity.rename` 在 runtime 内要求 `studio.manage`，
      route 不是唯一防线。
- [x] `POST /api/auth/login` 有 IP 与用户名双桶限流；密码校验走异步 scrypt，
      不阻塞事件循环。
- [x] 幂等重放的 `persistedBody` 把一次性 token 置为 null；set-cookie 只接受
      非空字符串，绝不写 `=null`。
- [x] roster final 后 `registration.review` 返回 `ROSTER_FINAL`，approved 集合与
      `approvedCount` 不会漂移。
- [x] 新 panel 复用 seat key 时撤销旧的 judge session 并 reopen 入口座位；
      `revoked` 座位保持 fail-closed。
- [x] judge/ticket cookie 的 Secure 判断与主会话一致（NODE_ENV 或 APP_ENV）。
- [x] `registrationOpen` 镜像 start-registration 门槛（registration/questionnaire/
      materials + 已发布快照）。
- [x] 归档 CSV 对以 `= + - @` 开头的字符串加 `'` 前缀，防止公式注入。
- [x] 归档 ZIP 使用固定 mtime（1980 epoch），相同内容得到逐字节相同的包与
      sha256。
- [x] `confirmStageResult` 的 note 写入 `stage_result`（迁移 0014）、确认事件与
      读取 DTO；不再只剩 payload hash。

### M8e-1 Mode hardening

- [x] `score_fact`、`vote_session`、`ranking_snapshot` 都有 `mode`；写入一律来自
      运行中的 session，HTTP body 不能指定 mode。
- [x] current score fact 的唯一键包含 mode；排练分不阻塞正式分。
- [x] 正式 resolve/ranking 只读 formal 事实；podium、advancement、tie、publishing
      在非 formal session 返回 `FORMAL_MODE_REQUIRED`。
- [x] 回合存在任何 formal score fact 时，非 formal 的 open/lock/resolve 返回
      `FORMAL_FACTS_EXIST` 且无副作用。
- [x] `reset-rehearsal` 只删非 formal 数据、supersede panel、回合回到 prepared；
      有 formal 事实时拒绝且无副作用。
- [x] 报名/材料仍为 formal-only；测试报名走独立测试活动（导入策略留给 M8e-2）。
- [x] Live 与 judge context 按运行中 session 的 mode 读取计数与已提交分。
- [x] E2E 覆盖“排练 → reset → 正式重跑”同活动链路。

### M8e-2 Legacy import

- [x] v1 导出只读正式行；`is_test_data` 行进入 `excluded` 计数，不写入 v2。
- [x] bundle 不含原始密码、token、session key、IP；历史 ballot 统一匿名。
- [x] 导入是单事务 command；bundle hash + command receipt 保证重复导入 replay。
- [x] 对账在提交前重算 v2 计数/名单/分数/票数与快照 hash；任何 mismatch 回滚。
- [x] 确定性 id 带 public code 前缀，跨活动不冲突。
- [x] 无法表达的 v1 结构写入 `unsupported`，不猜测；历史结果用冻结快照导入。
- [x] 材料只迁元数据（`storage_key=legacy:<id>`），不复制字节。
- [x] 导入历史活动后公开结果页可读。

### 2026-10-26 M8 review fixes

- [x] `/events` 与 `/stream` 需要 `studio.manage`/`competition.manage`/`judge.manage`；
      匿名读不到评分/审核私有事实。
- [x] v1 snake_case 结果快照在导入时归一化为 v2 camelCase，公开结果页可见。
- [x] v1 投票目的 `selection`/`repechage` 映射为 `popularity` 并记入 `unsupported`。
- [x] 同一 stage_key 的多个 v1 结果只导入最新版本；导入器按 stageKey 去重。
- [x] ballot 提交与关票要求 execution.mode 与 vote_session.mode 一致。
- [x] 合成 panel 满足 `minimum_judges <= expected_judges`。
- [x] 派生排名遵守 `drop_high_low`。
- [x] 导出器迁移材料元数据（含审核状态与 review note），不再硬编码空数组。
- [x] 同一 round 多个 panel 只有最后一个 current，版本号递增。
- [x] MemoryRateLimiter 定期清扫过期窗口，避免 key 无限增长。

### M8e-3 Cutover

- [x] Plus API 以 esbuild 单文件 bundle 运行；不在运行时加载 workspace TS 包。
- [x] api/web 镜像分离，但同一 Dockerfile 多 target；nginx 负责 SPA、`/api`
      反代与 SSE buffering off。
- [x] Plus 使用独立 DB/卷/credential secret；`--profile plus` 默认不启动。
- [x] 主域名切换只改 Caddy site profile + 重建 proxy；不按活动/路径混跑。
- [x] 回滚边界是首次 v2 正式写入前；v1 切后只读并保留一个活动周期。
- [x] 首个 cutover 在报名截止后，参与者只读；不迁移参与者账号。
- [x] cutover smoke 只读，且失败退出码非 0；runbook 包含预检、commit point、
      回滚与演练。

## 数据与并发

- [ ] 唯一性由数据库约束 + command 双重保证。
- [ ] 锁顺序固定；锁后重新读取；没有 `.get()` 假设行仍存在。
- [ ] 幂等键/receipt 与事实同一事务。
- [ ] 依赖锁的路径有真实 PostgreSQL 双线程测试（如适用）。
- [ ] Outbox 消费按 projection partition 串行；投影更新有 sequence CAS；死信把分区
      置为 BLOCKED，后续事件不得越过。

## 公开出口

- [ ] 公开事实只来自 snapshot/read model；没有页面自行拼业务条件。
- [ ] 私有媒体只经受控网关；没有静态 media 路由。
- [ ] 撤销/替代/归档后旧 URL、媒体、列表、PDF 都失效。
- [ ] 无 snapshot 的历史保持空白/legacy，不伪造。

## 测试与门禁

- [ ] 领域单元 + 至少一个反例；适用的 golden fixture 已更新并通过。
- [ ] `pnpm -C plus run check` / `test` 通过（Node 24.22.0；Vitest + fast-check）。
- [ ] `uv run pytest tests/gates -q` 通过；没有新增 allowlist 例外。
- [ ] 结构/类型检查清单没有新增遗漏（pyright/ruff/mypy/tsconfig/Tailwind）。

## 部署

- [ ] 迁移可前滚/回滚；没有不可逆的数据改写。
- [ ] 配置新增项在模板与 manifest 中都出现；没有“写了但不生效”。
- [ ] 静态/媒体/缓存版本与镜像一致；没有依赖旧卷。
- [ ] 生产锁版本或 digest；没有 `latest`。

## 文档

- [ ] domain/ADR/roadmap 已更新（如决策变化）。
- [ ] 事故如果暴露了新规则，已写入 `docs/incidents/` 并加 golden/门禁。
- [ ] 没有把一次性补丁写成永久规则；临时方案有过期条件。
