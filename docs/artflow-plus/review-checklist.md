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
