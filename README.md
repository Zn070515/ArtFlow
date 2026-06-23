# ArtFlow

ArtFlow 是面向学院文艺部的 Django 活动运行平台，覆盖公开门户、报名、材料收集、工作人员审核、评分、投票、导出和归档等流程。

## 技术栈

- Backend: Django
- Database: SQLite for local development, PostgreSQL for deployment
- Frontend: Django Templates + Tailwind CDN
- Export: openpyxl, python-docx

## 本地开发

```bash
uv venv
uv pip install -r requirements.txt
python manage.py migrate
python manage.py createsuperuser
python manage.py runserver
```

如果不用 `uv`：

```bash
python -m venv .venv
.venv\Scripts\activate
pip install -r requirements.txt
python manage.py migrate
python manage.py runserver
```

## 环境变量

复制 `.env.example` 并按部署环境设置变量。当前代码直接读取系统环境变量；本地不设置时默认使用 SQLite。

关键变量：

- `SECRET_KEY`
- `DEBUG`
- `ALLOWED_HOSTS`
- `DATABASE_ENGINE`
- `POSTGRES_DB`
- `POSTGRES_USER`
- `POSTGRES_PASSWORD`
- `POSTGRES_HOST`
- `POSTGRES_PORT`

## 常用命令

```bash
python manage.py check
python manage.py makemigrations --check --dry-run
python manage.py migrate
python manage.py test
python manage.py runserver
```

## 导入公开照片

按活动分好子目录后，可以批量导入往届风采照片：

```bash
python manage.py import_public_photos "d:\ProgramData\xwechat_files\wxid_sjovff3wb33o12_aa25\msg\file\2026-06\photos" --publish
```

导入会把照片复制到 `media/public/gallery/`，创建对应的往届风采文章和相册。默认跳过 `会议照片` 这类内部目录；如确实要导入，追加 `--include-internal`。

## 工作流

1. 管理员在工作人员后台创建活动，并设置为报名中。
2. 工作人员发布公开内容，首页自动展示已发布内容。
3. 选手或节目负责人注册登录后提交报名和材料。
4. 工作人员审核报名、查看材料完整性、添加内部备注。
5. 工作人员创建比赛轮次、录入纸质评分、查看排名。
6. 工作人员创建投票场次，观众输入现场口令后投票。
7. 工作人员导出报名、材料、成绩、投票和归档文件。

## GitHub SSH

远程仓库应使用 SSH：

```bash
git remote -v
git remote set-url origin git@github.com:<username>/ArtFlow.git
```

提交前至少运行：

```bash
python manage.py check
python manage.py test
```
