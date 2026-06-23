# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

ArtFlow is a Django-based activity management platform for a university student arts department (文艺部). It covers event publicity, registration, material collection, live scoring, audience voting, results publishing, Word document generation for WeChat, and archiving — all in one system.

Read `GOAL.md` for the full specification. Every change should be checked against it.

## Tech Stack

- **Backend**: Django (monolith, no microservices)
- **Database**: PostgreSQL
- **Frontend**: Django Templates + Tailwind CSS + Alpine.js / HTMX
- **Export**: openpyxl (Excel), python-docx/docxtpl (Word), qrcode (QR codes)
- **Deployment**: Docker Compose, Nginx or Caddy

## Python 版本与依赖管理

### Python 版本选择

项目开始前，先用 `where.exe python` 探查系统中可用的 Python 版本：

```bash
where.exe python
python --version
python3 --version
py --list   # 如果安装了 py launcher
```

选择原则：

1. Django 5.2 LTS 要求 Python >= 3.10（Django 6.0 将要求 >= 3.12）
2. 优先选择当前系统已安装的稳定版本（3.11 或 3.12 均可）
3. 避免选择过于陈旧的版本（< 3.10）或刚发布的最新版（可能有无兼容包的生态滞后）
4. 确认 `python` 命令指向的 Python 版本，避免与系统自带 Python 冲突（Windows 应用商店版的 Python 可能有问题）

检查关键包兼容性后再锁定版本：

```bash
python -c "import sys; print(sys.version)"
```

### 依赖管理：uv vs 原生 python -m venv

先检查 `uv` 是否已安装：

```bash
where.exe uv
uv --version
```

**如果 uv 已安装（推荐使用）：**

```bash
uv venv                     # 创建虚拟环境
uv pip install django       # 安装包（兼容 pip，但更快）
uv pip install -r requirements.txt
uv pip freeze > requirements.txt
```

**优势**：安装速度快 10-100x，自动管理 pip/setuptools，跨平台一致。

**如果未安装 uv**，优先考虑安装它（`pip install uv` 或 `powershell -c "irm https://astral.sh/uv/install.ps1 | iex"`）。若不安装，则用原生方案：

```bash
python -m venv venv                          # 创建虚拟环境
venv\Scripts\activate                        # 激活（Windows）
pip install django                           # 安装包
pip install -r requirements.txt
pip freeze > requirements.txt
```

**注意**：
- 无论用哪种方案，虚拟环境目录 `venv/` 必须加入 `.gitignore`
- `requirements.txt` 中不要固定具体平台 wheel（`@ file://...`），保持跨平台
- 不要在项目根目录裸跑 `pip install`；始终先激活虚拟环境

## Core Design Principles

1. **Final architecture first** — Design complete models/permissions/routes up front; implement in phases. Never write throwaway pages.
2. **Monolith, not microservices** — One Django project, modular apps.
3. **No hardcoded data in templates** — All public content is DB-driven via `PublicPost` model.
4. **Permissions must be enforced** — Guest / Participant / Staff / Admin. Never skip permission checks for speed.
5. **Files never stored in DB** — Use Django's FileField with proper access control.
6. **Audit logging** — All staff/admin mutations must be logged.

## App Structure (planned)

```
accounts/        — Users, login, roles
core/            — Activities, phases, base config
public_portal/   — Homepage, showcases, announcements, results
files/           — Uploads, material requirements, completeness checks
singer_contest/  — Singer competition: rounds, scoring, ranking
farewell_show/   — Graduation gala: program submissions, program list
voting/          — Audience voting (QR code + on-site passcode)
exports/         — Excel, Word, zip export and import
archive/         — Event archive packages, archive index
incidents/       — Incident/anomaly records
staff_panel/     — Staff backend dashboard
common/          — Shared utilities
```

## Key Models (to be designed before any views)

User, Activity, ActivityPhase, PublicPost, Registration, Program, SubmissionFile, MaterialRequirement, MaterialCheck, StaffNote, ContestRound, Judge, ScoreRecord, ScoreSummary, Award, VoteSession, VoteOption, VoteRecord, QRCodeLink, ExportTask, ArticleTemplate, GeneratedDocument, IncidentRecord, AuditLog, ArchivePackage

## MVP Phases

1. **Phase 1**: Django init, user auth, roles, Activity/PublicPost models, public homepage, staff panel layout
2. **Phase 2**: Registration (singer + farewell), file uploads, material checks, staff review, Excel export
3. **Phase 3**: Singer contest scoring — rounds, score entry, ranking, awards, result locking
4. **Phase 4**: Audience voting — sessions, QR codes, passcodes, live results
5. **Phase 5**: QR center, execution packages, archive packages, Word generation, activity cloning, test mode

## Development Commands

```bash
# Start dev server
python manage.py runserver

# Database migrations
python manage.py makemigrations
python manage.py migrate

# Create superuser
python manage.py createsuperuser

# Run tests (all)
python manage.py test

# Run tests (single app)
python manage.py test accounts

# Run tests (single file)
python manage.py test accounts.tests.test_views

# Run tests (single test method)
python manage.py test accounts.tests.test_views.TestLoginView.test_valid_login

# Shell
python manage.py shell

# Check for pending migrations
python manage.py showmigrations

# Docker
docker-compose up -d
docker-compose down
docker-compose logs -f
```

## Visual Standards

- White/light gray backgrounds, black-white-gray palette with minimal accent color
- Clean, real, university-official feel — not AI-generated SaaS landing page style
- No: exaggerated gradients, glassmorphism, glowing borders, cyberpunk, filler marketing copy
- Reference: university websites, Notion, Linear, GitHub

## Git / GitHub 工作流要求

本项目必须从一开始使用 Git 管理代码，并同步到 GitHub 远程仓库。

不要等项目写完再初始化 Git。

不要长时间本地堆代码不提交。

不要一次性提交大量无关改动。

---

### 1. GitHub 仓库创建

项目开始时，优先使用 GitHub CLI 创建远程仓库。

先检查 GitHub CLI 是否可用：

```bash
gh --version
gh auth status
```

如果尚未登录：

```bash
gh auth login
```

创建仓库时使用：

```bash
gh repo create ArtFlow --private --source=. --remote=origin --push
```

如果用户明确要求公开仓库，再改为：

```bash
gh repo create ArtFlow --public --source=. --remote=origin --push
```

默认仓库名：

```text
ArtFlow
```

默认主分支：

```text
main
```

---

### 2. SSH 推送要求

GitHub 推送必须优先使用 SSH，不使用 HTTPS。

测试连接：

```bash
ssh -T git@github.com
```

远程地址必须是 SSH 格式：

```bash
git remote set-url origin git@github.com:<username>/ArtFlow.git
```

禁止使用这种 HTTPS 远程地址：

```text
https://github.com/<username>/ArtFlow.git
```

---

### 3. Git 初始化流程

如果项目还没有 Git：

```bash
git init
git branch -M main
```

必须创建 `.gitignore`。

至少忽略：

```gitignore
# Python
__pycache__/
*.py[cod]
*.pyo
*.pyd

# Virtual environment
venv/
.venv/

# Django
*.log
local_settings.py
db.sqlite3
media/
staticfiles/

# Env
.env
.env.*
!.env.example

# IDE
.vscode/
.idea/

# OS
.DS_Store
Thumbs.db

# Node / Tailwind
node_modules/
dist/
```

注意：

* `.env` 不能提交。
* 数据库文件不能提交。
* 用户上传的媒体文件不能直接提交。
* 生成的导出文件、归档包、临时 zip 不要提交。
* 必须提交 `.env.example`，说明需要哪些环境变量。

---

### 4. 初始提交内容

第一次提交至少包含：

```text
GOAL.md
CLAUDE.md
README.md
.gitignore
requirements.txt 或 pyproject.toml
基础 Django 项目结构
```

初始提交命令：

```bash
git add .
git commit -m "chore: initialize ArtFlow project"
git push -u origin main
```

---

### 5. 每完成一个小功能就提交一次

必须保持小步提交。

推荐粒度：

```text
一个模型设计完成 → 提交
一个页面能打开 → 提交
一个表单能提交 → 提交
一个权限检查完成 → 提交
一个导出功能完成 → 提交
一个 bug 修复完成 → 提交
```

不要把多个无关功能放在一次提交里。

错误示例：

```text
feat: finish many things
update files
fix
wip
```

推荐提交信息：

```text
feat: add public post model
feat: add staff dashboard layout
feat: add singer contest registration form
feat: add audience vote session model
fix: prevent participants from viewing other submissions
fix: validate score range before saving
chore: update gitignore for generated exports
docs: update setup instructions
```

---

### 6. 每次提交后必须立即 push

规则：

> 每一次 commit 后，都要立即 push 到 GitHub。

标准流程：

```bash
git status
git add .
git commit -m "<type>: <message>"
git push
```

不要本地积累很多 commit 不推送。

不要只 commit 不 push。

不要只修改不 commit。

---

### 7. 每次 push 后自动触发 /code-review

每次代码推送到 GitHub 后，必须立即执行一次代码审查流程。

如果当前开发环境支持 Claude Code 的 `/code-review` 命令，则每次 push 后执行：

```text
/code-review
```

代码审查重点：

```text
1. 是否违反 GOAL.md
2. 是否违反 CLAUDE.md
3. 是否破坏最终完整版架构
4. 是否写了临时垃圾代码
5. 是否跳过权限检查
6. 是否把数据写死到模板
7. 是否有明显安全问题
8. 是否有数据库迁移问题
9. 是否有文件权限问题
10. 是否有未处理的表单校验
11. 是否有重复代码
12. 是否有 UI 过度 AI 味
13. 是否影响已有功能
```

---

### 8. /code-review 后必须修复问题

如果 `/code-review` 发现问题，必须按优先级修复。

优先级：

```text
P0：安全、权限、数据损坏、无法运行
P1：核心功能错误、测试失败、迁移错误
P2：结构不清晰、重复代码、可维护性问题
P3：UI 细节、文案、体验优化
```

修复后再次执行：

```bash
git status
git add .
git commit -m "fix: address code review issues"
git push
```

然后再次执行：

```text
/code-review
```

直到没有 P0/P1 问题。

不要忽略 code review 发现的权限、安全、数据问题。

---

### 9. 每次提交前必须运行基础检查

每次提交前至少运行：

```bash
python manage.py check
python manage.py test
```

如果测试还没写完整，也至少运行：

```bash
python manage.py check
python manage.py makemigrations --check --dry-run
```

如果有前端构建步骤，也要运行对应检查。

禁止在明显报错状态下提交，除非提交信息明确说明是临时 WIP，并且该提交不能作为稳定版本。

一般情况下不要提交 WIP。

---

### 10. 分支策略

第一阶段可以简单使用：

```text
main
```

但 `main` 必须保持可运行。

如果要开发较大的功能，使用短期功能分支：

```bash
git checkout -b feat/public-portal
git checkout -b feat/singer-registration
git checkout -b feat/audience-voting
git checkout -b fix/score-locking
```

功能完成后合并回 main：

```bash
git checkout main
git merge feat/public-portal
git push
```

如果暂时不使用 Pull Request，也必须保证每次合并后运行检查和 `/code-review`。

---

### 11. Git 提交类型规范

提交信息使用英文，保持清楚。

推荐类型：

```text
feat: 新功能
fix: 修复问题
docs: 文档
style: 样式调整，不影响逻辑
refactor: 重构，不改变功能
test: 测试
chore: 工程配置
security: 安全修复
```

示例：

```text
feat: add homepage public post list
feat: add registration material checklist
fix: restrict file access to owners and staff
fix: prevent locked scores from staff edits
docs: update deployment guide
chore: configure postgres in docker compose
```

---

### 12. 禁止提交的内容

不要提交：

```text
.env
真实密码
数据库文件
用户上传文件
导出的 Excel
导出的 Word
归档 zip
本地虚拟环境
缓存文件
SSH key
API token
阿里云密钥
GitHub token
```

如果误提交敏感信息，必须立即：

```text
1. 停止继续开发
2. 删除敏感信息
3. 重新生成泄露的密钥或 token
4. 清理 Git 历史
5. 再继续开发
```

---

### 13. README 必须包含 Git 使用说明

README.md 至少包含：

```text
1. 项目简介
2. 技术栈
3. 本地开发环境搭建
4. 环境变量说明
5. 数据库迁移
6. 创建管理员
7. 启动开发服务器
8. GitHub SSH 推送说明
9. 基础测试命令
10. 部署说明
```

---

### 14. 每次开发汇报必须包含 Git 状态

Claude 每次完成开发后，必须报告：

```text
1. 当前分支
2. 最新 commit hash
3. 是否已 push
4. 是否已运行 /code-review
5. code review 发现了什么
6. 已修复什么
7. 还有哪些问题
```

格式示例：

```text
Git status:
- Branch: main
- Commit: a1b2c3d
- Pushed: yes
- Code review: completed
- Fixed after review: permission check for staff-only score editing
- Remaining issues: none
```

---

### 15. 最终要求

Git 工作流不是可选项。

每个功能都必须遵循：

```text
实现功能
→ 本地检查
→ git commit
→ git push
→ /code-review
→ 修复问题
→ 再次 commit
→ 再次 push
```

目标：

> 让 ArtFlow 从第一天开始就是一个可追踪、可回滚、可审查、可持续维护的真实项目，而不是一堆本地临时代码。
