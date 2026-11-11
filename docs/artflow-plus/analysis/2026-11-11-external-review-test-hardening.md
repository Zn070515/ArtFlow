# 外部审核驱动的测试体系加固

日期：2026-11-11。
来源：GitHub Issues `#51`–`#65`（2026-11-11，提交 `facd56ce` 的彩排记录）。
关联：[契约测试任务书](../specs/2026-11-11-contract-testing-program-design.md)、
[实施计划](../plans/2026-11-11-contract-testing-plan.md)、
[ADR-0041](../../architecture/adr/0041-contract-harness.md)。

## 1. 先说结论

这 15 条不是零散的功能缺失，而是同一类问题的不同表面：

> **测试证明了局部能力正确，但没有证明一条产品路径从入口到出口是连通的。**

现有测试已经覆盖 domain、runtime、API、realtime 和 Playwright 关键旅程；但它们
主要以 Capability 或单个接口为单位。外部审核发现的问题集中在：

- API 存在，但 Web 没有任何调用（组织者走不到）；
- Starter Pack 启用了能力，但缺少让该能力可用的定义（材料没有文件题、评分没有
  评委入口、投票身份没有显式选择）；
- 读模型有数据，但页面只显示内部 UUID；
- 文档和部署清单仍描述已经删除的 1.x；
- API 边界把 Postgres SQLSTATE 原样返回，且没有长度前置校验；
- 模式默认值把彩排写进 formal 分区。

因此本轮不急着逐条修产品，而是先把这些缺陷变成**可重复的诊断和契约测试**，
再按优先级修复。

## 2. 15 条 Issue 的测试缺口映射

| Issue | 类型 | 测试体系缺口 | 建议机制 | 优先级 |
| ---: | --- | --- | --- | --- |
| #51 | 部署清单错误 | Compose 与开发基线、k8s 清单没有交叉校验 | 部署清单 gate：PostgreSQL 18 数据卷必须是 `/var/lib/postgresql` | P0 |
| #52 | 文档漂移 | 活跃文档没有“只描述当前树”的门禁 | 活跃文档漂移 gate：禁止 1.x 入口、Gunicorn、`scripts/deploy.sh` 等 | P0 |
| #53 | 开户文档缺失 | 首个 organizer 的创建路径没有文档契约 | 活跃文档 gate + 开户 E2E/CLI smoke | P0 |
| #54 | 评委入口/代录不可达 | Pack readiness 不检查 competition 是否有 ticketing | Pack readiness：judging 能力必须配 ticketing 或显式声明替代入口 | P0 |
| #55 | 材料能力没有文件题 | Pack readiness 不检查 materials 与 questionnaire 的联动 | Pack readiness：materials 必须对应至少一个 file question | P1 |
| #56 | 材料字节写入了但页面说没有 | 材料上传/审核只有单接口测试，没有“上传→审核→播放”路径 | 材料内容契约：字节写入、review 可播放/下载、内容 sniffing | P1 |
| #57 | 列表只显示 participant UUID | 读模型没有“面向人的显示字段”契约 | Read-model contract：报名/Live 列表必须投影姓名、学号、曲目 | P1 |
| #58 | 投票“启动”默认 formal | 模式默认值没有安全契约 | Mode default contract：正式写入必须显式选择 formal；默认 rehearsal | P0 |
| #59 | 浏览器身份可换设备重复投票 | Pack readiness 不检查 voting artifact 的 identityPolicy | Pack readiness：voting 必须有显式 identity policy；产品需选择票据或明示浏览器限制 | P1 |
| #60 | 排名→公示→关闭→归档走不通 | 没有 organizer 端到端 journey；API 无 Web 消费者 | Organizer journey E2E + UI consumer gap 报告 | P0 |
| #61 | 任务模板 API 存在但 Ops 无同步入口 | 没有 API→Web 消费者链路检查 | Consumer Graph：未引用的 mutation route 报告 | P0 |
| #62 | 公开码等于内部 activity id | 创建契约没有区分 public code 与 internal id | Domain/creation contract：public code 必须短、可朗读、独立于 id | P1 |
| #63 | 超长 Idempotency-Key 泄漏 SQLSTATE | API 边界没有长度前置校验；错误映射把 SQLSTATE 当领域码 | API boundary contract：header 长度、稳定错误码、永不透出 SQLSTATE | P0 |
| #64 | 缺少报名/材料/评分导出 | 只读导出没有产品和权限契约 | Export contract：权限、空数据、审计、受控 API | P2 |
| #65 | 缺少主持手卡/节目单 | 没有只读节目单的公开/现场路径 | Published program read model + E2E | P2 |

## 3. 根因分类

### 3.1 产品路径没有端到端测试

#54、#60、#61、#64、#65 都属于这一类。单个 API 正确，但组织者在 UI 上走不通。
现有 Playwright 覆盖的是公开结果、投票、Live 评分等片段，没有一条完整的
“创建 → 发布 → 名单 → 评委 → 评分 → 排名 → 公示 → 关闭 → 归档”旅程。

### 3.2 Pack 只验证能力组合，不验证产品就绪

#54、#55、#59 说明 `ActivityPack` 的 `baselineCapabilities`、`questions` 与
`definitions` 可以彼此不一致：启用了 materials 却没有 file question；启用了
competition 却没有 ticketing；提供 voting 选项却没有 voting definition。

### 3.3 读模型只验证字段存在，不验证面向人的显示

#56、#57 说明 API 返回了事实，但页面没有把事实变成可辨认、可播放的界面。测试
应该区分“数据存在”和“人能用”。

### 3.4 边界契约只覆盖成功路径

#58、#62、#63 说明默认值、标识和错误映射没有契约：默认 formal 会写错分区；
`public_code = activity.id` 会把内部标识暴露给选手；Postgres SQLSTATE 被当成
领域错误码返回。

### 3.5 文档与部署没有可执行门禁

#51、#52、#53 说明文档和 manifest 是“写给人看”的，不是“被测试执行”的。活跃
文档可以继续描述已经删除的 1.x，Compose 可以和开发基线冲突。

## 4. 本轮已落地的诊断

### 4.1 API → Web 消费者缺口

Consumer Graph 现在会提取 `apps/web/src/api/*` 的 `apiFetch` / `fetch` 调用，
把 `${...}` 段归一化为 `:param`，并与 Fastify 路由的 `:id` 参数匹配，生成
`consumes-route` 边。

新增报告：`findUnreferencedMutationRoutes`，列出没有 Web 调用方的 mutation
route。首次运行发现 **31 条**未引用 route，包括：

- `POST /api/activities/:id/tasks/sync`（#61）
- `POST /api/activities/:id/competition/podium/recompute`（#60）
- `POST /api/activities/:id/close`、`POST /api/activities/:id/archive`（#60）
- `POST /api/activities/:id/judge-entry/close`（#54/#60）
- `POST /api/activities/:id/publishing/stage-results/:stageKey/confirm`（#60）

报告是**非阻塞**的，写入 `plus/.artifacts/ui-gaps.json`；等产品路径补齐后再把
`--strict` 接入 CI。

运行：

```powershell
pnpm -C plus --filter @artflow-plus/contract-tools run graph:check
```

### 4.2 Starter Pack 就绪诊断

新增 `checkPackReadiness`，对 `SINGER_COMPETITION_PACK`、`STAGE_SHOW_PACK`、
`REVIEW_AWARDS_PACK` 检查：

- materials 能力是否存在至少一个 `type: "file"` 问卷题（#55）；
- competition 是否同时提供 ticketing 或明确替代入口（#54）；
- 暴露 voting 选项时是否有显式 voting definition / identity policy（#59）。

首次运行发现 **6 条** finding；PR #68 让 singer-competition 通过默认启用的
ticketing 问题提供评委入口后，readiness 规则也同步接受“default-on ticketing
question”作为有效路径，当前剩 **5 条**：

- singer-competition：materials 无 file question、voting identity 隐式；
- stage-show：voting identity 隐式；
- review-awards：judging 无 ticketing、voting identity 隐式。

报告写入 `plus/.artifacts/pack-readiness.json`；默认非阻塞，`--strict` 留给修复
完成后接入 CI。

运行：

```powershell
pnpm -C plus --filter @artflow-plus/contract-tools run readiness
```

## 5. 后续加固优先级

### 已关闭的产品缺口（2026-11-11 PR 处理）

- #51：PR #66 把 Compose 的 PostgreSQL 18 数据卷改到 `/var/lib/postgresql`，
  并在 `tests/gates/test_release_artifacts.py` 增加对应 gate。
- #53：PR #67 在 README、开发基线和 `plus/README.md` 记录
  `create-account` 开户步骤，并在登录页提示工作人员账号不在这里注册。
- #54：PR #68 让 singer-competition 默认启用 ticketing；Live 可生成评委入口。
- 缺口棘轮自动把已修复的 `deploy-manifest:compose.plus-db.volume-path` 与
  `pack-readiness:singer-competition:JUDGING_WITHOUT_TICKETING` 标为 stale；
  baseline 从 170 降到 168，pack findings 从 6 降到 5。

### P0：阻断发布

1. **Organizer journey E2E**：一条浏览器旅程覆盖创建、发布、名单、评委入口/
   代录、评分、排名、公示、关闭、归档。它应直接覆盖 #60、#61。
2. **API boundary contract**：Idempotency-Key 长度、稳定错误码、永不透出
   SQLSTATE；覆盖 #63。复用 `assertAuthorization` / `assertAtomicSuccess` 的
   模式，但断言在 HTTP 层。
3. **Pack readiness strict**：先修剩余 Pack 定义（#55、#59），再把
   `readiness --strict` 接入 CI。
4. **Mode default contract**：任何能写 formal 的入口必须显式选择 mode；默认
   rehearsal 或拒绝；覆盖 #58。

### P1：可用性与一致性

6. **Read-model display contract**：报名列表、Live 名单、评分表必须返回面向人
   的姓名/学号/曲目，内部 id 只能作为次要字段；覆盖 #57。
7. **Material content contract**：上传字节、审核可播放/下载、内容 sniffing；
   覆盖 #56。
8. **Active docs drift gate**：活跃文档不得描述已删除的 1.x 入口；覆盖 #52、
   #53。
9. **Public code contract**：public code 与 internal id 分离，长度和字符集可
   朗读；覆盖 #62。

### P2：产品能力

10. 报名/材料/评分/投票的受控导出（#64）。
11. 只读节目单与主持手卡（#65）。

## 6. 与任务书原则的对应

- **Consumer 定义包含 UI**：API route 没有 Web 调用方，就是消费者缺口。新增的
  `consumes-route` 边把这一点变成可查询数据。
- **Pack 是产品路径，不只是能力列表**：就绪诊断检查“启用了能力，是否也提供了
  使用它的定义”。
- **故障注入要覆盖边界**：超长 header、内容类型不符、默认 mode 误写 formal，
  都是边界故障，不是 happy path。
- **先证明再扩规模**：这 15 条就是当前验收语料。先让诊断稳定地产出，再把其中
  已修复的类别升级为阻塞门禁。
- **不制造第二套业务系统**：诊断只读取现有 Pack、路由和 Web 调用，不复制业务
  逻辑，也不 mock 数据库。

## 7. 使用方式

```powershell
Set-Location plus
pnpm --filter @artflow-plus/contract-tools run graph:check
pnpm --filter @artflow-plus/contract-tools run readiness
```

产物：

- `plus/.artifacts/consumer-graph.json`
- `plus/.artifacts/ui-gaps.json`
- `plus/.artifacts/pack-readiness.json`

这两个报告目前是**诊断**，不会让 CI 变红；它们的作用是让下一轮修复有稳定的
验收对象，并防止修好之后再次退化。
