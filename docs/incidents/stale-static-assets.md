# 事故：重建镜像后仍服务旧静态资源

## 现象

镜像里已经是新的 `rapid_score.js`（包含 ArrowUp），但页面仍加载旧的哈希文件；
容器内 `/app/staticfiles` 与 `/app/static` 不一致。

## 触发条件

- `STATIC_ROOT` 是持久卷；
- 新镜像的源文件 mtime 比卷里上次收集的副本旧；
- `collectstatic` 默认跳过“目标比源新”的文件。

## 根因

部署把“镜像版本”和“收集产物”当成同一件事，但它们是两个可独立漂移的层。
`collectstatic` 的 mtime 比较让旧产物永久胜出。另一个同源问题是 `media` /
`realtime` worker 没挂载 static manifest，渲染错误页时把 404 变成 500。

## v1 修复

- entrypoint 改为 `collectstatic --noinput --clear`；
- `media` / `realtime` 只读挂载 `static_data:/app/staticfiles:ro`；
- compose 契约测试断言这两个 worker 都有 manifest。

## 不变量

- DEPL-02：客户端产物必须与服务器版本一致；
- DEPL-04：所有渲染 Django 模板的进程共享同一份 manifest。

## 门禁

- `tests/gates/test_release_artifacts.py`：entrypoint 必须 `--clear`，media/
  realtime 必须挂载 static。

## Plus 要求

- 构建产物带版本；部署替换而不是叠加；
- 启动时证明 `served bundle hash == image bundle hash`；
- 错误页渲染器与主应用共享同一套静态产物。
