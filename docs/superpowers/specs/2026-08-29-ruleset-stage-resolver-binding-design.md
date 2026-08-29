# M1-F — 2025 院十佳 Golden Simulation (DB-bound)

Date: 2026-08-29 · Feature branch `m1-f-ruleset-binding` · Author `Zn070515`

## Problem

M1-E ships the pure, DB-free `resolve()` engine (`ruleset/resolver.py`) that replays a
frozen ruleset over raw facts and emits per-contestant `StageDecision`s with a
HOLD/REVIEW/READY state. It is bounded to the linear node subset and is **not bound to
the DB**. M1-F makes it real: add result models + a migration, bind `ContestRound` /
`ScoreRecord` / normalized audience scores into a `ResolveInput`, persist results, and
prove the whole stack reproduces the 2025 院十佳 Excel formula (§11) with **no `2025`
special-casing in Python** (§18 audit).

## Architecture decision (resolves M1-E's "injected seed" hypothesis)

M1-E deferred "cross-stage composite (Stage2 = Stage1·w + R3·w) as an injected seed".
Investigation found a **cleaner realization: the entire 院十佳 chain is ONE frozen
definition, resolved with ONE `resolve()` call.** Cross-stage composite is simply
composite-of-composite within one graph (already proven by the M1-D fixture
`weighted_previous_composite_topn`).

The only missing generic primitive was **roster scoping**: §11.8 says only advancees
perform R3/R4, so `Stage2`/`Final` composites must compute *only for the current
advancees* (otherwise the 5 eliminated contestants lack R3 scores → spurious HOLD). The
engine addition is an optional `within` field on AGGREGATE (a ROSTER node key) that
restricts the computed pool to that roster. ASSESS needs no change — set its `source` to
the advance roster (`top10`, `top5`) so it only scores those contestants.

The 2025-specific numbers (weights 30/60/10, 60/40, 30/50/20 and 15→10→5→3) all live in
the **definition**, not in Python. The driver is generic (just call `resolve()`). §11.7
"同一套通用 primitive" and §18 "无 2025 特判" are satisfied.

### The 院十佳 definition (single graph, one resolve)

```
assess_r1   ASSESS source=entry round=r1
assess_r2   ASSESS source=entry round=r2
assess_a1   ASSESS source=entry vote_source=audience1
stage1      AGGREGATE within=entry  [r1 .30, r2 .60, audience1 .10]
rank1       RANK source=stage1 desc
top10       SELECT source=rank1 count=10
assess_r3   ASSESS source=top10 round=r3
stage2      AGGREGATE within=top10  [stage1 .60, r3 .40]
rank2       RANK source=stage2 desc
top5        SELECT source=rank2 count=5
assess_r4   ASSESS source=top5 round=r4
assess_a4   ASSESS source=top5 vote_source=audience4
final       AGGREGATE within=top5   [r3 .30, r4 .50, audience4 .20]
rank3       RANK source=final desc
top3        SELECT source=rank3 count=3
```

Forward refs are all satisfied. The engine reads `within`=top10/top5 to scope the
aggregate pool; assess nodes read the advance roster as their `source`.

### Compiler change

The M1-D compiler's static completeness check (`_check_dependency`) rejects an aggregate
that mixes a full-roster source (`stage1`) with a subset-roster source (`assess_r3`) —
it cannot statically guarantee every pool member has both component scores. With
`within` present the pool IS the advance roster, so the concern is structurally resolved:
**`_check_dependency` short-circuits when the aggregate has `within`.** This is additive
and does not affect any existing `within`-free fixture.

## Files

### Core engine + schema (additive)
- **`ruleset/schema.py`** — add `within` to the AGGREGATE optional tuple; add
  `source_refs`/`expects={"within": _ROSTER}`.
- **`ruleset/resolver.py`** — `_aggregate` reads `node.get("within")`; pool =
  `st.values[within]` (roster order) when present, else the union of component scoremaps.
- **`ruleset/compiler.py`** — `_check_dependency` returns immediately for a
  `within`-scoped aggregate.

### Result models + migration
- **`singer_contest/models.py`** — `StageResult` (FK activity, FK `ruleset.RulesetVersion`
  PROTECT, FK created_by, `stage_key`, `status` from `ResolverState`, `reasons` JSON,
  `content_hash`, `schema_version`, `plan_version`, `result_version`, `computed_at`,
  `is_test_data`), `StageDecision` (FK stage_result, FK singer, `outcome_code`,
  `source_node`, `rank`, `score`, `reason`, `is_test_data`), `CompositeResult` (FK
  stage_result, FK singer, `node_key`, `value`, `components` JSON, `is_test_data`, unique
  (result, singer, node_key)).
- Each carries a queryset guard: rows are immutable once the parent `StageResult.status`
  is `READY` (mirrors the frozen-ruleset immutable pattern). `clean()` enforces test-marker
  match against the activity lifecycle and singer-activity consistency.
- **`singer_contest/migrations/0012_*.py`** (new, additive).

### Binder + persistence service (generic)
- **`singer_contest/services.py`** — `bind_resolve_input(version, activity, *, round_keys,
  vote_scores=None, ...)` reads the roster from approved, runtime-scoped singers (canonical
  pk order) and `round_scores` raw from `ScoreRecord` grouped round→singer→judge scores;
  `vote_scores` are ready normalized values (caller-supplied — never re-derived from raw
  votes, §16.9). `_plan_from_version` builds an `ExecutionPlan`. `persist_stage_result`
  writes children atomically. `run_ruleset(version, activity, *, stage_key, computed_by,
  round_keys, vote_scores=None, ...)` is the single generic entry: bind → resolve → persist.

### Golden simulation test (DB-bound, deterministic)
- **`singer_contest/tests.py`** — `_schidui_definition()` + `GoldenSchiduiDbTests`:
  build the 15-contestant fixture through the DB (5 identical judge scores per round so
  the engine's mean reproduces the target), pass synthetic pre-normalized audience scores,
  run `run_ruleset`, and assert the §11.3 layered Decimals, the `READY` state, the
  `DIRECT`/`ELIMINATED` outcome codes, and persisted `StageResult`/`StageDecision`/
  `CompositeResult`round-trip.
- **`ruleset/test_resolver.py`** — `GoldenSchiduiTopTenTests` (pure, DB-free) plus
  `ResolverWithinScopeTests`; **`ruleset/test_compiler.py`** — `within`-scoped composite
  compiles clean.

## Verification

1. `uv run ruff check ruleset singer_contest` + `uv run ruff format --check ruleset singer_contest`.
2. `uv run python manage.py test ruleset.test_resolver ruleset.test_schema ruleset.test_compiler`.
3. `uv run python manage.py test singer_contest` (new result-model + binder + golden tests).
4. `uv run python manage.py makemigrations --check --dry-run` (no drift).
5. `uv run python manage.py test` (full, no regression).
6. §21 report; non-ff merge to main; push via
   `GIT_SSH_COMMAND="ssh -o ProxyCommand=none" git push origin main`; author
   `Zn070515 <302025510036@zjut.edu.cn>`, **no Co-Authored-By**.

## Deferred to M1-G

- 校十佳屏峰 (control-flow-heavy: group direct / remainder / repechage / merge / manual
  group decision / conditional fill). The engine already supports the primitives; M1-G
  adds the 校十佳 definition + golden test. `BRANCH`/`AWARD` execution is still out of
  scope.
