# M1-F Ruleset Stage Resolver Binding Implementation Plan

**Goal:** Bind the DB-free `resolve()` engine to the database and prove the whole stack reproduces the 2025 院十佳 Excel formula (§11) with no `2025` special-casing in Python (§18 audit).

**Architecture:** The entire 院十佳 chain is ONE frozen definition resolved with ONE `resolve()` call. Cross-stage composite is composite-of-composite within one graph. The only engine addition is an optional `within` (ROSTER node key) on AGGREGATE that scopes the computed pool to an advance roster. Result models + migration + a generic binder/persist service bind `ContestRound` / `ScoreRecord` / normalized `AudienceScore` into a `ResolveInput`, persist a `StageResult` + `StageDecision`s + `CompositeResult`s, and run the golden simulation end-to-end.

**Tech Stack:** Python 3.12, Django 6.0.8, uv, `ruleset/{schema,compiler,resolver}.py`, `singer_contest/{models,services}.py`.

---

### Task 1: AGGREGATE `within` roster scope (engine + schema)

**Files:**
- Modify: `ruleset/schema.py:74` — AGGREGATE NodeSpec `optional` + `expects`.
- Modify: `ruleset/resolver.py:298` — `_aggregate` reads `node.get("within")`.

- [x] **Step 1: Add `within` to the AGGREGATE schema spec.** `optional=("conversion", "within")`, `source_refs=("aggregate.components[].source", "within")`, `expects={"aggregate.components[].source": _SCOREMAP, "within": _ROSTER}`.
- [x] **Step 2: Scope the aggregate pool in `_aggregate`.** When `within` is present, `pool = tuple(st.values[within])`; otherwise `_union_pool(maps, st.idx)`. Components still read their own source map per contestant.

---

### Task 2: Compiler `within` short-circuit

**Files:**
- Modify: `ruleset/compiler.py` — `_check_dependency`.

- [x] **Step 1: Return early for `within`-scoped aggregates.** `_check_dependency` returns immediately when `node.get("within")` is truthy: a within-scoped aggregate only scores the referenced advance roster, so mixing a full-roster source (`stage1`) with a subset-roster source (`assess_r3`) is intentional and structurally sound.

---

### Task 3: Golden 院十佳 full-graph resolve (pure, DB-free)

**Files:**
- Modify: `ruleset/test_resolver.py` — `GoldenSchiduiTopTenTests` + `ResolverWithinScopeTests`.

- [x] **Step 1: `_def()` builds the 15→10→5→3 graph** (`assess_r1/r2/a1`, `stage1`, `rank1`, `top10`, `assess_r3`, `stage2`, `rank2`, `top5`, `assess_r4/a4`, `final`, `rank3`, `top3`).
- [x] **Step 2: `_inputs()`** gives roster c1..c15, round_scores r1/r2/r3/r4, vote_scores audience1/audience4.
- [x] **Step 3: Assert §11.3 layered Decimals** — stage1 (88.1…75.5), stage2 (92.46…84.00), final (97.0/96.0/95.0/94.0/93.0); READY state; top10/top5/top3 node_values; c1-c3 DIRECT rank 1/2/3, c4-c10 DIRECT, c11-c15 ELIMINATED.

---

### Task 4: Result models + migration

**Files:**
- Modify: `singer_contest/models.py` — `StageResult`, `StageDecision`, `CompositeResult` (+ queryset managers).
- Create: `singer_contest/migrations/0012_*.py`.

- [x] **Step 1: `StageResult`** — FK `activity`, FK `ruleset_version` (PROTECT), FK `created_by`, `stage_key`, `status` (ResolverState), `reasons` JSON, `content_hash`, `schema_version`, `plan_version`, `result_version`, `computed_at`, `is_test_data`; unique `(activity, stage_key, content_hash)`.
- [x] **Step 2: `StageDecision`** — FK `stage_result`, FK `singer`, `outcome_code`, `source_node`, `rank`, `score`, `reason`, `is_test_data`; unique `(stage_result, singer)`.
- [x] **Step 3: `CompositeResult`** — FK `stage_result`, FK `singer`, `node_key`, `value`, `components` JSON, `is_test_data`; unique `(stage_result, singer, node_key)`.
- [x] **Step 4: Immutable queryset guards** — `update`/`delete`/`bulk_update` blocked once parent `StageResult.status == READY`.
- [x] **Step 5: `makemigrations`** — `0012_stageresult_stagedecision_compositeresult_and_more.py`.

---

### Task 5: Binder + persistence service

**Files:**
- Modify: `singer_contest/services.py` — `bind_resolve_input`, `_plan_from_version`, `persist_stage_result`, `run_ruleset`.

- [x] **Step 1: `bind_resolve_input(version, activity, *, round_keys, vote_scores=None, group_of=None, manual=None)`** — roster = approved runtime-scoped singers by pk; round_scores grouped round→singer→judge from `ScoreRecord`; vote_scores caller-supplied (never re-derived from raw votes, §16.9).
- [x] **Step 2: `_plan_from_version(version)`** — reuse stored `execution_plan` or compile; reject invalid plan.
- [x] **Step 3: `persist_stage_result(...)`** — transactional; create `StageResult` + bulk_create decisions/composites; validate version-activity match and singer round-trip.
- [x] **Step 4: `run_ruleset(...)`** — bind → resolve → persist as a single generic entry.

---

### Task 6: Golden end-to-end (DB-bound)

**Files:**
- Modify: `singer_contest/tests.py` — `_schidui_definition()`, `StageResultModelTests`, `StageResolverBindingTests`, `GoldenSchiduiDbTests`.

- [x] **Step 1: `_schidui_definition()`** — the same 15→10→5→3 graph as JSON.
- [x] **Step 2: DB fixture** — 15 Singers, 5 Judges, ContestRounds r1..r4, five identical judge scores per round (so the engine mean reproduces §11.3), synthetic pre-normalized audience scores.
- [x] **Step 3: Run `run_ruleset`**, assert §11.3 layered Decimals, READY, DIRECT/ELIMINATED outcome codes, and persisted `StageResult`/`StageDecision`/`CompositeResult` round-trip.
- [x] **Step 4: Model characterization tests** — create + FK + test-marker-match validation + immutability.

---

### Task 7: Lint / tests / merge

- [x] **Step 1:** `uv run ruff check ruleset singer_contest` + `uv run ruff format --check ruleset singer_contest`.
- [x] **Step 2:** `uv run python manage.py test ruleset singer_contest` — 200 pass, 6 skipped.
- [x] **Step 3:** `uv run python manage.py makemigrations --check --dry-run` → no drift; `uv run python manage.py check`.
- [x] **Step 4:** `mv run python manage.py test` (full suite, no regression).
- [x] **Step 5:** §21 report; feature branch `m1-f-ruleset-binding`; non-ff merge to main; push via `GIT_SSH_COMMAND="ssh -o ProxyCommand=none" git push origin main`; author `Zn070515 <302025510036@zjut.edu.cn>`, no Co-Authored-By.

---

## Verification

1. `uv run ruff check ruleset singer_contest` + `format --check`.
2. `uv run python manage.py test ruleset singer_contest` (M1-C/M1-D/M1-E stay green; `within` change additive).
3. `uv run python manage.py test singer_contest` (result-model + binder + golden tests).
4. `uv run python manage.py makemigrations --check --dry-run`.
5. `uv run python manage.py test` (full).
6. §21 report; non-ff merge to main; push.

## Deferred to M1-G

- 校十佳屏峰 (control-flow-heavy: group direct / remainder / repechage / merge / manual group decision / conditional fill). `BRANCH`/`AWARD` execution still out of scope.
