# 事故：撤销后的正式结果媒体仍可匿名访问

## 现象

结果 release 撤销后，正式结果页已经 404，但旧的封面/结果海报仍可通过
`/media/...` 匿名访问；页面上传的“错误结果”海报比正式结果活得更久。

## 触发条件

- `RESULT_PUBLICATION` 文章有 ACTIVE release；
- 其 editorial cover/PublicMedia 仍属于 `published_public()`；
- 受控媒体网关按“父 post 可公开”推导子资产可公开。

## 根因

把“文章可见”当成了“文章的所有资产可见”。发布快照只定义了正式结果，却没有
定义哪些自由上传资产属于公开面。

## v1 修复

- `controlled_media()` 只服务非结果类公开文章的 editorial 资产；
- 正式结果海报需要 release-owned 资产，而不是重新放开自由上传；
- 回归覆盖 ACTIVE/REVOKED/SUPERSEDED 均 404，普通公告仍 200。

## 不变量

- AUTH-07：父对象可见性不自动扩展到子资产；
- RES-05：结果媒体不因 release 变为匿名可读。

## 门禁

- `tests/gates/test_media_gate.py`：唯一受控媒体路由；
- Golden fixture：`tests/golden/result-release-lifecycle.json`（结果出口）；
- 媒体网关行为测试（v1）。

## Plus 要求

- 公开 read model 明确列出可公开字段；
- 媒体资产有独立 authority，与父对象状态解耦；
- 任何“public post 的附件”推导都必须经过资产自己的策略。
