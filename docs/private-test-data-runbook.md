# ArtFlow 私测数据排练手册

这份手册只适用于 `SYNTHETIC_TEST_ONLY` 私测活动，不适用于正式活动、生产发布或公开结果。

## 数据边界

原始 ZIP、原始投票 Excel、原始姓名/IP 关联表只留在本机。云主机只接收经过
`scripts/verify_private_test_package.py` 校验的最小包：`02_私测夹具` 和
`07_realistic_test_addendum`。不得上传 `.env`、数据库、原始 Excel 或原始资料包。

装载器会拒绝：

- 非 TEST 活动、正式活动同名占用或 fixture provenance 不安全；
- 部分装载后继续追加；
- 直接创建 FORMAL 结果、公开发布或绕过评分/投票/票券/文件 authority；
- 活动、轮次、评委、投票会话归属不一致。

## 装载前离线校验

```powershell
python scripts/verify_private_test_package.py `
  --root C:\path\ArtFlow_2025院十佳_全量私测资料包_v3_test_ready `
  --require-sanitized-votes `
  --json-report C:\path\private-package-verification.json
```

期望边界为：15 名选手、5 名合成评委、4 轮、555 条分项评分、280 张合成票券、
P1/P2 分别 190/120 条脱敏票、60 个媒体 assignment。验证报告不得包含 raw IP、
密码或票券 token。

## 先 dry-run，再 apply

```powershell
python manage.py load_private_test_fixture `
  --root C:\path\ArtFlow_2025院十佳_全量私测资料包_v3_test_ready `
  --dry-run `
  --json-report C:\path\private-dry-run.json
```

云主机 apply 只使用专用 event service 中已存在的 Staff/Admin 操作员：

```bash
python manage.py load_private_test_fixture \
  --root /controlled/private-test/v3 \
  --activity-key zjut-info-ten-singers-2025-private-rehearsal-v2 \
  --operator-username "$ARTFLOW_TEST_OPERATOR" \
  --apply \
  --json-report /controlled/evidence/private-load.json
```

装载器会创建一项带 `private_fixture:<fixture_id>` 标记的 TEST 歌手比赛，按正式服务
完成报名、轮次、评委面板、评分、投票、票券、材料和结果闭场。`--apply` 重复运行时，
完整活动返回 `already_loaded_noop`；检测到部分数据则停止。只有明确确认 TEST 活动后，
才允许：

```bash
python manage.py load_private_test_fixture ... --apply --reset-test-runtime
```

该选项只调用既有 TEST cleanup service，不删除源数据库卷、不删除 FORMAL 数据、不执行
`docker compose down --volumes`。

## 现场还原范围

- 四轮评分通过 Judge panel/grant/session/score authority 写入；每轮 5 名候选评委中 3 名
  实到，非实到评委不产生评分单元；
- P1/P2 票通过合成票券签到、兑换和 `submit_ballot` 写入，再关闭并锁定投票；
- 3 名代表选手 × 4 轮 × 5 用途的 60 个媒体文件通过
  `store_questionnaire_file` 写入。questionnaire 的 `question_key` 是身份，技术用途由
  当前冻结问卷派生；轮次由 key 命名空间表达，不由浏览器或旧的 purpose-only 上传器传入；
- 规则冻结后按 `stage1 → stage2 → stage3` 逐段解析、核定和 materialize，不直接创建 Award
  或伪造前三；TEST 结果不进入公开发布链。

## 完成后检查

至少保留以下非敏感证据：release SHA、包 manifest/hash、activity id、各类计数、面板
expected/minimum/active 数、阶段 result version 和 input fingerprint、备份/隔离恢复结果。
不要把密码、原始 IP、原始 Excel、票券 secret 或 Judge grant token 写入报告。

清理时只对专用 TEST activity 操作，并在清理前后核对 FORMAL 计数、媒体卷、PostgreSQL
源卷和 `.env` 未变化。私测结果只能标记为内部 TEST rehearsal evidence。

## 浏览器问卷门

Compose integration gate 会在非生产容器中运行：

```bash
docker compose exec -T web python manage.py prepare_questionnaire_e2e \
  --formal-fixture \
  --output-file /tmp/artflow-questionnaire-e2e.json
```

`--formal-fixture` 是有意的显式开关：participant HTTP boundary 只允许访问 FORMAL
活动，因此浏览器要验证真实选手入口，就必须使用一项完全合成、仅存在于临时 CI 数据库
中的 FORMAL activity。命令在 `APP_ENV=production` 下始终拒绝执行；它不放宽 TEST
活动的 participant 访问规则，也不改变正式活动的生命周期服务。

`tests/e2e/questionnaire-flow.spec.ts` 覆盖真实浏览器的：登录 → canonical questionnaire
entry → draft 自动保存 → question-key 文件上传 → 提交 → 报名开放期间修订。关闭后补交
的服务/权限边界由 `questionnaire.test_form`、`questionnaire.test_entry` 和
`files.test_questionnaire_uploads` 覆盖；Docker/PostgreSQL 运行证据仍必须以
integration workflow 的实际结果为准。

2026-09-29 本机在 `DEBUG=False`、重新 `collectstatic` 后使用 Chromium 完成该浏览器链；
本机 Docker daemon 不可用，因此未将本地结果冒充 Compose/PostgreSQL 证据。

## 本机真实包集成门

真实 v3 包不进入仓库。需要运行包级 Django 集成门时，通过环境变量指向本机已校验的
目录，然后执行：

```powershell
$env:ARTFLOW_PRIVATE_FIXTURE_ROOT = "C:\path\ArtFlow_2025院十佳_全量私测资料包_v3_test_ready"
uv run python manage.py test common.test_private_test_loader.PrivateFixturePackageIntegrationTests
```

该测试断言 15 个报名、15 个问卷 response、60 个当前 question-key 文件、60 个媒体
检查项、555 条 criterion score、280 张票券、310 张票及 `stage1/2/3` 三段 confirmed，
并验证重复 apply 返回 `already_loaded_noop`。环境变量未设置时测试跳过，不会从 Git 或
CI 工作区寻找私测原始数据。
