# 事故：管理员二次验证后冻结赛制返回 HTTP 405

## 现象

管理员点“冻结赛制”时，15 分钟二次验证已过期，页面跳到管理员登录；登录成功
后浏览器打开 `/staff/rulesets/1/freeze/` 得到 `HTTP 405`。

## 触发条件

- 目标是 `@admin_required @require_POST` 的 action；
- `admin_required` 把 `next` 设为这个 POST-only URL；
- 登录后用 GET 回访该 URL。

## 根因

二次验证的恢复点被当成了“原请求 URL”，但原请求是 POST；登录后的跳转是 GET。
把“重新确认身份”实现成了“重新发送请求”。

## v1 修复

- POST 的再验证落点改为渲染表单的同 host referer；没有 referer 回 staff
  dashboard；
- 页面提示“验证已刷新，请重新点击该操作”；
- 测试覆盖有/无 referer 两种情况。

## 不变量

- 拒绝必须可恢复；恢复点必须是能安全 GET 的页面；
- 二次验证只刷新身份，不重放动作。

## 门禁

- 行为测试：`accounts.tests.AdminVerificationTTLTests`；
- 结构门禁不适用（这是交互语义）。

## Plus 要求

- 再验证流程返回一个“继续”页面或表单页，不把 POST URL 当作登录后的落点；
- 所有敏感 action 都可从同一页面重试，且不丢失用户可见的上下文。
