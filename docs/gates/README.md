# 通用规则门禁

这里把 v1 反复验证过、且**不依赖某一次事故细节**的规则变成自动门禁。目标不是
把 497 条 fix 全部写成测试，而是让同一类错误在下次提交时自动失败。

门禁分三层：

| 层 | 形式 | 运行时机 |
| --- | --- | --- |
| 结构门禁 | `tests/gates/`（静态/契约检查，不需要业务数据） | 每次提交 / PR |
| Golden 门禁 | `tests/golden/`（实现无关的领域样例） | v1 适配器已接入；Plus 接入同一份文件 |
| 架构门禁 | Plus 的 domain contract（状态机、selector 唯一性） | Plus 实现阶段 |

## 已自动化的结构门禁

| Gate | 对应不变量 | 检查什么 | 文件 |
| --- | --- | --- | --- |
| GATE-AUTH-01 | AUTH-01/02 | 所有 `AuthorityQuerySetMixin` 管理的模型必须 `base_manager_name="objects"`；`authority_write/authorized` 的 scope 必须在 `common.authority` 注册 | `tests/gates/test_authority_gate.py` |
| GATE-MEDIA-01 | AUTH-04 | 任何 `urls.py` 都不得挂载静态 media；`controlled_media` 是唯一 `/media/` 路由 | `tests/gates/test_media_gate.py` |
| GATE-LIST-01 | DEPL-03 | ruff / mypy / pyright / coverage / Tailwind / tsconfig / Docker / Dependabot 的清单必须覆盖全部 app 和产物族 | `tests/gates/test_config_lists.py` |
| GATE-RELEASE-01 | DEPL-01/07 | publish 只由 `v*` tag 触发；bake `github.sha`；带 provenance；生产不发布 `latest` | `tests/gates/test_release_artifacts.py` |
| GATE-DEPLOY-01 | DEPL-02/03/04 | 只有 proxy 发布端口；media/realtime 只读挂载 static；`collectstatic --clear`；每个 manifest 变量都有文档 | 同上 |
| GATE-ARTIFACT-01 | AUTH-04/DEPL-06 | Git 不得跟踪 `.env`、SQLite、media/staticfiles/backups/logs、zip/log/密钥 | `tests/gates/test_no_tracked_artifacts.py` |
| GATE-PLUS-BOUNDARY-01 | ADR-0009/0010 | Plus capability 只能导入 engine 模块与自身；domain 不导入 persistence；engine assembly 不硬编码具体 capability | `tests/gates/test_plus_capability_boundaries.py` |

运行：

```powershell
uv run pytest tests/gates -q
uv run python tests/golden/validate_fixtures.py
```

`artflow-plus` 的 `.github/workflows/gates.yml` 会在每次 push/PR 时跑这两条。

## Golden 门禁（已有文件，尚未全部接入 v1）

| Gate | 对应不变量 | 样例 |
| --- | --- | --- |
| GATE-SCORE-01 | SCOR-01/02/06 | `duplicate-score-fact.json` |
| GATE-RESULT-01 | RES-01…RES-06 | `result-release-lifecycle.json`（v1 已执行） |
| GATE-ARCHIVE-01 | RES-06/07 | `archive-identity.json` |
| GATE-TICKET-01 | TICK-01…TICK-03 | `capability-reissue-close.json` |
| GATE-ROSTER-01 | LIFE-07 | `unknown-roster.json` |
| GATE-STATIC-01 | DEPL-02 | `static-artifact-identity.json` |

## 还需要在 Plus 实现的架构门禁

这些无法靠 v1 源码静态检查得出，必须在 Plus 的领域层落地：

1. **单一 selector**：每个公开事实只能有一个 read model 入口；其他模块不得
   自行拼查询（RES-02/RES-05）。
2. **状态机边集合**：迁移表是显式数据；非法边在类型/运行时都被拒绝（LIFE-01）。
3. **评分事实唯一键**：数据库约束 + command 双重保证（SCOR-01）。
4. **未知/零/空**：类型层区分 unknown 与 zero；DEFERRED 不等于 PASS（LIFE-07）。
5. **部署产物一致性**：启动时证明 baked SHA、static bundle、配置与镜像同版
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
