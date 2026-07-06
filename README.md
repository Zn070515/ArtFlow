# ArtFlow

面向学院文艺部的 Django 活动运行平台。覆盖公开门户、报名、材料收集、工作人员审核、评分、投票、二维码、Word 推文生成、导出和归档等全流程。

**24 个模型 | 67 个视图 | 67 条路由 | 44 个模板 | 13 个 Django App**

## 快速开始

```bash
uv venv
uv pip install -r requirements.txt
python manage.py migrate
python manage.py seed_data            # 一键造测试数据（admin/admin123）
python manage.py runserver
```

然后访问 `http://localhost:8000/staff/`，用 **admin / admin123** 登录。

## 技术栈

- **后端**: Django 6.0（单体，非微服务）
- **数据库**: SQLite（开发），PostgreSQL（部署）
- **前端**: Django Templates + Tailwind CSS CDN + Alpine.js
- **导出/生成**: openpyxl（Excel）、python-docx（Word）、qrcode（二维码 PNG）

## 已实现功能

### 公开门户
- 首页聚合：活动入口、通知公告、往届风采、结果公示、活动照片
- 文章类型：通知公告、往届风采、活动回顾、报名入口、投票入口、结果公示、普通文章
- 置顶、排序、关联活动、封面图、草稿/发布/隐藏

### 活动管理
- 3 种活动类型（歌手比赛/毕晚/普通活动），10 个阶段状态机
- 创建/编辑（仅管理员）、测试模式切换、清空测试数据、克隆活动
- 活动级锁定/解锁（管理员专属），自动写入操作日志

### 用户与权限
- 注册（选手）/ 登录（选手入口）/ 管理员登录（独立入口 + 密钥验证）
- 三种角色：admin / staff / participant
- `@staff_member_required` + `_require_admin` 双重守卫
- 开重定向修复、CSRF 保护登出、文件 20MB 上传限制

### 歌手比赛报名
- 完整报名表（姓名/学号/学院/手机/微信/曲目/原创）
- 6 种赛前状态（草稿→提交→待补充→通过→拒绝→撤回）
- 11 种赛中状态（签到→候场→表演→录分→复核→晋级/淘汰→弃赛→延后）
- 伴奏/视频文件上传，材料检查清单自动同步

### 毕晚节目管理
- 6 种节目类型，5 种审核状态，手动排序
- 负责人/演员/时长/麦克风/道具/备注
- 材料检查清单自动同步

### 比赛评分
- 初赛/复赛轮次，平均分/去最高最低平均 两种计分模式
- 评分网格录入（歌手 × 评委矩阵），自动重算排名和晋级
- 评分表 Excel 模板下载 + Excel 批量导入（含格式/范围/存在性校验）
- 轮次锁定/解锁（管理员解锁需备注）
- 奖项颁发

### 观众投票
- 投票场次：口令 + 时间窗口 + 单选/多选 + 最多可选数
- 公开投票页（无需登录）：扫码→输口令→选人→提交
- 防刷：口令 + 时间窗口 + 浏览器 session 去重 + IP 记录
- 后台：开/关投票、锁定/解锁结果、实时票数、Excel 导出

### 二维码中心
- 每个活动生成报名/投票/结果公示三类二维码
- 动态生成 PNG（qrcode 库），页面展示 + 下载

### 导出中心
- **Excel 导出**：报名名单、联系方式表、材料清单、节目单、评分模板、异常记录、投票结果、获奖名单
- **Word 生成**：9 种模板类型，占位符替换 → `.docx`，python-docx
- **执行包**：5 个 Excel 打包为 ZIP
- **归档包**：Excel + Word 文档打包为 ZIP
- **Excel 导入**：评分表批量导入（校验选手/评委/分数/重复）

### 异常记录 & 操作日志
- 6 种异常类型（分数争议/投票异常/弃赛/设备问题/信息错误/其他）
- 16 种操作日志类型，自动记录操作人+IP
- 日志查看页面（最近 200 条）

## 本地开发

```bash
uv venv
uv pip install -r requirements.txt
python manage.py migrate
python manage.py seed_data
python manage.py runserver
```

无 uv 时：

```bash
python -m venv .venv
.venv\Scripts\activate
pip install -r requirements.txt
python manage.py migrate
python manage.py runserver
```

## 环境变量

复制 `.env.example` 设置。关键变量：`SECRET_KEY`、`ADMIN_LOGIN_KEY`、`DEBUG`、`DATABASE_ENGINE`、`POSTGRES_*`。

## 常用命令

```bash
python manage.py check
python manage.py makemigrations --check --dry-run
python manage.py migrate
python manage.py test
python manage.py seed_data          # 重新造测试数据
python manage.py changepassword admin
python manage.py runserver
```

## 工作流

1. 管理员创建活动并设置为报名中
2. 工作人员发布公开内容，首页自动展示
3. 选手/节目负责人注册后提交报名和材料
4. 工作人员审核报名、查看材料完整性、添加内部备注
5. 工作人员创建比赛轮次、录入评分、查看排名
6. 工作人员创建投票场次 → 观众扫码输口令投票
7. 导出现场执行包/归档包、生成 Word 推文

## GitHub SSH

```bash
git remote set-url origin git@github.com:<username>/ArtFlow.git
```

提交前至少 `python manage.py check` + `python manage.py test`。
