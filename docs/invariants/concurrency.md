# CONC — 锁、OCC、幂等与并发证据

**原则**：并发正确性不是“设计上应该对”，而是有真实数据库双线程证据的断言。

v1 证据：34 条并发/锁/OCC 类 fix，高频词 `lock 14`、`stale`、`revision`。

---

## CONC-01 聚合根持有单调 revision，写命令必须携带 expected revision

**规则**：每次绑定/状态/候选变更都递增一个单调 revision；写命令必须携带它
看到的 revision；服务端在锁内比较，不匹配就拒绝。缺 token 视为拒绝，不是
“跳过检查”。

**为什么**：v1 用内容 hash 判断“没变”会漏掉 A→C→A；独立小表单漏带 token
让晚到的 preview 覆盖新选择。最终引入 `binding_revision`、
`group_stage_binding_revision`、`candidate_revision` 三层。

**必须攻击的形状**：

- 旧页面提交；
- A→C→A 后再提交 A 的旧 token；
- 缺少 token；
- 两个用户同时提交不同值。

**Plus 要求**：revision 由聚合维护并随事件递增；token 是命令的必填字段；
OCC 失败是领域错误，不是 500。

---

## CONC-02 锁的顺序固定：先 Activity，再聚合，再子对象

**规则**：所有跨聚合写命令按同一顺序取行锁；锁后重新读取对象，不能信任
加锁前的快照。

**为什么**：v1 的锁序是 Activity → ContestRuleset → RulesetVersion →
Round → Seat/Release；乱序会死锁，锁前读取会在窗口内被并发修改。

**必须攻击的形状**：

- 两个命令反向加锁；
- 加锁窗口内删除/换绑对象；
- 锁后 `.get()` 遇到已删除行。

**Plus 要求**：锁顺序是显式表；锁后加载统一走 `filter().first()` 并映射为
领域错误；禁止在锁后对外部对象做未加锁的写。

---

## CONC-03 唯一 key/编号在聚合锁内分配并与 INSERT 同一事务

**规则**：轮次 key、分组 key、官方编号、版本号等唯一性分配，必须在持有
聚合锁时完成，并在同一事务内 INSERT。

**为什么**：v1 曾先查再调一个自己加锁的 service，两个请求算出同一个 key，
第二个 `IntegrityError` 变成 500。修复为把“查 → 选 → 写”收进一个 command。

**必须攻击的形状**：

- 双线程同时创建同一活动下的轮次/分组；
- 重试时残留半成品 key；
- 唯一约束与业务校验不一致。

**Plus 要求**：key 生成器依赖聚合锁；冲突重试只在明确可重试的错误上发生；
唯一约束是最后一道防线，不是唯一防线。

---

## CONC-04 命令幂等：command_id + receipt

**规则**：每个写命令携带客户端生成的 `command_id`；服务端保存 receipt，
同一 ID + 同一 payload 返回同一结果；同一 ID + 不同 payload 拒绝。

**为什么**：v1 的评委评分、票据核销、报名提交都补过幂等回执；没有它，网络
重试会生成第二条事实。

**必须攻击的形状**：

- 同 command_id 重放；
- 同 command_id 改 payload；
- 两个不同 command 并发提交同一事实；
- 回执成功但事实未落库。

**Plus 要求**：receipt 与事实同一事务；幂等键在聚合内唯一；重放返回原始
结果，不重复写审计。

---

## CONC-05 每条依赖锁的路径都有真实数据库双线程测试

**规则**：涉及行锁、唯一约束、幂等的写路径，至少一条 PostgreSQL 双线程
测试固定 interleaving；SQLite 或单线程测试不算证据。

**为什么**：v1 后期补了评委评分 race、票据凭证 race、绑定 CAS；此前单线程
测试全绿，但现场仍有窗口。

**必须攻击的形状**：

- 两个事务同时 claim 同一席位/票据；
- 锁定与提交同时发生；
- 解锁/发布与重算同时发生；
- 重试与首次提交同时发生。

**Plus 要求**：并发测试是 CI 的必跑项；使用真实数据库与独立连接；断言最终
状态和错误类型，而不是只断言“没 500”。

---

## CONC-06 锁后读取用 `.first()`，并发删除映射为领域错误

**规则**：锁后重读不允许 `.get()`；记录在窗口内被删除时，返回业务错误
（404/409），不是未捕获异常。

**为什么**：v1 的 challenge session 在“先读拿 activity_id → 拿锁 → 再读”
之间被并发清理删除，`.get()` 直接 500。

**Plus 要求**：仓储的 get-by-id 返回 `Option`；command 显式处理缺失；HTTP
层不泄漏堆栈。

---

## CONC-07 读模型也要带版本，陈旧行 fail closed

**规则**：公开/结果选择器不能只看 ID，还要比较 version/revision/fingerprint/
ruleset/current 状态；任何一项不匹配就不展示。

**为什么**：v1 的 ResultRelease selector 补上 `post_version`、`result_version`、
`candidate_revision`、ruleset hash、fingerprint、latest 与 current frozen，
避免旧 release 在事实换代后仍被展示。

**必须攻击的形状**：

- 改文章版本后旧 release；
- 赛段候选 revision 变化后旧 release；
- ruleset 换版后旧 release；
- 同 facts 的重复发布。

**Plus 要求**：read model 的查询包含全部权威条件；陈旧记录返回“不可见”而
不是“尽力展示”。

---

## CONC-08 后台任务与 HTTP 请求共享同一套幂等与锁规则

**规则**：异步 worker、定时清理、批处理与 HTTP 命令使用同一套命令、锁、
revision 和审计；不能有“后台可以随便写”的例外。

**为什么**：v1 的清理、归档、自动重算、实时广播都以不同方式写库；后期统一
到 command/service，避免后台路径绕过 authority。

**Plus 要求**：worker 消费的是领域命令；重试策略由 command 的幂等语义决定；
后台任务不直接持有 ORM。
