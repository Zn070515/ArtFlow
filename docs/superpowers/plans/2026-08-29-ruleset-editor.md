# M1-I — Template Library & Ruleset Editor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give staff a no-code path from a paper rule requirement to a frozen, validated ruleset: a seeded Template Library (10 first-batch + 2 golden) plus a `RulesetVersion` editor that supports add/save/delete/move nodes, Validate (`compile_definition`), Preview (`resolve` over a synthetic sample), and Freeze (`freeze_ruleset_version`).

**Architecture:** Server-rendered Django + Tailwind, no JS bundler. The editor is a self-submitting form graph over the existing `definition` JSON. All serialization is derived from the existing `NODE_TYPE_SPEC`; all validation reuses `compile_definition`; preview reuses `resolve`; freeze reuses `freeze_ruleset_version`. The only new host is `ruleset/editor.py` (pure form <-> definition) and `ruleset/templates.py` (seed data).

**Tech Stack:** Django 6.0.8, Python 3.12, uv, Tailwind CSS (prebuilt `static/css/app.css`), `ruleset` + `staff_panel` apps.

---

## Conventions

- Author always `Zn070515 <302025510036@zjut.edu.cn>`, **no Co-Authored-By**.
- Commits: `git commit --author="Zn070515 <302025510036@zjut.edu.cn>" -m "..."`.
- Py files to check/format: `ruleset staff_panel`.
- Key existing symbols referenced below:
  - `NODE_TYPE_SPEC` (`ruleset/schema.py:264`) — name → `NodeSpec(required, optional, source_refs, expects, validate, output_type)`.
  - `ENTRY_KEY = "entry"` (`ruleset/schema.py:50`).
  - `compile_definition(defn, *, context=None) -> (ValidationReport, ExecutionPlan|None)` (`ruleset/compiler.py:756`).
  - `ValidationReport.passes()` / `.counts()` / `.to_dict()` / `ReportIssue.to_dict()`.
  - `ExecutionPlan.summary` → `candidate_pool_sizes`, `effective_scales`, `decisive_cutoffs`, `vote_dependencies`, `missing_score_paths`, `issues_by_severity`.
  - `resolve(definition, inputs: ResolveInput, plan=None) -> ResolveResult` (`ruleset/resolver.py:530`).
  - `ResolveInput(roster, round_scores, vote_scores, group_of, manual)` (`ruleset/resolver.py:50`).
  - `freeze_ruleset_version(version, operator)` (`ruleset/services.py:53`) — raises `PermissionDenied` / `ValidationError` / `RulesetInvalidError`.
  - `RulesetTemplate(name, schema_version, definition, description, status, content_hash, created_by, ...)` (`ruleset/models.py:10`).
  - `ContestRuleset(activity, name, source_template, is_test_data, stage_key, round_keys, announcement_blocks, created_by)` (`ruleset/models.py:59`).
  - `RulesetVersion(ruleset, version, definition, content_hash, execution_plan, status, is_current, ...)` (`ruleset/models.py:137`). `.Status = {DRAFT, FROZEN}`.
  - Golden definitions live in `singer_contest/tests.py` as `_schidui_definition()` (line 2091) and `_xiaofeng_definition()` (line 2162) — move them to `ruleset/templates.py`.
  - Staff auth: `staff_required` / `admin_required` (`accounts/decorators.py`); staff views already import `_require_admin` (`staff_panel/views.py:113`).

---

## Increment 1 — Template Library + Genesis

### Task 1: `ruleset/templates.py` — golden + first-batch definitions, idempotent seeder

**Files:**
- Create: `ruleset/templates.py`

- [ ] **Step 1: Write the failing test** in `ruleset/test_seed_templates.py` (new) + import `seed_ruleset_templates`, `FIRST_BATCH`, `GOLDEN_SCHIDUI`, `GOLDEN_XIAOFENG`.

```python
from django.test import TestCase
from ruleset.models import RulesetTemplate
from ruleset.schema import parse_definition
from ruleset.templates import (
    FIRST_BATCH,
    GOLDEN_SCHIDUI,
    GOLDEN_XIAOFENG,
    seed_ruleset_templates,
)


class TemplateLibraryTests(TestCase):
    def test_golden_definitions_are_schema_valid(self):
        for name, definition in [("院十佳", GOLDEN_SCHIDUI), ("校十佳屏峰", GOLDEN_XIAOFENG)]:
            self.assertEqual(parse_definition(definition)["schema_version"], 1)

    def test_first_batch_has_ten_unique_slots(self):
        self.assertEqual(len(FIRST_BATCH), 10)
        keys = [t["key"] for t in FIRST_BATCH]
        self.assertEqual(len(keys), len(set(keys)))

    def test_seed_is_idempotent(self):
        seed_ruleset_templates(None)
        first = RulesetTemplate.objects.count()
        self.assertEqual(first, 12)
        seed_ruleset_templates(None)
        self.assertEqual(RulesetTemplate.objects.count(), first)

    def test_seeded_templates_have_hashes(self):
        seed_ruleset_templates(None)
        for t in RulesetTemplate.objects.all():
            self.assertTrue(t.content_hash)
```

- [ ] **Step 2: Run to verify it fails.** `uv run python manage.py test ruleset.test_seed_templates -v 2` — FAIL (`ModuleNotFoundError`).

- [ ] **Step 3: Implement `ruleset/templates.py`.** Move both golden definitions here as constants returning the same JSON strings (copy from `singer_contest/tests.py`). Define `FIRST_BATCH` as 10 definitions (schema-valid dicts) using the primitives already proven. Define an idempotent seeder:

```python
from django.db import transaction
from ruleset.models import RulesetTemplate
from ruleset.schema import content_hash


@transaction.atomic
def seed_ruleset_templates(operator=None, *, status=RulesetTemplate.Status.DRAFT):
    from ruleset.schema import parse_definition

    created = 0
    for name, definition, description in _CATALOG:
        parsed = parse_definition(definition)
        obj, was_created = RulesetTemplate.objects.update_or_create(
            name=name,
            defaults={
                "definition": definition,
                "schema_version": parsed["schema_version"],
                "description": description,
                "status": status,
                "content_hash": content_hash(definition),
                "created_by": operator,
            },
        )
        created += 1 if was_created else 0
    return created
```

Define `_CATALOG` as a list of `(name, definition, description)` triples: 2 golden + 10 first-batch. Each first-batch `definition` is a `json.dumps(...)` of a `{schema_version, nodes:[...]}` dict that passes `parse_definition`. Suggested shapes (all use only implemented node types):
  1. `simple_screening` — `entry → ASSESS r1 → RANK → SELECT count=10`.
  2. `single_round_topn` — `entry → ASSESS r1 → RANK → SELECT count=10`.
  3. `weighted_multiround` — `entry → ASSESS r1 → ASSESS r2 → AGGREGATE[.4,.6] → RANK → SELECT count=10` (the `weighted_composite_topn` fixture).
  4. `judge_audience_composite` — `entry → ASSESS r1 → ASSESS vote_source=audience → AGGREGATE[.7,.3] → RANK → SELECT count=10`.
  5. `independent_popularity_award` — `entry → ASSESS vote_source=audience → RANK → SELECT count=1`.
  6. `group_direct_repechage` — `entry → PARTITION by → assess r1 → RANK → SELECT by(×1 per group) → SUBTRACT → assess → RANK → SELECT count=12 → MERGE`.
  7. `seeded_pk_wildcard` — `entry → PAIR source odd_policy=wildcard → assess r1 → RANK → SELECT`.
  8. `direct_bye_middle_pk` — `entry → RANK → SELECT count (direct) → SUBTRACT → PAIR → …`.
  9. `track_team_quota` — `entry → PARTITION by=track → SELECT count per group → MERGE`.
  10. `multivenue_merge` — `entry → PARTITION by=venue → assess r1 → AGGREGATE → RANK → SELECT`.
  (Exact node graphs are validated by `parse_definition` in the test; keep them schema-valid and forward-only. Where a graph needs more rounds, add the `round` keys. Any template that is a pure variant of another may reuse a Python dict builder to keep it DRY.)

- [ ] **Step 4: Run test to verify it passes.** `uv run python manage.py test ruleset.test_seed_templates -v 2` — all PASS.

- [ ] **Step 5: Delete the now-duplicated golden helpers** in `singer_contest/tests.py`. Replace `def _schidui_definition():` and `def _xiaofeng_definition():` bodies with:

```python
def _schidui_definition():
    from ruleset.templates import GOLDEN_SCHIDUI
    return GOLDEN_SCHIDUI


def _xiaofeng_definition():
    from ruleset.templates import GOLDEN_XIAOFENG
    return GOLDEN_XIAOFENG
```

- [ ] **Step 6: Run the affected suites.** `uv run python manage.py test ruleset singer_contest -v 1` — all PASS (no regression).

- [ ] **Step 7: Commit.** `git add ruleset/templates.py ruleset/test_seed_templates.py singer_contest/tests.py && git commit --author="Zn070515 <302025510036@zjut.edu.cn>" -m "feat: ruleset template library + idempotent seeder (M1-I)"`.

### Task 2: `seed_ruleset_templates` management command

**Files:**
- Create: `ruleset/management/commands/seed_ruleset_templates.py`
- Create: `ruleset/management/__init__.py`, `ruleset/management/commands/__init__.py` (if absent)

- [ ] **Step 1: Command.** `python manage.py seed_ruleset_templates [--frozen]`. Resolves the operator as the first admin (or `None`), calls `seed_ruleset_templates(operator, status=FROZEN if --frozen else DRAFT)`, prints the count.

```python
from django.contrib.auth import get_user_model
from django.core.management.base import BaseCommand
from ruleset.templates import seed_ruleset_templates


class Command(BaseCommand):
    help = "Seed the ruleset template library (idempotent)."

    def add_arguments(self, parser):
        parser.add_argument("--frozen", action="store_true", help="Mark templates FROZEN.")

    def handle(self, *args, **options):
        operator = get_user_model().objects.filter(is_active=True).order_by("pk").first()
        status = "frozen" if options["frozen"] else "draft"
        count = seed_ruleset_templates(operator, status=status)
        self.stdout.write(self.style.SUCCESS(f"seeded {count} ruleset templates"))
```

- [ ] **Step 2: Run it to verify.** `uv run python manage.py seed_ruleset_templates` → `seeded 12 ruleset templates` (create a `RulesetTemplate` DB table first if the migration set is empty — standard `manage.py migrate`).

- [ ] **Step 3: Wire into `scripts/bootstrap.ps1`.** After `manage.py migrate`, call `uv run python manage.py seed_ruleset_templates`. (Read the script first to place the call correctly.)

- [ ] **Step 4: Commit.** `git add ruleset/management scripts/bootstrap.ps1 && git commit --author="Zn070515 <302025510036@zjut.edu.cn>" -m "feat: seed_ruleset_templates management command + bootstrap wiring (M1-I)"`.

### Task 3: Staff template library list + detail views

**Files:**
- Modify: `staff_panel/views.py`
- Modify: `staff_panel/urls.py`
- Create: `templates/staff_panel/ruleset_template_list.html`
- Create: `templates/staff_panel/ruleset_template_detail.html`
- Modify: `staff_panel/tests.py`

- [ ] **Step 1: Write the failing tests** in `staff_panel/tests.py`:

```python
class RulesetTemplateLibraryTests(TestCase):
    def setUp(self):
        self.staff = User.objects.create_user(
            username="lib-staff", password="pass", role=User.Role.STAFF
        )
        self.client.force_login(self.staff)

    def test_template_list_renders_library(self):
        from ruleset.templates import seed_ruleset_templates
        seed_ruleset_templates(self.staff)
        resp = self.client.get(reverse("staff:ruleset_template_list"))
        self.assertEqual(resp.status_code, 200)
        self.assertContains(resp, "院十佳")
        self.assertContains(resp, "校十佳屏峰")

    def test_template_detail_renders_definition_nodes(self):
        from ruleset.models import RulesetTemplate
        from ruleset.templates import seed_ruleset_templates
        seed_ruleset_templates(self.staff)
        tpl = RulesetTemplate.objects.get(name="院十佳")
        resp = self.client.get(reverse("staff:ruleset_template_detail", args=[tpl.pk]))
        self.assertEqual(resp.status_code, 200)
        self.assertContains(resp, "assess_r1")
```

- [ ] **Step 2: Run to verify they fail.** `uv run python manage.py test staff_panel.tests.RulesetTemplateLibraryTests -v 2` — FAIL (NoReverseMatch / url not found).

- [ ] **Step 3: Add the views.** In `staff_panel/views.py`, import `from ruleset.models import RulesetTemplate`. Add:

```python
@staff_required
def ruleset_template_list(request):
    templates = RulesetTemplate.objects.all()
    return render(
        request,
        "staff_panel/ruleset_template_list.html",
        {"templates": templates, "total": templates.count()},
    )


@staff_required
def ruleset_template_detail(request, pk):
    template = get_object_or_404(RulesetTemplate, pk=pk)
    return render(
        request,
        "staff_panel/ruleset_template_detail.html",
        {"template": template},
    )
```

  Wrap with `@staff_required` (top-level decorator, consistent with the file). Verify `staff_required` is imported (`from accounts.decorators import admin_required, staff_required` — add it if only `admin_required` is imported).

- [ ] **Step 4: Add URLs** in `staff_panel/urls.py`:

```python
path("ruleset-templates/", views.ruleset_template_list, name="ruleset_template_list"),
path("ruleset-templates/<int:pk>/", views.ruleset_template_detail, name="ruleset_template_detail"),
```

- [ ] **Step 5: Write the templates.** Extend `base.html`; list page shows a card grid of templates (name, description, status badge, "查看定义" link); detail page renders `template.definition` via `parse_definition` in the view (pass `nodes` context) OR shows the raw JSON in a scrollable `<pre>` (simplest: `{{ template.definition }}` in `<pre>`). For the detail test to see `assess_r1`, parse in the view and pass `nodes`:

```python
@staff_required
def ruleset_template_detail(request, pk):
    template = get_object_or_404(RulesetTemplate, pk=pk)
    from ruleset.schema import parse_definition
    nodes = parse_definition(template.definition)["nodes"] if template.definition else []
    return render(request, "staff_panel/ruleset_template_detail.html", {"template": template, "nodes": nodes})
```

  Detail template loops `{% for node in nodes %}<li>{{ node.key }} · {{ node.type }}</li>{% endfor %}`.

- [ ] **Step 6: Add a dashboard card** linking to `ruleset_template_list` (in `templates/staff_panel/dashboard.html`).

- [ ] **Step 7: Run tests.** `uv run python manage.py test staff_panel.tests.RulesetTemplateLibraryTests -v 2` — PASS. Then `uv run python manage.py test ruleset singer_contest staff_panel -v 1`.

- [ ] **Step 8: Lint + format.** `uv run ruff check ruleset staff_panel && uv run ruff format ruleset staff_panel`.

- [ ] **Step 9: Commit.** `git add staff_panel/views.py staff_panel/urls.py staff_panel/tests.py templates/staff_panel && git commit --author="Zn070515 <302025510036@zjut.edu.cn>" -m "feat: staff ruleset template library list + detail (M1-I)"`.

---

## Increment 2 — Ruleset Editor

### Task 4: `ruleset/editor.py` — pure form <-> definition + synthetic preview

**Files:**
- Create: `ruleset/editor.py`
- Test: `ruleset/test_editor.py` (new)

- [ ] **Step 1: Write the failing tests.** Cover: `available_sources`, `definition_from_form` round-trip + forward-only rejection, `node_card_context`, `synthetic_resolve_input`, `preview_definition`.

```python
from django.test import SimpleTestCase
from ruleset.editor import (
    available_sources,
    definition_from_form,
    node_card_context,
    preview_definition,
    synthetic_resolve_input,
)
from ruleset.schema import ENTRY_KEY, parse_definition


class EditorSerializeTests(SimpleTestCase):
    def test_available_sources_only_lists_prior_keys_plus_entry(self):
        nodes = [
            {"key": "a", "type": "ASSESS", "source": ENTRY_KEY, "round": "r1"},
            {"key": "b", "type": "RANK", "source": "a", "descending": True},
        ]
        self.assertEqual(available_sources(nodes, 0), [ENTRY_KEY])
        self.assertEqual(available_sources(nodes, 1), [ENTRY_KEY, "a"])

    def test_definition_from_form_roundtrips_an_assess_node(self):
        form = {
            "schema_version": "1",
            "node_0_key": "assess_r1",
            "node_0_type": "ASSESS",
            "node_0_source": ENTRY_KEY,
            "node_0_round": "r1",
            "node_0_scale": "hundred",
            "node_0_mode": "mean",
            "node_0_descending": "",
            "node_order": "node_0",
        }
        definition = definition_from_form(form)
        self.assertEqual(parse_definition(definition)["schema_version"], 1)
        self.assertEqual(definition["nodes"][0]["round"], "r1")

    def test_definition_from_form_rejects_forward_reference(self):
        form = {
            "schema_version": "1",
            "node_0_key": "a",
            "node_0_type": "RANK",
            "node_0_source": "b",
            "node_order": "node_0",
        }
        self.assertRaises(Exception, definition_from_form, form)

    def test_synthetic_resolve_input_has_scores_for_each_round(self):
        definition = {
            "schema_version": 1,
            "nodes": [
                {"key": "assess_r1", "type": "ASSESS", "source": ENTRY_KEY, "round": "r1"},
                {"key": "assess_r2", "type": "ASSESS", "source": ENTRY_KEY, "round": "r2"},
            ],
        }
        inputs = synthetic_resolve_input(definition)
        self.assertIn("r1", inputs.round_scores)
        self.assertIn("r2", inputs.round_scores)
        self.assertEqual(len(inputs.roster), 16)

    def test_preview_definition_returns_report_plan_result(self):
        definition = {
            "schema_version": 1,
            "nodes": [
                {"key": "assess_r1", "type": "ASSESS", "source": ENTRY_KEY, "round": "r1"},
                {"key": "assess_r2", "type": "ASSESS", "source": ENTRY_KEY, "round": "r2"},
                {
                    "key": "comp",
                    "type": "AGGREGATE",
                    "aggregate": {
                        "type": "weighted_sum",
                        "components": [
                            {"source": "assess_r1", "weight": 0.4},
                            {"source": "assess_r2", "weight": 0.6},
                        ],
                    },
                },
                {"key": "rank", "type": "RANK", "source": "comp", "descending": True},
                {"key": "top", "type": "SELECT", "source": "rank", "count": 10},
            ],
        }
        report, plan, result = preview_definition(definition)
        self.assertTrue(report.passes())
        self.assertIsNotNone(plan)
        self.assertIsNotNone(result)
```



- [ ] **Step 2: Run to verify they fail.** `uv run python manage.py test ruleset.test_editor -v 2` — FAIL (ModuleNotFoundError / NameError).

- [ ] **Step 3: Implement `ruleset/editor.py`.** Pure module; no DB.

```python
from __future__ import annotations
import json
from ruleset.resolver import ResolveInput
from ruleset.schema import ENTRY_KEY, NODE_TYPE_SPEC, parse_definition

_FIELD_LABELS = {
    "key": "节点键",
    "type": "类型",
    "source": "来源",
    "round": "轮次键",
    "scale": "分数制",
    "mode": "计分方式",
    "trim_high": "去最高",
    "trim_low": "去最低",
    "min_judges": "最低评委数",
    "descending": "降序",
    "tie_policy": "平局处理",
    "by": "按分组",
    "count": "数量",
    "quota": "名额",
    "groups": "组数",
    "odd_policy": "奇数处理",
    "vote_source": "投票来源",
    "vote_purpose": "投票用途",
    "award": "奖项",
    "minuend": "被减数",
    "subtrahend": "减数",
    "source": "来源",
    "within": "限定范围",
}
_FIELD_ALLOWED = {
    "scale": ["hundred", "ten", "raw", "ordinal"],
    "mode": ["mean", "trimmed_mean"],
    "tie_policy": ["auto_break", "extra_round", "manual", "score_fallback"],
    "odd_policy": ["bye", "wildcard", "manual", "reject"],
    "vote_purpose": ["POPULARITY", "SCORE_COMPONENT", "SELECTION", "OTHER"],
}


def available_sources(nodes, index):
    prior = [n["key"] for n in nodes[:index]]
    return [ENTRY_KEY] + prior  (ORDER: entry first, then prior keys in order)


def _bool(payload):
    return payload in ("1", "true", "True", "on")


def definition_from_form(form):
    order = (form.get("node_order") or "").split(",")
    nodes = []
    for token in order:
        if not token:
            continue
        node = {"key": form.get(f"{token}_key", "").strip()}
        node["type"] = form.get(f"{token}_type", "").strip()
        spec = NODE_TYPE_SPEC.get(node["type"])
        if spec is None:
            raise ValueError(f"unknown node type {node['type']!r}")
        for field in list(spec.required) + list(spec.optional):
            if field == "source":
                value = form.get(f"{token}_source", "").strip()
                if value:
                    node["source"] = value
            elif field in ("descending",):
                if _bool(form.get(f"{token}_descending", "")):
                    node["descending"] = True
            elif field in ("trim_high", "trim_low", "min_judges", "count", "quota", "groups"):
                raw = form.get(f"{token}_{field}", "").strip()
                if raw != "":
                    node[field] = int(raw)
            elif field == "aggregate":
                node["aggregate"] = _parse_aggregate(form, token)
            elif field == "round":
                raw = form.get(f"{token}_round", "").strip()
                if raw:
                    node["round"] = raw
            else:
                raw = form.get(f"{token}_{field}", "").strip()
                if raw != "":
                    node[field] = raw
        nodes.append(node)
    definition = {"schema_version": 1, "nodes": nodes}
    parse_definition(definition)
    return definition


def _parse_aggregate(form, token):
    components = []
    i = 0
    while True:
        src = form.get(f"{token}_aggregate_component_{i}_source", "").strip()
        if not src:
            break
        weight = form.get(f"{token}_aggregate_component_{i}_weight", "").strip()
        components.append({"source": src, "weight": float(weight)})
        i += 1
    agg_type = form.get(f"{token}_aggregate_type", "weighted_sum").strip() or "weighted_sum"
    aggregate = {"type": agg_type, "components": components}
    within = form.get(f"{token}_within", "").strip()
    if within:
        aggregate_payload = {"aggregate": aggregate, "within": within}
        return aggregate_payload  (store within at node level? see note)
    return aggregate
```

  **IMPORTANT** — `within` is a node-level field (`{"key","type","within","aggregate":{...}}`), **not** inside `aggregate`. The schema reads `node["within"]` (compiler `_check_dependency` line 654) and `node.get("within")` (resolver `_aggregate`). So in `definition_from_form`, set `node["within"]` separately, and `node["aggregate"]` keeps only `{type, components}`:

```python
            elif field == "aggregate":
                node["aggregate"] = {"type": agg_type, "components": components}
            elif field == "within":
                raw = form.get(f"{token}_within", "").strip()
                if raw:
                    node["within"] = raw
```

  (Adjust `_parse_aggregate` to return just `{type, components}`; read `within` in the field loop.)

**Note on `descending`**: the `_FIELd` boolean must only be set when present, and MUST NOT set `descending=False` for an absent value (schema only enforces bool-ness when present; an absent boolean is fine). Use `if _bool(...)` to set `True` only.

**Note on `conversion` / `branches` (deferred to best-effort)**: if a node needs `aggregate.conversion` or `branches`, they are edited as a raw JSON sub-field in a later task; for now `definition_from_form` raises a clear `ValueError` if such a field is present but unsupported — OR reads it as a JSON object. Keep it readable: for branches/`conversion`, accept a JSON string under `{token}_branches_json` / `{token}_conversion_json` and `json.loads` it. Implement this now so BRANCH and AGGREGATE+conversion templates round-trip.

```python
def synthetic_resolve_input(definition):
    nodes = parse_definition(definition)["nodes"]
    roster = tuple(str(i) for i in range(1, 17))
    round_scores = {}
    vote_scores = {}
    for node in nodes:
        rnd = node.get("round")
        if rnd and rnd not in round_scores:
            round_scores[rnd] = {
                str(i): (f"{(100 - i + 1)/10:.2f}", f"{(100 - i + 1)/10:.2f}")
                for i in range(1, 17)
            }
        if node.get("vote_source") and node["vote_source"] not in vote_scores:
            vote_scores[node["vote_source"]] = {
                str(i): f"{(100 - i + 1)/10:.2f}" for i in range(1, 17)
            }
    return ResolveInput(roster=roster, round_scores=round_scores, vote_scores=vote_scores)


def preview_definition(definition, *, context=None):
    from ruleset.compiler import compile_definition
    from ruleset.resolver import resolve
    report, plan = compile_definition(definition, context=context)
    if not report.passes() or plan is None:
        return report, plan, None
    inputs = synthetic_resolve_input(definition)
    result = resolve(definition, inputs, plan=plan)
    return report, plan, result
```

  Note `round_scores` values are tuples of Decimals/strings for judge scores; the resolver's `_assess` takes `tuple[Decimal,...]`. Passing strings may break; use `Decimal`. Import `from decimal import Decimal` and wrap: `tuple(Decimal(s) for s in (...) )`.

- [ ] **Step 4: Run to verify they pass.** `uv run python manage.py test ruleset.test_editor -v 2` — PASS.

- [ ] **Step 5: Commit.** `git add ruleset/editor.py ruleset/test_editor.py && git commit --author="Zn070515 <302025510036@zjut.edu.cn>" -m "feat: ruleset editor serialize + synthetic preview (M1-I)"`.

### Task 5: Staff ruleset editor views (create / edit / validate / preview / freeze)

**Files:**
- Modify: `staff_panel/views.py`
- Modify: `staff_panel/urls.py`
- Create: `templates/staff_panel/ruleset_editor.html`
- Modify: `staff_panel/tests.py` (acceptance walkthrough)

- [ ] **Step 1: Write the failing acceptance tests** — the §14.7 walkthrough. In `staff_panel/tests.py`:

```python
class RulesetEditorTests(TestCase):
    def setUp(self):
        self.admin = User.objects.create_user(
            username="editor-admin", password="pass", role=User.Role.ADMIN
        )
        self.activity = Activity.objects.create(
            title="院十佳2026", activity_type=Activity.Type.SINGER_CONTEST,
            phase=Activity.Phase.REGISTRATION_OPEN, is_test_mode=True,
        )
        self.client.force_login(self.admin)

    def _definition_for_acceptance(self):
        # 16人 R1 40% R2 60% 无观众 Top12 → R3 Previous50 + R3 50 Top6
        from ruleset.schema import ENTRY_KEY
        return {
            "schema_version": 1,
            "nodes": [
                {"key": "assess_r1", "type": "ASSESS", "source": ENTRY_KEY, "round": "r1"},
                {"key": "assess_r2", "type": "ASSESS", "source": ENTRY_KEY, "round": "r2"},
                {"key": "stage1", "type": "AGGREGATE", "within": ENTRY_KEY, "aggregate": {
                    "type": "weighted_sum",
                    "components": [{"source": "assess_r1", "weight": 0.4}, {"source": "assess_r2", "weight": 0.6}]}},
                {"key": "rank1", "type": "RANK", "source": "stage1", "descending": True},
                {"key": "top12", "type": "SELECT", "source": "rank1", "count": 12},
                {"key": "assess_r3", "type": "ASSESS", "source": "top12", "round": "r3"},
                {"key": "fin", "type": "AGGREGATE", "within": "top12", "aggregate": {
                    "type": "weighted_sum",
                    "components": [{"source": "stage1", "weight": 0.5}, {"source": "assess_r3", "weight": 0.5}]}},
                {"key": "rank2", "type": "RANK", "source": "fin", "descending": True},
                {"key": "top6", "type": "SELECT", "source": "rank2", "count": 6},
            ],
        }

    def test_create_ruleset_from_blank_then_edit(self):
        resp = self.client.post(reverse("staff:contest_ruleset_create"),
                                {"activity": self.activity.pk, "name": "院十佳2026规则", "template": ""})
        self.assertRedirects(resp, reverse("staff:ruleset_edit", args=[self._version_pk()]))
        self.assertEqual(self._version().status, "draft")

    def test_editor_validate_clean_on_acceptance_definition(self):
        resp = self.client.post(reverse("staff:ruleset_validate", args=[self._version_pk()]))
        self.assertEqual(resp.status_code, 200)
        # no ERROR count

    def test_preview_shows_candidate_pool_sizes(self):
        resp = self.client.post(reverse("staff:ruleset_preview", args=[self._version_pk()]))
        self.assertEqual(resp.status_code, 200)

    def test_editor_add_and_move_roundtrip(self):
        # POST add a node, then move-up, then save; assert definition nodes reordered
        ...

    def test_freeze_requires_frozen_current_and_refuses_invalid(self):
        # invalid graph -> 400 / no FROZEN; valid -> FROZEN current
        ...
```

  Add helpers `_version_pk()`, `_version()` that find the `RulesetVersion` created by the create view (or create it in setUp). Simplify: create the `ContestRuleset` + `RulesetVersion` directly in `setUp`, then drive only edit/validate/preview/freeze.

- [ ] **Step 2: Run to verify they fail.** `uv run python manage.py test staff_panel.tests.RulesetEditorTests -v 2` — FAIL (url/NoReverseMatch).

- [ ] **Step 3: Import ruleset symbols** at the top of `staff_panel/views.py`:

```python
from ruleset.models import ContestRuleset, RulesetVersion, RulesetTemplate
from ruleset.services import freeze_ruleset_version, RulesetInvalidError
from ruleset.editor import available_sources, definition_from_form, preview_definition
from ruleset.compiler import compile_definition
from ruleset.schema import parse_definition
```

- [ ] **Step 4: Implement `contest_ruleset_create`.** GET renders an activity select + template select; POST creates a `ContestRuleset` (+ `source_template` if chosen) and a `RulesetVersion` (definition = template.definition, or a minimal `{schema_version:1, nodes:[{key:'entry',...}]}`... actually a blank graph has no nodes; a minimal **starter** is `entry → ASSESS r1 → RANK → SELECT count=10` so `parse_definition`'s non-empty `nodes` requirement is satisfied). Redirect to `ruleset_edit`. Enforce `_require_admin` (creating a ruleset is admin-only? §14.7 says staff config; keep it `staff_required` to match the acceptance "staff"). Use `staff_required`.

- [ ] **Step 5: Implement `ruleset_edit`.** GET renders the current DRAFT version's `definition` as node cards + the `context` sub-card. POST branches on `action`:
  - `add` — append a node of the submitted `new_type` with an auto-generated unique key, save, redirect.
  - `save` — rebuild via `definition_from_form`, persist `version.definition`, redirect. On `Exception` (schema violation) re-render with `form_errors`.
  - `delete` — remove node `key`, save, redirect.
  - `move_up` / `move_down` — swap node `key` with neighbor, save, redirect.
  Only a DRAFT is editable (a FROZEN version raises `ValidationError` on `save`; guard with an early check → message).

  The view must pass `nodes` (parsed), `available_sources` per index, and the version. For `validate`/`preview`, separate POST views that read `version.definition` (no form rebuild needed — they validate the persisted graph).

```python
@staff_required
def ruleset_edit(request, pk):
    version = get_object_or_404(RulesetVersion, pk=pk)
    if version.status == RulesetVersion.Status.FROZEN:
        raise PermissionDenied("已冻结赛制版本不可编辑。")
    action = request.POST.get("action")
    if request.method == "POST" and action in ("add", "save", "delete", "move_up", "move_down"):
        definition = _reconcile_definition(request.POST, version, action)
        version.definition = json.dumps(definition, ensure_ascii=False)
    parsed = parse_definition(version.definition) if version.definition else {"nodes": []} (guard try)
    nodes = parsed["nodes"]
    cards = [
        {"node": node, "index": i, "sources": available_sources(nodes, i),
         "spec": NODE_TYPE_SPEC.get(node["type"])}
        for i, node in enumerate(nodes)
    ]
    return render(request, "staff_panel/ruleset_editor.html", {
        "version": version, "ruleset": version.ruleset, "cards": cards,
        "context_form": ...,
    })
```

- [ ] **Step 6: Implement `ruleset_validate`, `ruleset_preview`, `ruleset_freeze`.**

```python
@staff_required
def ruleset_validate(request, pk):
    version = get_object_or_404(RulesetVersion, pk=pk)
    report, plan = compile_definition(version.definition)
    return render(request, "staff_panel/ruleset_validate.html", {
        "version": version, "passes": report.passes(),
        "issues": [i.to_dict() for i in report.issues],
        "counts": report.counts(),
        "summary": plan.summary if plan else None,
    })


@staff_required
def ruleset_preview(request, pk):
    version = get_object_or_404(RulesetVersion, pk=pk)
    report, plan, result = preview_definition(version.definition)
    status = result.status.value if result else "—"
    return render(request, "staff_panel/ruleset_preview.html", {
        "version": version, "passes": report.passes(), "issues": [i.to_dict() for i in report.issues],
        "summary": plan.summary if plan else None, "status": status,
        "node_values": result.node_values if result else None,
        "decisions": [d.to_dict() for d in result.decisions][:20] if result else None,
    })


@staff_required
@require_POST
def ruleset_freeze(request, pk):
    version = get_object_or_404(RulesetVersion, pk=pk)
    try:
        freeze_ruleset_version(version, request.user)
    except PermissionDenied as exc:
        messages.error(request, str(exc))
    except RulesetInvalidError as exc:
        messages.error(request, "赛制排版未通过校验：" + "; ".join(i.message for i in exc.report.issues if i.severity.value == "error") or "存在 ERROR")
    except ValidationError as exc:
        messages.error(request, "；".join(exc.messages))
    else:
        messages.success(request, "赛制已冻结。")
    return redirect("staff:ruleset_edit", pk=pk)
```

- [ ] **Step 7: Add URLs.** In `staff_panel/urls.py`:

```python
path("rulesets/create/", views.contest_ruleset_create, name="contest_ruleset_create"),
path("rulesets/<int:pk>/edit/", views.ruleset_edit, name="ruleset_edit"),
path("rulesets/<int:pk>/validate/", views.ruleset_validate, name="ruleset_validate"),
path("rulesets/<int:pk>/preview/", views.ruleset_preview, name="ruleset_preview"),
path("rulesets/<int:pk>/freeze/", views.ruleset_freeze, name="ruleset_freeze"),
```

- [ ] **Step 8: Write `templates/staff_panel/ruleset_editor.html`.** Reused `base.html`. A breadcrumb (`工作人员后台 / 赛制编辑 / {ruleset.name}`), a header with `版本 vN · {status}`, and an **action bar** with three forms: `ruleset_validate` / `ruleset_preview` (GET/POST buttons), `ruleset_freeze` (POST confirm). Then the node-card stack:

```
{% for card in cards %}
<form method="post" action="{% url 'staff:ruleset_edit' version.pk %}" class="...">
  {% csrf_token %}
  <input type="hidden" name="action" value="save">
  <input type="hidden" name="node_order" value="{% for c in cards %}{{ c.index }}{% if not forloop.last %},{% endif %}{% endfor %}">
  <input type="hidden" name="node_{{ card.index }}_type" value="{{ card.node.type }}">
  <span>{{ card.node.type }}</span>
  {% if card.spec.required or card.spec.optional %}
    <label>来源</label>
    <select name="node_{{ card.index }}_source">
      {% for s in card.sources %}<option value="{{ s }}" {% if card.node.source == s %}selected{% endif %}>{{ s }}</option>{% endfor %}
    </select>
    <!-- render fields from card.spec.required/optional and _FIELD_LABELS/_FIELD_ALLOWED in the view (pass a per-node field list) -->
  {% endif %}
  <button type="submit">保存节点</button>
</form>
<form method="post" ... action="move_up"><input name="action" value="move_up"><input name="key" value="{{ card.node.key }}">…</form>
<form method="post" ... action="move_down">…</form>
<form method="post" onsubmit="confirm(...)"><input name="action" value="delete"><input name="key" value="{{ card.node.key }}">…</form>
{% endfor %}
<form method="post" action="{% url 'staff:ruleset_edit' version.pk %}">
  {% csrf_token %}<input name="action" value="add">
  <select name="new_type">{% for t in node_types %}<option>{{ t }}</option>{% endfor %}</select>
  <button>新增节点</button>
</form>
```

  To keep the field rendering data-driven, pass a `fields` list per card from the view: label, name, value, allowed/coerce hint. Build it in the view from `spec.required` + `spec.optional` using `_FIELD_LABELS`/`_FIELD_ALLOWED` from `ruleset/editor.py` (re-export both). Simplify: the template loops `{% for f in card.fields %}` where `card.fields` is a list of dicts `{label, name, value, kind}` and `kind in ("text","select","int","checkbox","number","aggregate")`. For `aggregate` kind, render the component rows (`card.components` list of `{source, weight, sources}`).

  Keep the template **readable and minimal** — it does NOT need to be pretty; the tests assert on status codes / containments, not CSS. A plain field loop is fine.

- [ ] **Step 9: Write the `ruleset_validate.html` / `ruleset_preview.html` templates.** Validate: list `issues` grouped by severity + `summary` (candidate_pool_sizes, decisive_cutoffs). Preview: `status` badge + per-node `candidate_pool_sizes` + `node_values` + first decisions + `issues` warnings.

- [ ] **Step 10: Run tests.** `uv run python manage.py test staff_panel.tests.RulesetEditorTests -v 2`. Fix the `_version`/`_version_pk` helper to create the ruleset+version in `setUp`. Then `uv run python manage.py test ruleset singer_contest staff_panel -v 1`.

- [ ] **Step 11: Lint + format.** `uv run ruff check ruleset staff_panel && uv run ruff format ruleset staff_panel`.

- [ ] **Step 12: Add a dashboard card** linking to `contest_ruleset_create` (and/or an activity's ruleset list) in `templates/staff_panel/dashboard.html`.

- [ ] **Step 13: Commit.** `git add staff_panel/views.py staff_panel/urls.py staff_panel/tests.py templates/staff_panel && git commit --author="Zn070515 <302025510036@zjut.edu.cn>" -m "feat: ruleset editor validate/preview/freeze (M1-I)"`.

---

## Task 6: Clone Last Year + Template instantiation polish

**Files:**
- Modify: `staff_panel/views.py`
- Modify: `staff_panel/urls.py`
- Modify: `templates/staff_panel/ruleset_template_list.html` (add "克隆到活动" buttons)
- Modify: `staff_panel/tests.py`

- [ ] **Step 1: Writing the failing test.**

```python
def test_clone_last_year_creates_contest_ruleset_from_template(self):
    from ruleset.templates import seed_ruleset_templates
    from ruleset.models import RulesetTemplate
    seed_ruleset_templates(self.staff)
    tpl = RulesetTemplate.objects.get(name="院十佳")
    resp = self.client.post(reverse("staff:ruleset_clone_from_template", args=[tpl.pk]),
                            {"activity": self.activity.pk, "name": "院十佳2026"})
    self.assertRedirects(resp, reverse("staff:ruleset_edit", args=[resp.wsgi_request ...]))  # just assert 302
    self.assertEqual(ContestRuleset.objects.filter(activity=self.activity).count(), 1)
```

- [ ] **Step 2: Run to fail.**

- [ ] **Step 3: Implement `ruleset_clone_from_template(request, template_pk)`.** POST: pick a `ContestRuleset` by `activity` (reuse if exists, else create), set `source_template`, create a new DRAFT `RulesetVersion` with `definition = template.definition`, then redirect to `ruleset_edit`. This satisfies §14.6 "从 2025 院十佳赛制复制" — the golden template IS the 2025 structure. Add a `ruleset_clone_last_year` alias that picks the golden template by name.

- [ ] **Step 4: Add URLs.** `path("ruleset-templates/<int:pk>/clone/", views.ruleset_clone_from_template, name="ruleset_clone_from_template")`.

- [ ] **Step 5: Template buttons** — a "克隆到活动" link on each template card (and on the detail page).

- [ ] **Step 6: Run tests + lint.** `uv run python manage.py test staff_panel.tests.RulesetEditorTests staff_panel.tests.RulesetTemplateLibraryTests -v 2` then `uv run ruff check ruleset staff_panel && uv run ruff format ruleset staff_panel`.

- [ ] **Step 7: Commit.** `git add staff_panel/views.py staff_panel/urls.py staff_panel/tests.py templates/staff_panel && git commit --author="Zn070515 <302025510036@zjut.edu.cn>" -m "feat: clone last year + template instantiation (M1-I)"`.

---

## Full verification (before merge)

1. `uv run ruff check ruleset staff_panel` and `uv run ruff format --check ruleset staff_panel`.
2. `uv run python manage.py makemigrations --check --dry-run` → no drift. `uv run python manage.py check`.
3. `uv run python manage.py test ruleset staff_panel` (scoped).
4. `uv run python manage.py test` (full, no regression).
5. `uv run python manage.py seed_ruleset_templates` → 12 templates.
6. Manual staff_panel smoke: create ruleset from 院十佳 template; add/save/move/delete a node; Validate clean; Preview shows pool sizes + READY; Freeze flips to FROZEN current; a deliberately-invalid graph blocks Freeze.
7. §21 report; branch `m1-i-ruleset-editor`; non-ff merge to main; push via
   `GIT_SSH_COMMAND="ssh -o ProxyCommand=none" git push origin main`; author `Zn070515 <302025510036@zjut.edu.cn>`, **no Co-Authored-By**.
