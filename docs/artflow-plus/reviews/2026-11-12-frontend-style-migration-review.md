# 前端样式迁移 Review 与修复

状态：已完成修复（2026-11-12）。
范围：`pre-frontend-migration..HEAD`，104 个文件，+6538 / −1733。
方法：high 强度 code review + 逐条验证；修复后重跑 web tests、typecheck、build、Portal/Console E2E。

## 结论

这轮迁移的结构成立，但 high review 找到 1 个 P0（主题变量在 `:root` 解析失效）和若干尺寸/语义/依赖问题。全部已修复或记录为明确的例外。

## 发现与处理

| # | 严重度 | 问题 | 处理 |
| ---: | --- | --- | --- |
| 1 | **P0** | `legacy-aliases.css` 在 `:root` 引用 `--color-*`，而主题只声明在 shell 的 `[data-theme]` 上，导致 `--ink/--gold/--bone/--line` 在根节点为 guaranteed-invalid；Portal body、hero 高亮、`.field` 边框等丢失颜色 | `themes.css` 的 `:root` 与 `[data-theme="afterglow"]` 同时定义默认主题；legacy aliases 改为 `:is([data-theme=...])` 主题作用域；`.app-shell` 显式设置 `background/color`；新增 root/alias 回归测试 |
| 2 | P1 | `.console-page :is(button, ...) { min-height:40px }` 压过 `.ui-button--sm { height:32px }`，所有 small 按钮实际 40px | 增加 `.console-page .ui-button--sm { min-height:32px; height:32px }` |
| 3 | P1 | `.ui-button` 未重置 `text-decoration`，`<Link>` 按钮带下划线 | `.ui-button` 增加 `text-decoration: none` |
| 4 | P1 | Judge 认领失败从 `role="alert"` 错误面板降级为无 live region 的 EmptyState | 改回 `ErrorState`（`role="alert"`） |
| 5 | P2 | Workspace 迁移到 `Card` 时丢掉 `aria-labelledby`，section landmark 无名 | `WorkspaceNextAction` / `WorkspaceProgress` 把 `aria-labelledby` 传给 `Card` |
| 6 | P2 | 重写 contrast 测试时删除了 Portal 最低强调文字的对比度与消费断言 | 重新加入 `--color-text-subtle` 对比度 + `.footnote`/`.site-footer` 消费 `--bone-subtle` 的断言 |
| 7 | P2 | `.ui-page-title` / `.ui-page-meta` 定义在 `ops.css`，却被 5 个 surface 使用 | 移到 `ui.css`，与 primitive 同属一个 partial |
| 8 | P2 | Afterglow 的 `--color-warning` / `--color-danger` 使用裸 hex，违反 primitive → semantic 两层规则 | 新增 `--p-amber-300`、`--p-red-300`，semantic 改为引用 primitive |
| 9 | P2 | Geist、Noto Serif SC、Instrument Serif 已安装但未导入；`--font-display` 指向未加载的字族；新增依赖使用 `^` 范围 | 移除未使用的 Geist；导入 Instrument Serif 与 Noto Serif SC；所有新增 Fontsource 包改为精确版本 |
| 10 | P2 | Voting Adapter 284 行，超过文档中的 ≤150 行 | 记录例外：简单 Adapter ≤150；含 release/session fixture 的有状态 Provider ≤300（ticketing 269、voting 284）；fixture 已提取 |

## 验证

- web **186 tests**（66 files）通过；
- typecheck、production build 通过；
- Portal/Console E2E **7 passed**：`console-shell`、`ops-responsive`、`public-results`（3）、`vote-page`（2）；
- contract-tools **105 tests** + voting contract **8 tests** 通过；
- 文档门禁通过。

## 后续状态（2026-11-12）

- **已解决**：Portal 展示字族改为 `PortalShell` 挂载时动态 import；Console 主包不含 Instrument Serif / Noto Serif SC，构建产物中是独立的 CSS chunk。
- **已补**：token sheet 增加 1440/390 Playwright 像素基线（平台中立 snapshot，5% 容差）；Ops 保留 1440/1024/390 布局断言。
- **仍待**：其他页面的逐像素基线；`impact` job 的阻塞化需要 2 周误报率数据。
