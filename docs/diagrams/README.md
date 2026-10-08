# 流程图 · Diagrams

本目录保存 README 中全部流程图的**渲染产物**与**图源定义**：

| 文件 | 说明 |
|---|---|
| `NN-*.svg` | 渲染产物。自适应当前配色方案（`prefers-color-scheme`），可直接嵌入 Markdown。 |
| `NN-*.workflow.json` | 流程 / 泳道图的图源定义（archify workflow schema v2）。 |
| `NN-*.architecture.json` | 模块全景图的图源定义（archify architecture schema v1）。 |

图源是唯一事实来源：`svg` 由 `json` 生成，不要手工编辑 `svg`。

## 图集

| 编号 | 主题 | 图源类型 |
|---|---|---|
| `01-activity-lifecycle` | 活动生命周期：从测试活动到结果公示 | workflow |
| `02-ruleset-questionnaire-registration` | 规则集 — 问卷 — 报名 | workflow |
| `03-live-contest-operations` | 现场比赛运行 | workflow |
| `04-result-authority-release` | 结果权威与发布 | workflow |
| `05-deployment-and-fallback` | 部署与降级 | workflow |
| `06-role-handbook` | 角色使用手册总览 | workflow |
| `07-role-participant` | 选手使用手册 | workflow |
| `08-role-staff` | 工作人员使用手册 | workflow |
| `09-role-admin` | 管理员使用手册 | workflow |
| `10-role-judge` | 评委使用手册 | workflow |
| `11-role-audience` | 观众使用手册 | workflow |
| `12-module-map` | 前后端模块全景 | architecture |

## 生成方式

图源由 [archify](https://github.com/tt-a1i/archify) **v3.0.1** 生成与校验。每个节点与连边都声明了 `sources`（仓库路径 + 行号区间），因此图与代码是**可核对的**，不是示意图：`validate` 打开 `--repo-root` 时会逐条比对被引用的文件在**固定提交**上确实存在该行。

图源里记录的固定提交是：

```
a093d581dcd579ecb42c413c0936766a2c1553da
```

改动被引用的函数后，图源需要重新核对：**图中每一个 `sources` 都要在改动后的代码里重新定位**，然后再跑一遍校验。校验不会替你判断语义是否仍然正确。

### 1. 校验图源

```bash
node <archify>/bin/archify.mjs validate workflow  docs/diagrams/08-role-staff.workflow.json \
  --repo-root <artflow-repo> --quality showcase
node <archify>/bin/archify.mjs validate architecture docs/diagrams/12-module-map.architecture.json \
  --repo-root <artflow-repo> --quality showcase
```

`--quality showcase` 要求零告警通过。

### 2. 出图并跑完门禁

```bash
node <archify>/bin/archify.mjs finalize workflow docs/diagrams/01-activity-lifecycle.workflow.json \
  /tmp/archify-out/01-activity-lifecycle.html \
  --repo-root <artflow-repo> --quality showcase --out-dir /tmp/archify-out
```

`finalize` 内部依次执行 `validate` → `deliver` → `check`（严格 provenance）→ `browser-check`（真实浏览器），并输出回执。任一门禁不通过就不要替换产物。

### 3. 导出可嵌入的 SVG

SVG 不能手工从 HTML 里抠出来：图里的颜色来自样式表里的 CSS 自定义属性，直接抽取会得到一份**没有任何样式**的 XML。

正确做法是使用产物自带的导出项 —— 在浏览器里打开生成的 HTML，点击工具栏的 **Export → SVG**（对应 DOM 中的 `button[data-format="svg"]`）。这个导出项会写成**双主题** SVG：默认暗色，`@media (prefers-color-scheme: light)` 时切换为亮色，并自行铺底，因此在 GitHub 的亮色与暗色界面下都能正常显示。

自动化时用 Playwright 驱动同一个按钮即可，不要重新实现导出逻辑。

## 约定

- 产物用 SVG 而不是 PNG：文本可选中、可检索、体积可控，且随读者的配色方案自动切换。
- 每张图只讲一件事。`mainPath` 必须是连续的主干；分支、HOLD 与降级单独成支，不并入主干。
- 图里出现的每一条业务断言都应当能在图源的 `sources` 里找到对应的代码位置。**写不进来源的断言，就不要画进去。**
