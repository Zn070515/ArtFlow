# Planning Freeze and Round Safety Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent planning and business-editor writes from changing a round owned by the current frozen ruleset, reject conflicting shared-round execution facts, and preserve an explicitly configured minimum judge count when a round is prepared.

**Architecture:** Keep the planning compiler pure and reject conflicting configurations before materialization. Add the frozen-round guard at the database-aware preflight and the two round-writing service boundaries, while expanding the business-editor round snapshot to include every execution configuration field it can write. Make `prepare_round()` use the explicit minimum judge count when present and only apply the fail-safe default when it is absent.

**Tech Stack:** Django services and `TestCase`/`SimpleTestCase`, PostgreSQL-backed CI, SQLite local tests, `uv`, pytest, Ruff, mypy, Pyright.

**Spec:** `C:/Users/16275/Desktop/advices/ChatGPT.md`

## Global Constraints

- Work directly on a short-lived branch from a clean, up-to-date `main`; do not create linked worktrees or subagents.
- Preserve the existing Activity → ContestRuleset → RulesetVersion lock order and use audited authority services for round writes.
- Do not add defaults for planning facts; missing or conflicting execution facts must block apply.
- A current FROZEN ruleset is authoritative for every bound round; a successor draft may not mutate that round's execution configuration.
- Every production change must have a regression test that failed before the implementation and passed after it.
- Run focused tests after each task, then run the full local/CI-equivalent gates before merge and remote CI before claiming completion.

---

### Task 1: Freeze-bound round configuration isolation

**Files:**
- Modify: `ruleset/services.py` around `_BUSINESS_ROUND_CONFIGURATION_FIELDS`, `prepare_planning_preflight()`, and `save_business_ruleset()`.
- Modify: `singer_contest/services.py` in `configure_draft_round_from_planning()`.
- Test: `ruleset/test_planning.py` in `PlanningApplyServiceTests`.
- Test: `ruleset/test_services.py` in `BusinessRulesetSaveTests`.

**Interfaces:**
- `prepare_planning_preflight(version, payload)` remains read-only and returns a blocking `PlanningIssue` when a planned configuration differs from the current FROZEN binding's round.
- `_BUSINESS_ROUND_CONFIGURATION_FIELDS` includes `judge_count`, `minimum_judge_count`, and `rubric_id` in addition to the existing name/scoring/advancement/roster fields.
- `configure_draft_round_from_planning()` rejects a configuration change to a round referenced by the current FROZEN ruleset before saving or creating related state.

- [x] **Step 1: Write the failing freeze-isolation regression test.**

Create a draft round with `judge_count=5`, `minimum_judge_count=4`, and an existing activity-owned rubric. Bind that round to a current FROZEN version, create a successor DRAFT version, and submit a planning payload that changes the judge count and rubric. Assert that `prepare_planning_preflight()` is not safe to apply, `apply_planning_to_ruleset()` raises `ValidationError`, and the round fields, rubric count, frozen binding, and successor definition remain unchanged.

Also add a business-editor regression using `save_business_ruleset()` against a DRAFT successor whose requested source changes only `judge_count`, `minimum_judge_count`, or `rubric`; assert `PermissionDenied` and unchanged round state.

- [x] **Step 2: Run the focused tests to verify the regressions fail for the expected reason.**

Run:

```powershell
$env:APP_ENV='test'; $env:DEBUG='False'; uv run pytest -q ruleset/test_planning.py::PlanningApplyServiceTests ruleset/test_services.py::BusinessRulesetSaveTests
```

Expected: the new tests fail because preflight and business-save comparison do not yet treat the protected execution fields as frozen-bound configuration.

- [x] **Step 3: Expand the business round snapshot and desired comparison.**

Add `judge_count`, `minimum_judge_count`, and `rubric_id` to `_BUSINESS_ROUND_CONFIGURATION_FIELDS`. Extend `_business_stage_round_requests()` to carry the normalized source's explicit execution fields. Build `desired` in `save_business_ruleset()` from those explicit fields, compare every field before writing, and keep the protected-round rejection before any `ContestRound.save()`.

- [x] **Step 4: Add read-only planning preflight protection before materialization.**

Resolve the current FROZEN version for the activity, map its bound round IDs, and compare each planned round configuration against the bound round. Reuse the existing rubric comparison semantics for raw planning rubric definitions. Append a blocking `FROZEN_ROUND_CONFIGURATION` issue for any difference, including judge count, minimum judge count, rubric, name, scoring mode, advancement count, or roster scope. Do not create rubrics or rounds in this check.

- [x] **Step 5: Add a write-boundary defense in `configure_draft_round_from_planning()`.**

Before the audited save, compare the old and new configuration values. If the round is referenced by the activity's current FROZEN binding and any configuration field changes, raise `PermissionDenied`. Leave the existing DRAFT/unlocked guard and audit behavior intact.

- [x] **Step 6: Run the focused tests to verify the first task passes.**

Run the same focused command from Step 2. Expected: all selected planning and business-save tests pass, including unchanged-state assertions.

- [x] **Step 7: Commit the isolated fix.**

```powershell
git add ruleset/services.py singer_contest/services.py ruleset/test_planning.py ruleset/test_services.py
git commit -m "fix: isolate frozen round configuration"
```

### Task 2: Reject conflicting shared-round execution facts

**Files:**
- Modify: `ruleset/planning.py` in `prepare_planning_compile()`.
- Test: `ruleset/test_planning.py` in `PlanningCompileTests`.

**Interfaces:**
- `prepare_planning_compile()` keeps one configuration per stable `round_key`, but only returns an applyable result when all repeated references agree on execution fields.
- Allowed per-stage differences remain `business_ids`, score weights, stage context, and other reference-only fields.
- A conflict is represented by a blocking `PlanningIssue` with a stable code and the conflicting round key in `round_id`/`field_path`.

- [x] **Step 1: Write the failing shared-round consistency test.**

Build a payload with two stages referencing the same `round_key`, then change the second source's `judge_count` and rubric while leaving its score weight/stage context different as allowed. Assert that the compile result is not applyable and contains `INCONSISTENT_SHARED_ROUND_CONFIGURATION`; assert the message names the round and the differing field.

Add a second assertion or test proving that two references with identical judge count, minimum judge count, scoring mode, rubric, and roster scope remain applyable even though their business IDs and weights differ.

- [x] **Step 2: Run the focused compiler tests and verify the new conflict test fails.**

```powershell
$env:APP_ENV='test'; $env:DEBUG='False'; uv run pytest -q ruleset/test_planning.py::PlanningCompileTests
```

Expected: the conflicting payload currently compiles by retaining the first configuration.

- [x] **Step 3: Implement explicit shared-round field comparison.**

Define the execution comparison fields as `format`, `judge_count`, `minimum_judge_count`, `scoring_mode`, `rubric`, `roster_source`, and `roster_source_stage`, plus the first configuration's round name/advancement only where they are truly one-round properties. When a repeated source differs, append a blocking issue and continue collecting issues; do not overwrite the first configuration and do not silently accept the conflict.

- [x] **Step 4: Run the compiler tests and verify both conflict and compatible reuse pass.**

```powershell
$env:APP_ENV='test'; $env:DEBUG='False'; uv run pytest -q ruleset/test_planning.py::PlanningCompileTests
```

- [x] **Step 5: Commit the isolated compiler fix.**

```powershell
git add ruleset/planning.py ruleset/test_planning.py
git commit -m "fix: reject inconsistent shared round facts"
```

### Task 3: Preserve explicit minimum judge count at round preparation

**Files:**
- Modify: `singer_contest/services.py` in `prepare_round()`.
- Test: `singer_contest/tests.py` or a focused `singer_contest/test_*.py` module beside the owning behavior.

**Interfaces:**
- A round with `judge_count=N` and `minimum_judge_count=M` preserves `M` in the prepared round snapshot when `1 <= M <= N`.
- A round with `judge_count=N` and no explicit minimum keeps the current fail-safe behavior by setting the minimum to `N`.
- Invalid explicit minimum values are rejected before the round is prepared.

- [x] **Step 1: Write the failing preparation regression tests.**

Add a test with five anonymous judge channels and `minimum_judge_count=4`; after `prepare_round()` assert the persisted value is 4. Add a test with five channels and `minimum_judge_count=None`; assert the persisted value becomes 5. Add an invalid-configuration test for a minimum greater than the configured judge count and assert preparation raises `ValidationError` without moving the round out of DRAFT.

- [x] **Step 2: Run the focused tests and verify the explicit-minimum test fails.**

```powershell
$env:APP_ENV='test'; $env:DEBUG='False'; uv run pytest -q singer_contest/tests.py -k "minimum_judge_count or prepare_round"
```

Expected: the explicit minimum currently becomes the total judge count.

- [x] **Step 3: Implement the minimal fail-safe behavior.**

In the anonymous-judge branch, validate an explicit minimum against the actual judge count, assign `judge_count` only when `minimum_judge_count is None`, and save the preserved value through the existing authority path. Keep the existing drop-high-low minimum-three-judge validation and all roster/snapshot logic unchanged.

- [x] **Step 4: Run focused singer-contest tests.**

```powershell
$env:APP_ENV='test'; $env:DEBUG='False'; uv run pytest -q singer_contest/tests.py -k "minimum_judge_count or prepare_round"
```

- [x] **Step 5: Commit the isolated preparation fix.**

```powershell
git add singer_contest/services.py singer_contest/tests.py
git commit -m "fix: preserve configured minimum judge count"
```

### Task 4: Cross-flow verification and delivery

**Files:**
- Verify: all modified files and configuration sweep targets from `AGENTS.md`.
- Update: `docs/superpowers/plans/2026-10-13-planning-freeze-round-safety.md` checkboxes as work completes.

- [x] **Step 1: Run the complete focused regression set.**

```powershell
$env:APP_ENV='test'; $env:DEBUG='False'; uv run pytest -q ruleset/test_planning.py ruleset/test_services.py singer_contest/tests.py
```

- [x] **Step 2: Run the project quality gates.**

```powershell
$env:APP_ENV='development'; $env:DEBUG='False'; uv run python manage.py check
$env:APP_ENV='development'; $env:DEBUG='False'; uv run python manage.py makemigrations --check --dry-run
uv run ruff check .
uv run ruff format --check .
uv run mypy
npm run check:pyright
npm run check:client
npm run check:e2e
pwsh -NoProfile -File scripts/check_docs.ps1
```

- [x] **Step 3: Run the CI-equivalent parallel suite and PostgreSQL acceptance gate.**

```powershell
$env:APP_ENV='development'; $env:DEBUG='False'; $env:DATABASE_ENGINE='sqlite'; uv run pytest -q -n auto --maxprocesses=4 --dist=loadscope --durations=30
pwsh -NoProfile -File scripts/verify_postgres_acceptance.ps1 -StartCompose -VerifyResetSafety
```

- [x] **Step 4: Review the final diff and configuration sweep.**

Check `pyrightconfig.json`, `pyproject.toml`, `tailwind.config.js`, `tsconfig*.json`, environment examples, ignore files, and Dependabot entries against the current tree. Run `git diff --check` and confirm no generated media, database, coverage, or staticfiles artifacts are tracked.

- [x] **Step 5: Commit, merge, push, and monitor CI.**

```powershell
git status --short
git diff --check
git switch main
git pull --ff-only origin main
git merge --no-ff fix/planning-frozen-round-safety -m "merge: harden planning round safety"
git push origin main
gh run list --branch main --limit 10
```

Do not claim completion until the new commit's CI, PostgreSQL integration, Security, and Workflow lint runs are completed successfully and `main` is clean and equal to `origin/main`.
