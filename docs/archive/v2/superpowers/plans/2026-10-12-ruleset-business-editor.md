# Ruleset Business Editor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close fixed-factor score conversion and add safe, human-readable, business-level ruleset editing without weakening ArtFlow's version, binding, freeze, audit, or questionnaire guarantees.

**Architecture:** Keep the existing JSON rules graph authoritative. Add strict conversion helpers shared by schema/compiler/resolver, a multi-section version patch service for atomic business saves, and a pure business editor that can generate only a supported linear graph. Existing complex graphs remain readable but are marked non-editable. The Django page will place the business form first and retain the node editor as an explicitly advanced surface.

**Tech Stack:** Django, Python `Decimal`, existing `TestCase`/`SimpleTestCase`, Django templates, Tailwind utility classes, existing Ruleset Compiler/Resolver.

**Spec:** `docs/superpowers/specs/2026-10-12-ruleset-business-editor-design.md`

## Global Constraints

- Support only `factor`; `minmax` and `rank` remain compiler errors.
- Conversion occurs before aggregate weights and uses `Decimal` end to end.
- A conversion must name a direct component source and explicit positive numeric `from`, `to`, and `factor` values.
- Raw vote counts never become score components; existing `VoteScoringRule` remains the vote conversion authority.
- Blank creation starts with one legal `ROSTER` node and cannot freeze until actual contest rules or a checkpoint exists.
- Business edits patch `nodes`, `checkpoints`, and `context.business` atomically while preserving `questionnaire` and unrelated context keys.
- Frozen versions and prepared/non-draft rounds are never modified by the business editor.
- All writes retain Activity-first locking, `base_content_hash`/`base_binding` stale-write checks, and AuditLog coverage.
- No React/Vue/new frontend framework and no new score/ruleset database entity.

---

### Task 1: Define and validate fixed-factor conversion

**Files:**
- Modify: `ruleset/schema.py`
- Modify: `ruleset/compiler.py`
- Test: `ruleset/test_schema.py`
- Test: `ruleset/test_compiler.py`

**Interfaces:**
- `ruleset.schema._validate_conversion(name, node)` accepts canonical numeric conversion objects and rejects missing source, non-positive numeric fields, duplicate entries, unsupported methods, and non-component sources.
- `ruleset.compiler._conversion_for_component(node, source)` returns the validated conversion entry or `None`.
- `ruleset.compiler._conversion_factor(node, source, source_scale, target_scale)` returns a `Decimal` factor or emits a structured compiler issue through its caller.

- [ ] **Step 1: Write failing schema tests** for a valid 10→100 conversion, numeric 50→100 conversion, missing `source`, missing/invalid `factor`, duplicate source, conversion source not in aggregate components, and `minmax`/`rank` declarations.
- [ ] **Step 2: Run the schema tests and verify the new cases fail for the intended validation reason.**
- [ ] **Step 3: Implement numeric scale parsing and strict conversion validation** without changing non-conversion node contracts. Preserve accepted symbolic `hundred` input as a compatibility alias for numeric 100 only where it is unambiguous.
- [ ] **Step 4: Write failing compiler tests** proving: a valid conversion passes; an unconverted 50/100 mix remains `SCALE_MIXED`; a factor mismatch yields `CONVERSION_FACTOR_MISMATCH`; a bound actual rubric scale mismatch yields `CONVERSION_SOURCE_SCALE_MISMATCH`; a conversion with unknown source scale yields `SCALE_UNDECLARED`; and a valid plan records target/component conversion details.
- [ ] **Step 5: Run those compiler tests and confirm they fail before implementation.**
- [ ] **Step 6: Implement compiler conversion checking** so `_check_conversion` validates only `factor`, while `_check_scale` compares effective post-conversion scales and never returns early when an unknown scale is mixed with known scales. Add conversion metadata to `_node_plan` so the frozen execution plan records the exact factors and source/target scales.
- [ ] **Step 7: Run `uv run python manage.py test ruleset.test_schema ruleset.test_compiler` and keep all existing tests green.**
- [ ] **Step 8: Commit:** `feat: validate fixed-factor score conversion`.

### Task 2: Execute conversion in Resolver with exact Decimal replay

**Files:**
- Modify: `ruleset/resolver.py`
- Test: `ruleset/test_resolver.py`

**Interfaces:**
- `ruleset.resolver._converted_component_value(node, component, value)` returns a `Decimal` after applying the component's fixed factor, or raises the existing resolver hold path with a deterministic reason for malformed runtime data.
- `CompositeResult.rows` continues to expose source, weight, raw-or-converted component value, and weighted contribution in deterministic declaration order.

- [ ] **Step 1: Add a failing golden resolver test** for a 10-mark score of 9 and a 100-mark score of 86, each weighted 0.5, asserting composite `88`, `Decimal` type, and identical output on a second resolve.
- [ ] **Step 2: Add failing tests** proving a conversion is applied before `weighted_sum`, `average` uses converted component values, missing conversion metadata holds rather than silently summing, and a raw vote component still holds/rejects according to the existing vote-source rules.
- [ ] **Step 3: Run only the new resolver tests and verify the expected failures.**
- [ ] **Step 4: Implement the minimal conversion lookup and Decimal multiplication** in `_aggregate`; leave same-scale aggregates unchanged and avoid any float conversion.
- [ ] **Step 5: Run `uv run python manage.py test ruleset.test_resolver` and inspect the composite rows for exact values.**
- [ ] **Step 6: Run the compiler and resolver suites together; refactor only after green.**
- [ ] **Step 7: Commit:** `fix: execute score conversion before aggregation`.

### Task 3: Add atomic multi-section patches, freeze completeness, and blank starter/read summary

**Files:**
- Modify: `ruleset/services.py`
- Modify: `staff_panel/views.py`
- Modify: `ruleset/editor.py`
- Modify: `templates/staff_panel/ruleset_create.html`
- Modify: `templates/staff_panel/ruleset_editor.html`
- Test: `ruleset/test_definition_sections.py`
- Test: `ruleset/test_editor.py`
- Test: `staff_panel/tests.py`

**Interfaces:**
- `update_ruleset_definition_sections(version, *, sections, operator, base_content_hash=None)` locks and rereads one draft version, patches only named allowed sections, validates the complete root, and saves once.
- `ruleset.services.validate_definition_completeness(definition)` returns structured completeness issues; a root containing only `ROSTER` and no checkpoint is not freezeable.
- `human_ruleset_summary()` returns `state` (`empty`, `partial`, `complete`), `notice`, and safe stage cards even when checkpoints are absent; unsupported details are explicitly marked instead of guessed.

- [ ] **Step 1: Write failing section-service tests** proving multi-section updates preserve questionnaire/unrelated context, stale content hashes reject the whole transaction, and a validation error leaves all sections unchanged.
- [ ] **Step 2: Run the tests and verify the new API is absent/failing.**
- [ ] **Step 3: Implement `update_ruleset_definition_sections`** by reusing `_lock_version_for_write`, the existing section allow-list, full-root `parse_definition`, and questionnaire validation.
- [ ] **Step 4: Write failing completeness tests** for the `ROSTER`-only starter and for a valid scoring graph without checkpoints; only the former must be blocked.
- [ ] **Step 5: Add the completeness gate to `freeze_ruleset_version` and the validation report path** without invalidating existing production templates.
- [ ] **Step 6: Change `_starter_definition()` to JSON containing only `schema_version` and `ROSTER`; add empty/partial/complete summary tests and safe-copy tests.**
- [ ] **Step 7: Update the create/editor templates** so blank and partial states show an actionable “添加比赛环节” message, while complete states keep stage cards and the advanced details collapsed.
- [ ] **Step 8: Hide the freeze form for non-admin Staff while retaining the server-side admin route; add HTTP regression tests for Staff and Admin rendering.**
- [ ] **Step 9: Run `uv run python manage.py test ruleset.test_definition_sections ruleset.test_editor staff_panel.tests` with the focused test names first, then the whole app suites.**
- [ ] **Step 10: Commit:** `feat: support blank rulesets and atomic section edits`.

### Task 4: Build the pure linear business editor and audited ruleset/round service

**Files:**
- Create: `ruleset/business_editor.py`
- Modify: `ruleset/services.py`
- Test: `ruleset/test_business_editor.py`
- Create: `ruleset/test_services.py`

**Interfaces:**
- `infer_business_stages(definition)` returns `{supported, editable, reason, stages}` and never mutates input.
- `business_definition_from_stages(stages, *, existing_context=None)` returns `(nodes, checkpoints, business_context)` for a deterministic linear graph.
- `save_business_ruleset(version, *, stages, operator, base_content_hash=None, base_binding=None)` atomically validates the stage payload, locks the Activity/version/rounds, creates missing draft rounds when explicitly requested, updates draft round configuration, updates `round_keys`, and patches the three definition sections.

- [ ] **Step 1: Write failing pure-function tests** for empty stage lists, one stage, two stages with inherited score, judge/audience weights, deterministic keys, checkpoint generation, inference from the golden linear definition, and rejection of manual/group/branch graphs as non-editable.
- [ ] **Step 2: Run the pure tests and verify failure.**
- [ ] **Step 3: Implement inference and generation** with Decimal/string normalization, weight-total checks, explicit stage dependencies, and preservation of unrecognized definitions by returning `editable=False`.
- [ ] **Step 4: Write failing service tests** covering: creation of a missing draft round; update of an existing draft round's `scoring_mode`/`advance_count`; refusal to touch prepared rounds; stale `base_content_hash`; stale `base_binding`; atomic rollback when definition validation fails; preservation of questionnaire/context siblings; audit row creation; and deletion of a middle stage with a clear dependent-stage error.
- [ ] **Step 5: Run those service tests before implementation.**
- [ ] **Step 6: Implement the service** using the existing Activity-first lock, `update_ruleset_definition_sections`, `validate_binding`, and `AuditLog`; do not call model saves from the view.
- [ ] **Step 7: Run the pure and service tests, then the full `ruleset` suite.**
- [ ] **Step 8: Commit:** `feat: add audited business ruleset editing service`.

### Task 5: Expose the business editor in the staff UI without a new frontend framework

**Files:**
- Modify: `staff_panel/views.py`
- Modify: `templates/staff_panel/ruleset_editor.html`
- Modify: `templates/staff_panel/ruleset_create.html`
- Test: `staff_panel/tests.py`

**Interfaces:**
- Existing `ruleset_edit` GET context includes `business_editor`, round/vote choices, content/binding signatures, and safe read-only reasons.
- Existing `ruleset_edit` POST dispatches `action=business_save` through `save_business_ruleset`; no new URL is added, and advanced node actions remain available only in the collapsed advanced section.

- [ ] **Step 1: Add failing request tests** for stage cards, add-second-round flow, score-weight editing, advancement-count editing, hidden advanced editing for unsupported graphs, preservation of technical identifiers, and stale-content conflict messaging.
- [ ] **Step 2: Run the request tests and verify the missing UI/context failures.**
- [ ] **Step 3: Add view context assembly** from `infer_business_stages`, activity-owned draft rounds, vote sources, and binding signatures; reject business POSTs for frozen versions and non-editable definitions.
- [ ] **Step 4: Add the form markup** with one business entry point per round, clear “待确认”/“暂不绑定” labels, an add-stage control, dependency warnings, and admin-only freeze controls. Keep the advanced node editor below a `<details>` element.
- [ ] **Step 5: Run focused staff-panel tests and `pwsh -NoProfile -File scripts/check_docs.ps1` if user-facing docs/copy changed.**
- [ ] **Step 6: Commit:** `feat: expose human ruleset business editor`.

### Task 6: Configuration sweep, focused verification, and regression cleanup

**Files:**
- Inspect: `pyrightconfig.json`, `pyproject.toml`, `tailwind.config.js`, `tsconfig.client.json`, `tsconfig.e2e.json`, `.env.example`, `.env.production.example`, `.env.event.example`, `.gitignore`, `.dockerignore`, `.github/dependabot.yml`
- Modify: only the configuration file whose declared source/content set is proven stale by the sweep
- Test/verify: repository configuration and all affected suites

- [ ] **Step 1: Search the tree for every new Python/template file and confirm production modules are included by Pyright, mypy, Ruff, and Tailwind content globs.**
- [ ] **Step 2: Run `git diff --check` and `uv run python manage.py check`.**
- [ ] **Step 3: Run `uv run python manage.py makemigrations --check --dry-run` and `npm run check:pyright`.**
- [ ] **Step 4: Run `uv run python manage.py test ruleset staff_panel`.**
- [ ] **Step 5: Run `uv run python manage.py test` and record any unrelated baseline failures separately.**
- [ ] **Step 6: Run the template-related client/CSS gates:** `npm run check:css`, `npm run check:client`, and `npm run test:client`.
- [ ] **Step 7: Re-read the spec, map every acceptance item to a test or explicit safe refusal, inspect `git diff`, and commit any narrowly scoped verification fix separately.**

### Task 7: Finish the branch according to repository workflow

- [ ] **Step 1: Run the full fresh verification commands required before completion and capture exit codes/output.**
- [ ] **Step 2: Review `git status --short`, `git diff --check`, commit history, and changed-file scope.**
- [ ] **Step 3: Push the feature branch; if the push times out, retry with the documented proxy.**
- [ ] **Step 4: Switch to `main`, pull `--ff-only`, merge with `--no-ff`, and push `main`.**
- [ ] **Step 5: Verify final status and remote state, then report exact commits, tests, and any remaining limitations.**
