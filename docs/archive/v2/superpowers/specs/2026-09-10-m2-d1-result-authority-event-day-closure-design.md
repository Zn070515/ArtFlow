# M2-D1 Result Authority & Event-Day Closure

状态：设计草案，待用户审核

## 1. 背景与现状

M2-C 已经把现场评分入口、评委席位、上下文、幂等 receipt 和原始事实锁定做成了较完整的 authority 边界。M2-D 的第一步需要把“现场输入已经收齐”可靠地推进到“结果可以被正式核定”，并给活动负责人一个可审计、可重试、可解释的闭场判断。

当前代码的真实状态不是四态，而是：

- `StageResult.Status.HOLD`：输入不足或依赖未满足；
- `StageResult.Status.REVIEW`：规则要求人工处理，不能自动成为正式结果；
- `StageResult.Status.READY_TO_CONFIRM`：解析器已产生候选，仍不是正式业务事实；
- `StageResult.Status.CONFIRMED`：由 `confirm_stage_result()` 在活动锁和当前冻结规则集约束下核定，随后生成正式 `Award`/下游轮次入口。

解析器通过 `persist_stage_result()` 按当前 `input_fingerprint` 和递增 `result_version` 保存候选；重复计算同一最新候选幂等，输入变化会形成新版本。确认服务已经检查当前冻结且 `is_current` 的 `RulesetVersion`、最新版本、当前输入指纹、依赖结果和原始轮次/投票锁定状态，并通过 ORM authority guard 阻止绕过服务直接制造或修改 `CONFIRMED` 结果。

公开结果目前不是 `StageResult` 的状态，而是 `public_portal.PublicPost` 的独立发布对象。`PublicPost.published_public()` 只能保证公开文章状态及测试活动隔离，不能证明文章内容已经对应一组完整的 `CONFIRMED` 结果。这个发布边界属于 M2-D2，不在本阶段悄悄合并。

## 2. 目标

M2-D1 交付一个可执行的内部结果闭场契约：

1. 对每个活动和结果阶段，系统能明确指出当前权威候选、缺失输入、未解决规则、过期候选和阻塞原因；
2. 只有当前冻结规则集、当前输入快照、所有必要原始事实已锁定、上游正式结果已确认时，候选才允许进入 `CONFIRMED`；
3. 确认是活动范围内串行化、可重试、幂等并且有完整审计的正式命令；
4. 确认后的奖项、晋级入口和内部结果板只能读取当前 `CONFIRMED` authority，不得把候选或旧版本冒充正式结果；
5. 解锁必须是显式、管理员授权、有原因、有审计的纠正操作；解锁后旧结果立即失去正式资格，不能继续被导出或用于发布；
6. 闭场检查的结果可以作为现场备用纸面流程和学校接入前置检查的证据，但不宣称已经完成学校 SSO/MFA、WAF、DDoS、备份或合规接入。

## 3. 不在本阶段

- 不新增评分算法、去极值、异常分判定或奖项规则；
- 不把 `PublicPost` 改造成结果数据库，不在本阶段实现公开发布状态 `RELEASED`；
- 不把“文章已发布”解释为“结果已核定”，也不自动从 `StageResult` 生成公开文章；
- 不实现学校 SSO、教师目录映射、MFA、WAF、TLS、边缘限流或公网 DDoS 防护；
- 不允许活动负责人通过客户端选择阶段、选手、评委席位、规则版本或原始输入；
- 不改变已有纸质评分、Staff proxy、PAPER_DR 的 provenance 语义；
- 不删除历史结果、审计日志、旧版本或纠正记录；
- 不使用 Docker 重置源数据库或删除生产样本卷来完成测试。

## 4. 权威模型

### 4.1 结果生命周期

M2-D1 的正式生命周期如下：

```text
raw facts + frozen ruleset
          │
          ▼
      HOLD / REVIEW
          │ 依赖满足且解析完成
          ▼
   READY_TO_CONFIRM  ──────┐
          │                 │ 输入变化、规则版本变化、版本被替换
          │ confirm         ▼
          ▼              stale / superseded（不可确认）
      CONFIRMED
          │
          ├── internal result board / host handcard / official Award
          └── explicit handoff to M2-D2 release gate
```

`stale/superseded` 不新增一个可被确认的业务状态；它是对候选的判定结果。当前实现中的旧行可以保留用于审计，但任何确认入口、正式列表、正式导出和后续发布预检都必须用同一套“当前版本 + 当前输入指纹 + 当前规则版本”判断。

### 4.2 authority 分层

| 层 | 权威数据 | 本阶段规则 |
| --- | --- | --- |
| 原始事实 | `ScoreRecord`、`CriterionScore`、锁定轮次、锁定投票、人工/对决决定、panel/context provenance | 已被确认结果消费后不得直接 ORM 改写；只能走审计解锁或对应的纠正服务 |
| 规则 | 当前 `FROZEN` 且 `is_current` 的 `RulesetVersion`、其 `authority_hash`/执行计划 | 候选和确认都不得使用草稿、superseded 或其他活动的版本 |
| 候选 | 最新 `StageResult` + `StageDecision`/`CompositeResult`/`StageAwardDecision` | `READY_TO_CONFIRM` 只是可核定候选，不是正式结果 |
| 正式结果 | `StageResult.status == CONFIRMED` 及其确认审计 | 结果板、主持手卡、来源奖项和下游阶段只能引用它 |
| 公开发布 | `PublicPost` 或 M2-D2 的显式发布对象 | 与内部确认分离；本阶段只输出可发布前置条件，不改变公开可见性 |

### 4.3 当前候选的唯一判定

对于 `(activity_id, stage_key)`，当前候选必须同时满足：

1. `result_version` 是该阶段最大版本；
2. `ruleset_version` 是活动当前冻结版本；
3. `ruleset_hash`/`authority_hash` 与绑定版本一致；
4. `input_fingerprint` 等于在同一活动锁窗口内重新计算的当前指纹；
5. 阶段依赖所要求的上游 `StageResult` 均为当前版本且 `CONFIRMED`；
6. 本阶段状态是 `READY_TO_CONFIRM` 或 `CONFIRMED`。

任何一项失败都必须返回结构化的不可确认原因，不得通过“取最新一行”“取任意 confirmed 行”或前端隐藏按钮来放宽规则。

## 5. M2-D1 功能契约

### 5.1 结果闭场预检

增加一个只读领域预检（具体模块和公开 URL 在实现计划中确定，不能在 view 中复制规则），概念接口为：

```python
build_result_closure(activity, *, stage_key: str | None = None) -> ResultClosure
```

`ResultClosure` 必须是可序列化的只读值对象，至少包含：

```json
{
  "activity_id": 42,
  "ruleset_version_id": 7,
  "ruleset_authority_hash": "sha256…",
  "stages": [
    {
      "stage_key": "final",
      "current_result_id": 91,
      "result_version": 3,
      "status": "ready_to_confirm",
      "confirmable": true,
      "reasons": [],
      "input_fingerprint": "sha256…",
      "required_raw_facts": {"rounds": [11], "votes": [4]},
      "raw_facts_locked": true,
      "upstream_confirmed": true,
      "official_artifacts": {"awards": 0, "round_entries": 3}
    }
  ],
  "closeable": false,
  "blocking_reasons": ["STAGE_CONFIRMATION_PENDING"]
}
```

字段要求：

- `current_result_id` 可以为空，但不能把旧版本静默标成当前；
- `reasons` 保留解析器原因，`blocking_reasons` 使用稳定机器码并另带人类可读文本；
- 不返回 bearer token、原始 secret、未授权的学生隐私字段、评委私密备注或完整评分明细；
- 预检不得写入 `StageResult`、锁定原始事实、创建 `Award` 或写审计；
- 预检在读取多个相关对象时必须遵守一致的活动范围和版本筛选，不能因单条查询竞态拼出“已闭场”的假象；
- 预检是辅助判断，不取代确认服务的事务内二次检查。

稳定阻塞码至少包括：

| code | 含义 |
| --- | --- |
| `NO_CURRENT_FROZEN_RULESET` | 没有当前冻结规则版本 |
| `RULESET_BINDING_INVALID` | 规则绑定缺失、跨活动或无法解析 |
| `RAW_FACTS_INCOMPLETE` | 缺少评分、票数、panel、roster 或其他必需输入 |
| `RAW_FACTS_UNLOCKED` | 被消费的原始轮次/投票尚未锁定 |
| `RULE_REVIEW_REQUIRED` | 解析器返回 `REVIEW` 或存在待人工决定 |
| `UPSTREAM_CONFIRMATION_PENDING` | 上游阶段尚未 `CONFIRMED` |
| `STALE_CANDIDATE` | 最新候选的版本、规则或指纹不再匹配当前事实 |
| `STAGE_CONFIRMATION_PENDING` | 候选已 ready，但尚未核定 |
| `ACTIVITY_OPERATIONALLY_LOCKED` | 活动已进入不允许该操作的生命周期 |
| `SCHOOL_EXTERNAL_EVIDENCE_PENDING` | 仅在生成学校部署 readiness 报告时使用，不阻塞本地测试活动内部核定 |

`SCHOOL_EXTERNAL_EVIDENCE_PENDING` 不能被误用为应用内部的结果 authority；它只表示部署边界证据尚未由学校/基础设施责任方提供。

### 5.2 确认命令

现有 `confirm_stage_result(stage, confirmed_by=...)` 保持为唯一确认写入口。M2-D1 的实现必须补齐或明确保证以下契约：

1. 进入事务后先锁活动，再按主键重新读取 StageResult；调用者传入的对象只用于定位，不能被信任为当前状态；
2. 对已 `CONFIRMED` 的同一行重复调用返回该行，不重复创建 Award、下游入口或确认审计；
3. 对 `HOLD`、`REVIEW`、不存在的当前版本、旧 `result_version`、旧 `input_fingerprint`、非当前冻结版本和未锁定依赖统一 fail closed；
4. 写入 `status`、`confirmed_by`、`confirmed_at` 必须在同一个 authority context 中完成，并满足数据库 confirmed trail constraint；
5. 确认审计至少记录 activity、stage、result version、ruleset version、authority hash、input fingerprint、operator 和时间；不记录 secret/token；
6. Award、round entry 等下游物化必须发生在同一事务语义内，失败则确认和下游物化全部回滚；
7. 并发确认只能有一个提交者完成状态变更；另一请求只能得到同一个已确认结果或可解释的当前状态错误，不得生成重复正式对象；
8. 确认后不得修改其 decisions、composites、award candidates、规则绑定或所消费的原始事实；
9. 结果详情页、结果板、Award 列表和导出必须使用同一 current-authority 查询条件，禁止各处自行取“最新”或“已确认”。

### 5.3 解锁与纠正

现有 `unlock_stage_result(stage, operator, note)` 是唯一正式解锁入口。M2-D1 保留其管理员范围并补齐审计/闭场语义：

- 解锁必须要求当前行是 `CONFIRMED`，并在活动锁下重新读取；
- 必须有非空原因，原因进入审计但需要按现有审计脱敏规则处理；
- 如果已有下游轮次开始，必须拒绝解锁上游结果；
- 解锁后清空确认 trail，使该行成为非正式候选；旧 Award 不得再进入正式列表/导出；
- 释放原始事实前必须检查其他 confirmed 阶段是否共享这些事实；共享时拒绝部分解锁；
- 纠正后必须重新 resolve，产生新的版本/指纹并重新确认；旧候选不得因“回到同样数值”而被重新采用；
- 解锁、原始事实重开、重新计算和重新确认各自有审计链，不得压缩成一条无细节的“编辑结果”记录。

## 6. 活动日闭场流程

M2-D1 的现场闭场不是一个可任意点击的“完成”布尔值，而是以下顺序：

1. 记录最后一批现场输入的 receipt/审计位置；
2. 运行只读闭场预检；
3. 对每个 `READY_TO_CONFIRM` 阶段执行确认命令；
4. 再次运行闭场预检，确认没有 stale、HOLD、REVIEW、未锁定原始事实或待确认阶段；
5. 核对内部结果板、主持手卡、正式 Award 和下游轮次入口的数量及来源；
6. 生成只读闭场证据：活动、规则 authority hash、阶段版本/指纹、确认审计 ID、下游物化 ID、阻塞码；
7. 将结果公开发布交给 M2-D2 的独立 release gate。

“闭场通过”只代表本地内部结果 authority 完整；不能代表学校已批准上线，也不能代表公网防护、备份恢复或数据保留责任已经落实。

纸面降级路径：若现场无法继续使用 Web，工作人员按照既有纸质评分/人工核定流程记录，系统恢复后由授权 Staff/管理员录入带 `PAPER_DR` provenance 的原始事实，再重复上述锁定、预检、确认和审计流程。纸面记录本身不是 `CONFIRMED` 的替代品。

## 7. 数据、隐私与安全约束

- 预检、详情和审计响应遵循最小披露；对学生、评委和临时身份只返回闭场所需的稳定 ID、汇总状态和受控标签；
- 所有跨对象查询必须限定 `activity`，并再次验证 ruleset、round、vote、panel 和 stage 的归属，防止 IDOR/跨活动拼接；
- 任何客户端传入的 activity、stage、singer、judge、seat、ruleset、fingerprint 仅可作为定位/期望值，不能作为 authority 来源；
- 失败响应不能区分不必要的敏感对象存在性，不能泄露 token、secret、原始请求头或完整 payload；
- 操作日志和量化彩排报告只保留必要的 request/command 标识、状态码、延迟、计数和错误码，不写 bearer 或完整个人资料；
- 速率限制、请求体上限、反向代理、WAF、TLS、连接数和 volumetric DDoS 仍属于部署边界；M2-D1 不将应用层闭场检查宣传为这些控制的替代品；
- 测试必须使用 `is_test_data` 活动或隔离数据库，不能把恶意测试数据混入正式活动；
- 任何恢复/备份演练必须恢复到独立目标，保留源卷和源数据库。

## 8. 测试与门禁

### 8.1 Django/authority 回归

- 当前候选选择：旧版本、同 fingerprint 的历史版本、规则版本切换、回退到旧数值均不能被错误确认；
- 预检：逐个覆盖上述稳定阻塞码，并验证只读、活动隔离和最小披露；
- 确认：READY 成功、HOLD/REVIEW 拒绝、确认重试幂等、两个并发确认只有一个状态转移；
- 依赖：上游未确认、轮次未锁、投票未锁、panel/context 不完整均 fail closed；
- 物化：确认只产生一份来源完整 Award/下游入口；候选、旧来源和解锁来源不进入正式列表/导出；
- 解锁：管理员/非管理员、空原因、共享原始事实、已启动下游、审计和重算重锁；
- 任何 ORM `create/save/update/bulk_update/delete` 绕过确认服务的路径都应继续被 authority guard 拒绝；
- 测试活动不得出现在公开查询、正式导出或闭场报告的正式数据部分。

### 8.2 端到端与恶意彩排

- 通过 Staff 结果板执行“最后一个输入 → READY → confirm → 内部结果板/手卡”的 golden chain；
- 重复点击、并发 POST、刷新、旧表单、旧链接、跨活动 ID、伪造 fingerprint/ruleset/stage、过期候选和解锁后旧 Award；
- 预检读取期间有输入变化时，最终确认仍由事务内 fingerprint 二次检查保护；
- 结果详情、Award 列表、导出和未来 release preflight 不得显示旧 confirmed 来源；
- Playwright 只验证受控本地服务和无副作用的结果展示/错误提示，不在浏览器日志或 trace 中保存 bearer；
- PostgreSQL acceptance 验证真实事务锁、唯一版本、约束和恢复后的 `manage.py check`；
- Docker 不可用时只报告阻塞，不用 SQLite 结果冒充 PostgreSQL 并发证据。

### 8.3 必须通过的门禁

```text
python manage.py check
python manage.py makemigrations --check --dry-run
python manage.py test
npm run check:pyright
npm run check:pyright:entry-access
npm run check:client
npm run test:client
npm run check:css
pwsh -NoProfile -File scripts/check_docs.ps1
```

若修改了生产 Python，Pyright baseline 和 entry-access 均须为零诊断；若加入 TypeScript，必须纳入 client build/test，并同步覆盖门禁。Docker 可用后还必须运行 PostgreSQL focused authority/concurrency、Playwright smoke 和 backup/restore rehearsal；源卷不能被 reset 或删除。

## 9. 交付物与验收标准

M2-D1 完成必须至少包含：

1. 本 spec 的实现计划和逐步小提交；
2. 一个单一来源的闭场预检值对象/领域服务及其最小读取界面；
3. 确认、解锁、正式 Award/下游入口和旧来源过滤的回归测试；
4. 结果板/闭场流程的用户可理解提示和稳定阻塞码；
5. 审计、隐私和学校接入边界文档更新；
6. 两轮自审记录：第一轮检查 authority/状态/目标绑定，第二轮检查并发/幂等/异常/隐私/类型/生成产物；
7. 一份量化的 M2-D1 rehearsal report，至少记录 READY 延迟、确认延迟、重复/并发请求计数、阻塞码计数、5xx/超时、旧来源泄露数和关键门禁结果。

验收结论：只有当所有阶段都能被解释为 `CONFIRMED` 或明确阻塞，且没有 stale 候选、错误来源 Award、跨活动数据、未审计纠正或门禁失败时，M2-D1 才能标记 PASS。任何学校外部基础设施证据缺失，仍单独标记学校接入为 HOLD，不降低本地 authority 的验收标准。

## 10. 迁移与风险

首选无数据库迁移：复用现有 `StageResult` 版本/指纹/确认 trail、`AuditLog`、`Award.source_stage_result` 和已有 authority guard。只有在实现中发现无法表达稳定阻塞原因、闭场证据或发布前置条件时，才新增最小字段/表，并必须先增加 migration review、数据回填策略和回滚方案。

主要风险及控制：

| 风险 | 控制 |
| --- | --- |
| 预检与确认读取规则不一致 | 预检复用领域 helper；确认事务内再次锁定并计算 fingerprint |
| 旧版本被页面/导出选中 | 单一 current-authority query；回归覆盖输入回退和解锁 |
| 确认与 Award 物化部分成功 | 同一事务、幂等查询、失败回滚测试 |
| 解锁破坏共享原始事实 | 先计算其他 confirmed 阶段消费集合，再整体拒绝或整体释放 |
| 把本地结果完整误称学校上线就绪 | readiness 报告明确区分应用证据和学校/部署方责任 |
| 高并发现场产生重复版本或确认 | 活动锁、数据库唯一约束、TransactionTestCase/PostgreSQL rehearsal |
| 闭场证据泄露隐私或 token | 最小字段、日志脱敏、Playwright trace 审查 |

## 11. 自审清单

### 第一轮：契约、authority、语义

- [x] 没有把 `READY_TO_CONFIRM`、`CONFIRMED` 和公开 `PublicPost.PUBLISHED` 混为同一状态；
- [x] 所有正式结果来源都回到当前规则版本、当前结果版本和当前输入指纹；
- [x] 候选、旧版本、解锁来源不会被描述为正式结果；
- [x] 客户端字段、预检展示和页面按钮不能授予 authority；
- [x] 上游、原始事实、Award 和下游轮次的依赖关系有明确闭合点；
- [x] 学校接入的身份、MFA、边缘防护、备份责任仍明确属于外部 HOLD。

### 第二轮：安全、并发、错误处理、可交付性

- [x] 确认/解锁均要求重新读取和活动串行化，且有幂等语义；
- [x] 预检明确为只读，不能因为展示闭场而写入或锁定事实；
- [x] 跨活动、IDOR、伪造 fingerprint/ruleset/stage、重放和 stale 候选都有 fail-closed 要求；
- [x] 日志、报告、浏览器 trace 不应包含 bearer、secret 或不必要隐私；
- [x] Docker 不可用时不把 SQLite 或静态阅读当成 PostgreSQL 证据；
- [x] 交付包含小步提交、双 Pyright 门禁、客户端门禁、文档门禁和两轮自审；
- [x] 未引入无法从现有模型解释的 `RELEASED` 状态，M2-D2 发布边界保持显式。
