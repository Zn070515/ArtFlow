# M7 → M13.3 代码 Review（high，2026-10-27）

状态：**Closed — 2026-10-28 修复已验证**
范围：`7ef3a58^1..HEAD`（M7a 合并前的最后一个提交到当前 M13.3），169 个实现提交；
纯文档提交不参与 review。审查强度：high。
审查方式：逐层对照实现、测试、部署 manifest 与 runbook；关键项已回读源码抽查。

本文件是修复清单，不是讨论稿。下面每条都给出失败场景与验收方式；修复后应在原条目
标记 `fixed` 或 `superseded`，不要删除历史。

## 总览

| 级别 | 数量 | 主题 |
|---|---:|---|
| P1 | 6 | 生产不可运行、安全/可用性、cutover 阻断 |
| P2 | 4 | 高风险正确性与展示问题 |

修复顺序建议：

1. P1-1 生产 relay
2. P1-2 反向代理后的 rate limit
3. P1-3 反代 body 上限
4. P1-4 legacy 活动归档
5. P1-5 historical import 只读
6. P1-6 结果确认后的评分更正
7. P2-1 release 与回合版本
8. P2-2 exporter fallback
9. P2-3 archive 事件截断
10. P2-4 Live 并列名次

每项都应配一条高层回归，而不是只加单元测试。

---

## P1-1 生产 compose 没有启动 outbox relay

状态：**fixed**

- 位置：`deploy/compose.production.yml:290`
- 现状：`plus` profile 只有 `plus-db`、`plus-api`、`plus-web`；没有 worker 服务，也没有
  `ARTFLOW_PLUS_INLINE_RELAY=1`。
- 失败场景：切换 v2 后 outbox 不被消费：
  - `execution_projection` / `live_state` 不构建；
  - 投票实时 topic 的 `seq` 一直为 0，Ops 票数不更新；
  - pg-boss 兜底不运行；
  - runbook 里的 `ops retry/rebuild` CLI 也没有随镜像部署。
- 影响：v2 看起来能登录、能读，但所有依赖投影/实时的流程都是陈旧的。
- 建议修复：增加 `plus-worker` 服务，或在 `plus-api` 明确设置 inline relay；把
  “relay 进程在运行且 outbox head 在推进”加入 operational smoke。
- 验收：切换后 5 分钟内 `execution_projection.last_sequence` 前进；Ops 投票页收到
  WebSocket 更新；worker 停止时 smoke 失败。

## P1-2 反向代理后 rate limit 变成全站共享

状态：**fixed**

- 位置：`plus/apps/api/src/app.ts:633`
- 现状：`Fastify({ logger: false })` 没有 `trustProxy`；`request.ip` 在 nginx/Caddy
  后面永远是反代地址。
- 失败场景：所有按 IP 的桶共享：
  - `/api/auth/login` 全站 10 次/分钟；
  - `/api/auth/register` 全站 5 次/分钟；
  - 投票 ballot 全站 30 次/分钟；
  - `MemoryRateLimiter` 本身也是单进程全局桶。
- 影响：现场多人同时登录/投票会互相 429；攻击者也只需制造少量请求即可让全站登录不可用。
- 建议修复：配置可信代理下的 `trustProxy`（只信任内网反代），确保 `X-Forwarded-For`
  被正确解析；保留 `TRUST_X_FORWARDED_FOR` 之类的显式开关，默认不信任公网头。
- 验收：经 plus-web 发起 11 次不同来源的登录，只有第 11 次被限；同一来源仍受限。

## P1-3 nginx/Caddy 的 20MB 上限小于材料策略

状态：**fixed**

- 位置：`deploy/plus/nginx.conf:7`，`deploy/caddy/sites/v2.caddy:14`
- 现状：反代 `client_max_body_size 20m` / `max_size 20MB`；API octet-stream 解析是
  128MiB；默认材料策略是 25MB，stage-show 是 100MiB。
- 失败场景：20–25MB 的合法伴奏在反代层 413，API 永远收不到请求；metadata staging
  行一直 pending，`content_ready=false`，槽位无法 current。
- 影响：material cutover 之后，真实比赛材料仍然上传不了。
- 建议修复：反代上限与 API/领域策略对齐（至少 128MiB）；领域 policy 仍是最终校验。
- 验收：真实 21MB 文件经 Caddy + nginx + API 成功 attach；超 policy 文件被领域拒绝。

## P1-4 adopted legacy 活动无法归档

状态：**fixed**

- 位置：`plus/packages/runtime/src/archive-storage.ts:27`
- 现状：archive key 的 activity 段要求 `^[a-z0-9_-]+$`；adoption 的 activity id 是
  `legacy-act-<publicCode>`，v1 public code 含大写字母。
- 失败场景：adopt 一个真实 v1 活动（如 `AB7K2Q9Z`），跑完、close、archive：
  `storage.put("legacy-act-AB7K2Q9Z/v1.zip")` 抛 `Unsafe archive key`，没有领域错误码，
  路由返回 500；任何 adopted legacy 活动都无法归档或读取归档。
- 建议修复：允许大写（或对 archive 目录名做安全 normalization），不要把 activity id
  直接当作受限文件名；补真实 public code 的归档测试。
- 验收：adopt 后 archive/unarchive/download 全程成功，路径穿越仍被拒绝。

## P1-5 Historical import 不是只读，并会重新开放报名

状态：**fixed**

- 位置：`plus/packages/runtime/src/legacy-import-service.ts:1001`
- 现状：没有 active result 时 historical import 把活动置为 `active`；synthetic
  registration artifact 没有 `lifecycle`，`requireRegistrationOpen` 按 `open` 兼容。
- 失败场景：导入有报名、但还没有回合/结果的 historical bundle 后：
  - `GET /api/public/activities/:code` 返回 `registrationOpen: true`；
  - Portal `/join/:code` 自动 `registration.start`；
  - `answer`、`submit`、`uploadMaterial`、`finalizeRoster`、`closeActivity` 都能成功。
  `commandScopes={}` 只挡 execution 命令，不挡 activity 级命令。
- 影响：所谓“历史快照”会接受新报名和新事实，破坏只读语义。
- 建议修复：historical 导入落为 `closed` 或显式 `read_only`；registration lifecycle
  设为 `final`；所有写路径在只读活动上 fail closed。
- 验收：historical 活动匿名 `registrationOpen=false`，start/answer/submit/upload/finalize
  全部返回领域错误；reading/detail 仍正常。

## P1-6 结果确认后，评分实际上无法更正

状态：**fixed**

- 位置：`plus/packages/runtime/src/score-service.ts:146`、`:473`
- 现状：正式 round 没有 unlock/reopen 命令，一旦 `locked` 永远不能回到 `scoring`；
  `loadScoreContext` 和 `correctionContext` 都直接 `ROUND_LOCKED`。
- 失败场景：发布结果后发现评委分数错误：
  1. staff 调 `publishing.stage_result.unlock`（release superseded，结果 ready_to_confirm）；
  2. 打开 correction 或 `editScoreFact` → 仍然 `ROUND_LOCKED`；
  3. 没有任何命令能把 formal round 迁回 scoring（`reset-rehearsal` 只处理非 formal）。
  结果只能原样重新确认，`RESULT_CONSUMED` 的“先 unlock 再改分”不可兑现。
- 建议修复：增加正式的 round reopen/unlock 命令（保留 formal facts 的审计、版本与
  ranking 失效规则），或为已确认结果提供受控更正路径；与 publishing unlock 同一事务
  语义。
- 验收：发布后更正一条评分 → 重新 resolve → 重新 confirm → release；旧 release
  superseded，审计完整；未被消费的回合仍可独立更正。

---

## P2-1 有回合时发布新 definition 会把活动卡死

状态：**fixed**

- 位置：`plus/packages/runtime/src/definition-service.ts:204`
- 现状：只拒绝 running execution session；prepared/scoring/locked 的 round 会留在旧
  `releaseVersion`，没有迁移命令。
- 失败场景：Studio 在 round `final`（v1）prepare 后发布定义 v2：
  - round 仍 `releaseVersion=1`；
  - 新 judging session 跑 v2，score 写入 `STALE_CONTEXT`；
  - podium confirm `SOURCE_RELEASE_MISMATCH`；
  - 重新 prepare 又 `ROUND_ALREADY_PREPARED`；`reset-rehearsal` 拒绝 formal facts。
  活动永久无法产出可发布结果。
- 建议修复：有 round 时拒绝 release，或同事务把 round 迁移到新 release 并重新校验
  rubric/panel/performance 绑定。
- 验收：有 round 时 release 返回明确领域错误；或迁移后 score/ranking/podium 全链路
  在新 release 下通过。

## P2-2 Exporter fallback 把获奖者写成 `legacy-user:None`

状态：**fixed**

- 位置：`common/management/commands/export_plus_bundle.py:313`（awards 在 `:325`）
- 现状：没有 `result_snapshot` 时，fallback 使用 camelCase 的 decisions/awards，但只读
  `contestant_id` / `contestant`，取不到 `contestantId`。
- 失败场景：v1 release 的 `result_snapshot = None` 但存在 confirmed StageResult →
  exporter 写出 `legacy-user:None`；导入 reconciliation 对同一份错误数据做哈希，因此
  对账通过；公开页永久显示 `legacy-user:None`。
- 建议修复：fallback 同时兼容 `contestantId` / `contestant_id` / `contestant`；加一个
  `result_snapshot=None` 的真实 exporter fixture 测试。
- 验收：无 snapshot 的历史结果导入后公开页显示真实 contestant，不以 `None` 结尾。

## P2-3 Archive 只读 100k 事件，静默截断

状态：**fixed**

- 位置：`plus/packages/runtime/src/archive-service.ts:157-160`
- 现状：`readEventsSince` 只取 100,000 条，未检查 `nextCursor`；截断后的历史被当作
  完整包封存。
- 失败场景：大投票/大评分活动超过 100k outbox 事件时，`events-summary.csv` 与
  `manifest.counts.events` 缺少尾部，没有截断标记；归档无法完整复盘。
- 建议修复：分页读全，或超过上限时 fail closed；如果决定允许截断，manifest 必须显式
  记录 `truncated=true` 与原因。
- 验收：>100k 事件的归档要么完整，要么明确失败；不存在无标记的静默截断。

## P2-4 Live 排名把并列显示成不同名次

状态：**fixed**

- 位置：`plus/apps/web/src/components/live/LiveRoundPanel.tsx:291`
- 现状：用 `index + 1` 渲染名次，而 ranking snapshot 的 tie group / 公开结果使用并列
  名次。
- 失败场景：`[A 90, B 90, C 80]` 在 Live 显示 1/2/3，tie 警告却同时出现；与公开结果
  的 1/1/3 矛盾。
- 建议修复：用 snapshot 的 rank 或 tie group 计算显示名次；补并列场景的前端测试。
- 验收：Live 与公开结果对同一 snapshot 显示一致名次。

---

## 修复记录模板

修复后在本文件追加一节，而不是改掉原条目：

```text
### 2026-XX-XX 修复
- P1-1 fixed: <commit>; gate: <command>; evidence: <run/日志>
- P2-3 superseded: <原因>
```

## 2026-10-28 修复记录

- P1-1 fixed: `b170858`; `plus-worker`、生产 API 的 `ARTFLOW_PLUS_INLINE_RELAY=0`、outbox operational smoke 已加入；gate: `pnpm -C plus run test`、`uv run pytest tests/gates -q`。
- P1-2 fixed: `b170858`; trusted proxy 默认为空，并增加可信代理边界回归；evidence: `plus/apps/api/test/proxy-boundary.test.ts`。
- P1-3 fixed: `b170858`; Caddy/Nginx/API transport ceiling 统一为 128 MiB；gate: `tests/gates/test_release_artifacts.py`、Plus build。
- P1-4 fixed: `87e0e79`; archive activity segment 支持大小写且仍拒绝路径穿越；evidence: `plus/packages/runtime/test/archive-package.test.ts`。
- P1-5 fixed: `87e0e79`; historical import 固定为 closed、registration lifecycle 为 final，注册/材料/名册/活动写命令 fail closed；evidence: `plus/packages/runtime/test/legacy-import.test.ts`。
- P1-6 fixed: `bb4f971`; 增加 formal round reopen-for-correction，并串联 score correction、relock、recompute/resolve 的审计与消费检查；evidence: `plus/packages/runtime/test/score-service.test.ts`、`publishing-service.test.ts`。
- P2-1 fixed: `bb4f971`; 有已创建 round 时 definition release 返回 `ROUND_RELEASE_IMMUTABLE`；evidence: `plus/packages/runtime/test/runtime.test.ts`。
- P2-2 fixed: `87e0e79`; exporter 兼容 `contestantId`、`contestant_id`、`contestant`、`singer_id`，缺失身份直接失败；evidence: `common/test_plus_bundle.py`。
- P2-3 fixed: `87e0e79`; archive events 改为 10,000 分页读取并检测 cursor 不前进；evidence: `plus/packages/runtime/test/archive-service.test.ts` 覆盖 100,001 events。
- P2-4 fixed: `bb4f971`; Live 名次按 tie group 使用 competition rank；evidence: `plus/apps/web/src/components/live/ranking.test.ts`。

合并提交：`a95c622`（`artflow-plus`，已推送）。本轮验证：Plus PostgreSQL 全量测试通过、`pnpm -C plus run check` 通过、`uv run pytest tests/gates -q` 为 28 passed、Pyright 0 errors、客户端/E2E 类型检查通过、Docker API/Worker/Web 三个目标构建通过。
