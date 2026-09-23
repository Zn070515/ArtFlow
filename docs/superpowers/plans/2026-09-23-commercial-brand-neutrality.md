# Commercial Brand Neutrality Implementation Plan

> Execution note: this plan was executed inline in the current repository checkout, in accordance with `AGENTS.md`; no subagents or linked worktrees were used. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove institution-specific school/college branding from ArtFlow runtime surfaces while making an optional purchaser organization name configurable, without changing the “院十佳” domain fixtures or business authority.

**Architecture:** Add one deployment-level `ARTFLOW_ORGANIZATION_NAME` setting and a small template context processor. Runtime templates use the configured organization when present and generic ArtFlow copy otherwise; Word export uses the same setting for its sign-off. Historical domain names such as “院十佳” remain untouched because they are reusable contest/ruleset fixtures rather than institutional identity.

**Tech Stack:** Django settings/context processor, Django `TestCase`, Word document rendering, Markdown/PowerShell documentation checks, locked Python/Node toolchain.

**Spec:** User instruction: remove Zhejiang University of Technology / Information Engineering College identity, retain “院十佳”, and prepare for commercial packaging.

## Global Constraints

- Do not remove or rename `院十佳`, 2025 golden/shadow assets, ruleset templates, or their tests.
- Do not remove the generic registration field `学院`; it is participant data, not product branding.
- Do not change authority, permissions, result release, scoring, migration, or database behavior.
- The default runtime must contain no school-specific name and must remain useful when `ARTFLOW_ORGANIZATION_NAME` is empty.
- Organization text is escaped by Django templates and is used only as branding/sign-off, never as an authority input.
- Every logical change is a small conventional commit with a focused gate before commit.

---

### Task 1: Add failing branding regression tests

**Files:**
- Modify: `config/tests.py`
- Modify: `public_portal/tests.py`
- Modify: `staff_panel/tests.py`
- Create: `scripts/tests/test_commercial_brand_contract.py`

**Interfaces:**
- Consumes: the future `config.context_processors.artflow_branding`, `settings.ARTFLOW_ORGANIZATION_NAME`, public home rendering, and Word export rendering.
- Produces: tests that fail against the current hard-coded school identity and protect the retained `院十佳` fixture boundary.

- [ ] **Step 1: Write the failing tests**

Add tests that:

```python
from config.context_processors import artflow_branding

def test_branding_context_has_generic_default_and_accepts_customer_name():
    with override_settings(ARTFLOW_ORGANIZATION_NAME=""):
        assert artflow_branding(None)["artflow_organization_name"] == ""
    with override_settings(ARTFLOW_ORGANIZATION_NAME="示例主办方"):
        assert artflow_branding(None)["artflow_organization_name"] == "示例主办方"
```

Add a public home assertion that the rendered base/home response contains neither `浙江工业大学` nor `信息工程学院`, and that a configured `ARTFLOW_ORGANIZATION_NAME` appears. Add a Word rendering assertion that the default `{sign_off}` is generic and a configured organization is used. Add a static contract test that only the runtime brand files (`templates/base.html`, `templates/public_portal/home.html`, `exports/services.py`) contain no institution-specific strings, while the repository still contains the `院十佳` golden marker.

- [ ] **Step 2: Run only the new tests to verify the expected red state**

Run:

```powershell
uv run python manage.py test config.tests public_portal.tests.PublicPortalVisibilityTests staff_panel.tests.WordGenerateArchiveAuthorityTests
uv run pytest -q scripts/tests/test_commercial_brand_contract.py
```

Expected: the new branding assertions fail because the current runtime still emits institution-specific text; no unrelated test should fail.

### Task 2: Implement one configurable, generic brand boundary

**Files:**
- Create: `config/context_processors.py`
- Modify: `config/settings.py`
- Modify: `templates/base.html`
- Modify: `templates/public_portal/home.html`
- Modify: `exports/services.py`
- Modify: `.env.example`

**Interfaces:**
- Consumes: `ARTFLOW_ORGANIZATION_NAME` from the process environment.
- Produces: `artflow_organization_name` in every template context and a shared generic/export sign-off fallback.

- [ ] **Step 1: Add the minimal setting and context processor**

Define `ARTFLOW_ORGANIZATION_NAME = os.environ.get("ARTFLOW_ORGANIZATION_NAME", "").strip()` in settings and return it from `artflow_branding(request)`. Register the context processor in `TEMPLATES`. Do not validate it as an activity, user, or authority field.

- [ ] **Step 2: Replace only institutional presentation strings**

Use a conditional in the base shell and public hero: show `artflow_organization_name` when configured, otherwise generic text such as `活动运营平台`. In `render_document_bytes()`, replace the hard-coded school sign-off with the configured name or `ArtFlow 活动运营平台`. Preserve all activity titles, stage keys, `院十佳` rules, and participant `学院` fields.

- [ ] **Step 3: Document the optional deployment value**

Add `ARTFLOW_ORGANIZATION_NAME=` to `.env.example` with a comment explaining that it is optional presentation branding and must not be used for authority, tenant, or permission decisions.

- [ ] **Step 4: Run the new tests to verify green**

Run the Task 1 commands and require all branding tests and existing selected classes to pass.

### Task 3: Remove direct institution identity from active product documentation

**Files:**
- Modify: `GOAL.md`
- Modify: `README.md` only if the final search finds an institution-specific name there.

**Interfaces:**
- Consumes: the generic brand boundary from Task 2.
- Produces: commercial-facing active documentation that describes reusable ArtFlow without naming a specific school or domain; historical “院十佳” references remain.

- [ ] **Step 1: Replace direct school identity, not reusable domain language**

Change the GOAL opening from the named Information Engineering College scenario to a generic “学院十佳歌手及主办方文艺部门” scenario, and change the `zjut.edu.cn` example to “任何特定学校域名”. Leave `院十佳`, 2025 golden/shadow headings, school-onboarding responsibilities, and generic `学校/学院` governance language intact.

- [ ] **Step 2: Run the scoped identity scan**

Run:

```powershell
rg -n -i --hidden --glob '!\.git/**' --glob '!media/**' --glob '!staticfiles/**' "浙江工业大学|浙江工业|信息工程学院|zjut\.edu\.cn|ZJUT" .
rg -n "院十佳" GOAL.md README.md ruleset templates public_portal common staff_panel
```

Expected: the first command returns no direct institutional identity in active runtime/product surfaces; the second command still returns retained domain/golden references.

- [ ] **Step 3: Commit the documentation cleanup**

```powershell
git diff --check
git add GOAL.md README.md
git commit -m "docs: remove institution-specific product identity"
```

### Task 4: Verify and integrate the commercial-preparation slice

**Files:**
- Verify all changed files and existing authority test suites.

**Interfaces:**
- Consumes: Tasks 1–3.
- Produces: a clean commercial-preparation branch with no business behavior change and green local/remote gates.

- [ ] **Step 1: Run focused and static gates**

```powershell
uv run python manage.py test config.tests public_portal.tests.PublicPortalVisibilityTests staff_panel.tests.WordGenerateArchiveAuthorityTests
uv run pytest -q scripts/tests/test_commercial_brand_contract.py
python manage.py check
python manage.py makemigrations --check --dry-run
uv run ruff check .
uv run ruff format --check .
uv run mypy
npm run check:pyright
npm run check:pyright:entry-access
npm run check:client
npm run test:client
pwsh -NoProfile -File scripts/check_docs.ps1
```

- [ ] **Step 2: Perform two self-review passes**

First verify only presentation/configuration files changed and authority/domain files are untouched except tests/docs. Then scan for institution-specific literals, accidental removal of `院十佳`, secret leakage, unsafe setting use, migration drift, and unescaped template output.

- [ ] **Step 3: Run the full Django test suite**

```powershell
python manage.py test
```

- [ ] **Step 4: Commit, push, wait for remote gates, merge, and push `main`**

Use the repository’s normal short-lived branch workflow and `git merge --no-ff`; if push times out, retry via `127.0.0.1:12334`. Do not use worktrees or destructive Docker volume commands.

## Plan self-review

- Coverage: runtime templates, Word export, environment example, active documentation, static contract scan, focused tests, full Django, type/lint/client/docs gates are all assigned.
- Scope: “院十佳” and generic “学院” participant data are explicitly protected; only institutional identity is removed.
- No authority impact: the organization name never enters activity ownership, permissions, rules, results, release, audit, or database schemas.
