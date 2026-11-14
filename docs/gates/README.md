# 通用规则门禁

这里把 v1 反复验证过、且**不依赖某一次事故细节**的规则变成自动门禁。目标不是
把 497 条 fix 全部写成测试，而是让同一类错误在下次提交时自动失败。

门禁分三层：

| 层 | 形式 | 运行时机 |
| --- | --- | --- |
| 结构门禁 | `tests/gates/`（静态/契约检查，不需要业务数据） | 每次提交 / PR |
| Golden 门禁 | `tests/golden/`（实现无关的领域样例） | Plus 适配器接入；v1 adapter 已移除 |
| 架构门禁 | Plus 的 domain contract（状态机、selector 唯一性） | Plus runtime/domain 测试 |

## 已自动化的结构门禁

| Gate | 对应不变量 | 检查什么 | 文件 |
| --- | --- | --- | --- |
| GATE-RELEASE-01 | DEPL-01/07 | publish 只由 `v*` tag 触发；bake `github.sha`；带 provenance；生产不发布 `latest`；四个 Plus target 来自同一 tag | `tests/gates/test_release_artifacts.py` |
| GATE-DEPLOY-01 | DEPL-02/03/04 | 生产 manifest 单 origin、镜像 digest、PostgreSQL 18 挂载点、release SHA 注入 | 同上 |
| GATE-SECURITY-HEADERS-01 | DEPL-02 | Plus 站点设置安全响应头；HSTS 只出现在 HTTPS site | `tests/gates/test_deploy_security_headers.py` |
| GATE-ARTIFACT-01 | AUTH-04/DEPL-06 | Git 不得跟踪 `.env`、数据库、media/staticfiles/backups/logs、zip/log/密钥 | `tests/gates/test_no_tracked_artifacts.py` |
| GATE-PLUS-BOUNDARY-01 | ADR-0009/0010/0011 | Plus capability 只能导入 engine 模块与自身；domain 不导入 persistence；engine assembly 不硬编码具体 capability；runtime/API/worker 不直接 import 具体 capability；API/worker 不得 import DB mutator | `tests/gates/test_plus_capability_boundaries.py` |
| GATE-PLUS-ROUTES-01 | ADR-0037 | `app.ts` 只做组合；每个 route module 都被注册；method+URL 不重复；模块不超过 900 行 | `tests/gates/test_plus_route_modules.py` |
| GATE-REALTIME-CORE-01 | RT-01…RT-08 / ADR-0027 | 只有 `packages/realtime` 可 import `ws` / `@fastify/websocket`；只有 `src/client` 与该包测试可 `new WebSocket`；realtime 不 import domain/db/runtime | `tests/gates/test_plus_realtime_core.py` |
| GATE-SPEC-TEST-ARCH-01 | 自审计测试体系 | `docs/artflow-plus/specs/` 与 `plans/` 的新文档必须包含 Test architecture 段 | `tests/gates/test_spec_test_architecture.py` |
| GAP-RATCHET-01 | 自审计测试体系 | UI 消费者、Pack 就绪、Manifest 闭合、文档/部署漂移、不变量测试覆盖；新增缺口失败，修复后必须删除 baseline 条目 | `plus/tools/contracts/src/audit/gaps.ts`、`gap-baseline.json` |

运行：

```powershell
uv run pytest tests/gates -q
uv run python tests/golden/validate_fixtures.py
```

`main` 的 `.github/workflows/gates.yml` 会在每次 push/PR 时跑这两条。

## Golden 门禁（Plus 适配器接入；v1 adapter 已移除）

| Gate | 对应不变量 | 样例 |
| --- | --- | --- |
| GATE-SCORE-01 | SCOR-01/02/06 | `duplicate-score-fact.json` |
| GATE-RESULT-01 | RES-01…RES-06 | `result-release-lifecycle.json`（历史：v1 已执行） |
| GATE-ARCHIVE-01 | RES-06/07 | `archive-identity.json` |
| GATE-TICKET-01 | TICK-01…TICK-03 | `capability-reissue-close.json` |
| GATE-ROSTER-01 | LIFE-07 | `unknown-roster.json` |
| GATE-STATIC-01 | DEPL-02 | `static-artifact-identity.json` |

## 架构门禁在 Plus 的落点

这些规则现在由 Plus 的领域实现与测试覆盖：

1. **单一 selector**：`selectPublicResults` 是公开结果的唯一读入口，其他模块
   不得自行拼查询（RES-02/RES-05）。
2. **状态机边集合**：domain 的迁移表是显式数据；非法边被运行时拒绝，并有
   反例测试（LIFE-01）。
3. **评分事实唯一键**：数据库 partial unique index + command 双重保证（SCOR-01）。
4. **未知/零/空**：`unknown-roster` golden 与类型层区分 unknown 与 zero；
   DEFERRED 不等于 PASS（LIFE-07）。
5. **部署产物一致性**：`GATE-RELEASE-01` / `GATE-DEPL-01` 检查镜像只由 tag
   发布、baked SHA 与 manifest 变量；运行时的产物同版证明仍以这些结构门禁为准
   （DEPL-01/02）。

## 明确不做成门禁的东西

这些是**为了赶时间或只对某个环境成立的补丁**，不应固化成通用规则：

- Debian 镜像源 502 的临时重试/换源；
- 某个页面的具体中文文案、按钮位置、CSS 类；
- 一次性数据迁移/回填的具体值；
- 某台机器 Docker Desktop 只发布 loopback 的临时中继；
- 某个模板/服务的临时调试日志或绕过开关。

它们可以被记录为事故（`docs/artflow-plus/analysis/fix-lessons.md`），但不进入
门禁；否则会把实现偶然性升级成永久约束。

## 新增规则的纪律

1. 新规则必须能写成一两句可断言的话；写不成就不加门禁。
2. 先有反例（这个门禁能抓住哪种提交），再有门禁。
3. 结构门禁放 `tests/gates/`；领域行为放 `tests/golden/`；不要用源码字符串
   匹配去代替领域测试。
4. 门禁本身要有失败信息，指出“哪个文件/模型/变量违反了什么”。
