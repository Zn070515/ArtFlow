# M1-I — Template Library & Ruleset Editor

Date: 2026-08-29 · Feature branch `m1-i-ruleset-editor` · Author `Zn070515`

## Problem

M1-A..G proved the engine: a typed, forward-only node graph (`ruleset/schema.py`) is
statically validated (`ruleset/compiler.py`) and deterministically executed
(`ruleset/resolver.py`). M1-F/G bound it to the DB (`bind_resolve_input` → `run_ruleset`)
and proved the 2025 院十佳 / 校十佳屏峰 goldens reproduce with **no year special-casing in
Python** — every rule lives in a JSON `definition`. M1-H gave staff a rapid entry grid and a
result board reading persisted `StageResult`s.

But today a ruleset is authored as **hand-written JSON** (`_schidui_definition()` in tests).
There is no `ContestRuleset`/`RulesetVersion` creation UI in the backstage, no template
library, no editor, no Validate/Preview/Freeze flow. §14 requires staff to move from a paper
requirement to a **frozen, UI-configured ruleset** — without code. This stage builds that UI.

### What staff must be able to do (§14.7 acceptance)

Given a requirement like:

```
16人 R1 40% R2 60% 无观众 Top12 → R3 Previous50 + R3 50 Top6
```

a staff member, **without touching code**, must: start from a template (or Clone Last Year),
adjust the node graph (add node / pick source / set params / reorder / delete), **Validate**,
**Preview** against a synthetic sample, and **Freeze**. All server-rendered; no JS bundler; the
repo has none and this stage adds none.

## Architecture

Server-rendered Django templates + Tailwind (consistent with M1-H). No new framework, no build
step. The editor is a **self-submitting form graph**: one form per node card; each action
(add / save / delete / move-up / move-down / validate / preview / freeze) is an HTTP round
trip that re-validates and re-renders the full graph. The stored source of truth is the
`definition` JSON on a `RulesetVersion`; the UI is a faithful form over it, driven entirely by
the **existing schema metadata** (`NODE_TYPE_SPEC`) so the editor stays in sync with the engine
without hand-written per-node templates.

Reuse everything already proven:
- **Validate** = `compile_definition` (`ruleset/compiler.py`) → `ValidationReport` / `ExecutionPlan`.
- **Freeze** = `freeze_ruleset_version` (`ruleset/services.py`) — enforces admin + unlocked
  activity, refuses on any ERROR, demotes the prior current FROZEN version, persists the plan.
- **Preview** = `resolve` (`ruleset/resolver.py`) over a **synthetic** `ResolveInput`, driven by
  `compile_definition`'s `ExecutionPlan` (per-node candidate pool sizes / scale / tie review /
  vote deps / missing score paths). The synthetic sample is generated from the definition's own
  round-key / vote-source refs, so "每节点 candidate count + output + warnings + unresolved
  manual node" (§14.5) fall out of the existing plan + a pure resolver call.

### The 10 first-batch templates (§14.2)

Genesis from the golden definitions + the schema fixtures, expressed as frozen `RulesetTemplate`
rows. Each is a named, reusable `definition`. `RulesetTemplate` already exists
(`ruleset/models.py:10`), so **no model change is needed** — we seed templates, not new fields.

### The editor model

A `RulesetVersion` (DRAFT) is the working copy. The editor:

1. Renders the definition's `nodes` as an ordered stack of cards (`template`) in the engine's
   sequence; each card shows its `type`, a `source` selector (previous node keys + `entry`),
   and the type-specific params **derived from `NODE_TYPE_SPEC`** (required/optional fields →
   labeled inputs). Nested composite structures (`aggregate.components`, `branches`,
   `conversion`, `bounded` extra round) are handled by dedicated sub-fields surfaced from the
   spec fields.
2. Actions are explicit round trips. `add`, `save`, `delete`, `move-up`, `move-down` all POST
   back to a single editor view which rebuilds the definition from the form, runs
   `parse_definition` for the **forward-only/type check**, and on success persists the DRAFT
   `RulesetVersion.definition`; on failure re-renders with inline per-node errors.
3. A `context` block (optional) carries `entry_size` / `rounds[{scope,scale,judge_count}]` /
   `votes` so count-dependent compiler checks can be non-blocking WARN instead of skipped —
   the compiler already supports an optional `context` (§16). The editor exposes these on a
   "Data context" sub-card.

`ParseError`-on-invalid-in-editor is impossible to avoid: the editor never lets staff hand-craft
JSON. All mutations go through the schema-validated rebuild.

### Why reuse NODE_TYPE_SPEC instead of hand-writing node forms

The schema already declares, per node type: `required`, `optional`, `source_refs`, `expects`,
and a `validate` callback. The compiler already turns a definition into a `ValidationReport`.
Hand-writing 13 per-node templates would duplicate this and drift. So the editor derives its
form fields from `NODE_TYPE_SPEC`: for each field in `required`/`optional` it picks a widget
(kind/range) from a small `_FIELD_WIDGET` table keyed by field name + a JSON-path hint. This is
the only cardinal new "serialization" code and it is pure and unit-testable.

## Increment 1 — Template Library + Genesis (headline value)

Seeds `RulesetTemplate` rows so staff stop hand-writing JSON. Provides the library list page and
a template detail that renders the `definition` for reading.

### Files
- `ruleset/templates.py` (new) — `FIRST_BATCH` (10 templates as definition dicts) +
  `GOLDEN_SCHIDUI` / `GOLDEN_XIAOFENG` (reuse the exact definitions from
  `singer_contest/tests.py:_schidui_definition`/`_xiaofeng_definition`); `seed_ruleset_templates()`
  idempotently creates/updates `RulesetTemplate` rows (content_hash-keyed, DRAFT status).
- `ruleset/management/commands/seed_ruleset_templates.py` (new) — wraps the seeder.
- `ruleset/admin.py` — already registers `RulesetTemplate`; no change.
- `staff_panel/views.py` — `ruleset_template_list`, `ruleset_template_detail`.
- `staff_panel/urls.py` — the two paths.
- `templates/staff_panel/ruleset_template_list.html`, `ruleset_template_detail.html` (new).
- `staff_panel/tests.py` — seeder idempotency; template list/detail render; golden templates
  appear; detail shows the node graph for the 院十佳 definition.
- Migrations: none (templates are data, seeded via command). Run `seed_ruleset_templates` in
  `scripts/bootstrap.ps1` so a fresh env gets them.

## Increment 2 — Ruleset Editor (Validate / Preview / Freeze)

The full editor over a `ContestRuleset`'s current DRAFT `RulesetVersion`. Ships the §14.7
acceptance: configure → Validate → Preview → Freeze, no code.

### Files
- `ruleset/editor.py` (new) — pure form <-> definition serialization:
  - `FIELD_WIDGETS` — field-name -> widget hint table.
  - `definition_from_form(form)` — rebuild a definition dict from submitted node fields
    (`parse_definition` to enforce graph legality).
  - `node_card_context(node)` — flattened view of a node + its source options + field specs.
  - `available_sources(nodes, index)` — prior node keys + `entry`.
  - `synthetic_resolve_input(definition)` — derive a deterministic synthetic `ResolveInput`
    (schema_version-uniform entry ids, per-round judge score tuples, vote scores) by scanning
    `ASSESS.round` / `vote_source` refs. No DB.
  - `preview_definition(definition)` — `compile_definition` → if passes, `resolve` over the
    synthetic input → returns `(report, plan, result)`.
- `staff_panel/views.py` — `contest_ruleset_create` (activity + template or blank),
  `ruleset_edit` (DRAFT version: add/save/delete/move-up/move-down),
  `ruleset_validate` (compile → report), `ruleset_preview` (synthetic sample), `ruleset_freeze`
  (POST → `freeze_ruleset_version`).
- `staff_panel/urls.py` — the paths.
- `templates/staff_panel/ruleset_editor.html` (new) — the node-card form stack + action loop.
  (`base.html` is reused; no new layout.)
- `staff_panel/tests.py` — the §14.7 acceptance walkthrough: 16人 → R1 40% / R2 60% → Top12 →
  R3 + Previous50/50 → Top6, configured via form submit, `ruleset_validate` clean,
  `ruleset_preview` shows the pool sizes + READY, `ruleset_freeze` persists a FROZEN current
  version (and refuses on an invalid graph); per-node add/delete/move round-trip; `within`
  scope renders; a MANUAL_SELECT/preview shows "需人工分组" review reason.

### Behavior specifics
- **Validate** returns `report.to_dict()` (errors/warns/review/info) and the `ExecutionPlan`
  summary (per-node candidate count, effective scale, decisive cutoffs, vote deps). An ERROR
  blocks Freeze (the service already enforces this; the editor surfaces it before the call).
- **Preview** shows per-node candidate count + output, warnings, and "unresolved manual node"
  (a MANUAL_SELECT node → its decision carries a review reason; the status is REVIEW/HOLD).
- **Freeze** POST calls `freeze_ruleset_version(version, request.user)`; `PermissionDenied`
  (non-admin / locked activity) and `RulesetInvalidError` (ERROR present) are surfaced as
  messages, never a 500.

## Deferred / boundary

- "Stage cards + drag sort + move up/down" is implemented as move-up/move-down buttons + card
  order; HTML5 drag is explicitly **out of scope** for I-1 (the spec §14.3 allows "上移/下移" as
  the first-version form; drag is a later polish).
- The editor's widget table does not try to make every node type fully bespoke — AGGREGATE
  `components`, SELECT `by`, PARTITION `by`, and `within` get dedicated sub-fields; BRANCH
  `branches` and AGGREGATE `conversion` are edited as structured sub-forms too (not raw JSON).
  Node types whose params are all scalar (RANK, ASSESS, SELECT, SUBTRACT, MERGE, FILL_TO_QUOTA,
  MANUAL_SELECT) are fully covered.
- No multi-process stress test; correctness inherited from the compiler/service, tested at the
  unit level.
- §14.4 "不要给普通 Staff 一个空白逻辑画布" — the editor is a **form over a template-driven
  graph**, never a blank canvas; complex branch/merge is reached through a seeded template or
  Clone Last Year, then edited field-by-field.
- AGGREGATE `conversion` and BRANCH `branches` sub-form editing is best-effort structured form;
  deep nested free-form formulas remain forbidden by the schema by design.

## Verification

1. `uv run ruff check ruleset staff_panel` + `uv run ruff format --check ruleset staff_panel`.
2. `uv run python manage.py makemigrations --check --dry-run` + `uv run python manage.py check`.
3. `uv run python manage.py test ruleset` + `uv run python manage.py test staff_panel`.
4. `uv run python manage.py test` (full, no regression).
5. `uv run python manage.py seed_ruleset_templates` then confirm 12 templates (10 batch + 2 golden).
6. Manual: staff_panel — create ruleset from 院十佳 template; add a node; Validate clean; Preview
   shows pool sizes; Freeze flips to FROZEN current.
7. §21 report; branch `m1-i-ruleset-editor`, author `Zn070515 <302025510036@zjut.edu.cn>`, no
   Co-Authored-By, non-ff merge to main, push via
   `GIT_SSH_COMMAND="ssh -o ProxyCommand=none" git push origin main`.
