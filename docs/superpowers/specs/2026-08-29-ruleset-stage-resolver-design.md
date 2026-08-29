# M1-E — Deterministic StageResolver (design)

Date: 2026-08-29 · Feature branch `m1-e-stage-resolver` · Author `Zn070515`

## Problem

M1-D ships a *compiler* that proves a frozen `RulesetVersion` is valid
(`ValidationReport.passes()` → `ExecutionPlan`). But nothing **executes** it: a live
contest still lets staff hand-pick who advances (§10.1 says staff must never manually
execute deterministic rules at the venue). M1-E builds the runtime that replays a
ruleset over raw facts and publishes deterministic decisions.

## Scope (confirmed with user)

- **Pure engine + tests only.** A DB-free, deterministic `ruleset/resolver.py`
  (mirroring the M1-C schema / M1-D compiler pattern). **No new DB models, no
  migration.** Binding the engine to `ContestRound`/`ScoreRecord`/`VoteResult` and the
  golden simulation is **M1-F**.
- **Linear subset of node types.** Execute `ENTRY/ROSTER, PARTITION, PAIR, ASSESS,
  AGGREGATE, RANK, SELECT, SUBTRACT, MERGE, FILL_TO_QUOTA, MANUAL_SELECT` plus the
  tie→REVIEW path. `BRANCH` and `AWARD` are out of scope this stage (raise
  `UnsupportedNodeError` if a plan contains them; a later stage adds them).

This matches the repo convention of pure, hard-boundary modules (schema → compiler →
resolver) where each is independently testable without the Django DB.

## Determinism contract (§10.6 / §10.7)

`resolve(definition, inputs, plan=None)` is a **pure function** of `(definition, inputs)`:

- Never touches the DB, wall clock, random, or an unordered queryset.
- Inputs are frozen dataclasses; the engine never mutates them (verified by test).
- Ordering is canonical: the entry **roster tuple is the total order** used for every
  tie-break, partition iteration, merge dedupe, and `FillToQuota` fill order.
- `ResolveResult.to_dict()/from_dict()` round-trips stably (sorted keys where a dict is
  emitted; decisions/composites ordered by the roster).
- The `plan` argument only supplies **read-only metadata** (`content_hash`,
  `plan_version`, `schema_version`) for binding; it never affects computed values.

## Inputs — `ResolveInput` (frozen dataclass)

```python
@dataclass(frozen=True)
class ResolveInput:
    roster: tuple[str, ...]                         # canonical entry order (total order)
    round_scores: Mapping[str, Mapping[str, tuple[Decimal, ...]]] = {}  # round → contestant → judge scores
    vote_scores: Mapping[str, Mapping[str, Decimal]] = {}              # vote_source → contestant → score
    group_of: Mapping[str, Mapping[str, str]] = {}   # PARTITION "by" key → contestant → group value
    manual: Mapping[str, Mapping[str, tuple[str, ...]]] = {}  # manual node → group_key ("") → selected
```

Rationale: the engine stays raw. `round_scores` carries the *judge scores* per round so
the engine owns the scoring mode (`mean`/`trimmed_mean`); the binder (M1-F) only fans in
raw `ScoreRecord`s. Vote results arrive pre-normalized as a single score per contestant
(§16.9 normalization is applied by the binder; the engine only reads the ready value).

## Outputs

### `ResolverState` (enum `HOLD | REVIEW | READY`)
- **HOLD** — a necessary input is missing: a judge score for a pool contestant, a not-ready
  vote, an un-submitted `MANUAL_SELECT` decision, or a `FILL_TO_QUOTA` pool that cannot
  meet its need. The engine still computes a traceable partial result but every decision
  is `PENDING` and the caller must not use it (§10.8: never silently fewer).
- **REVIEW** — the system **has** a deterministic provisional answer but the rules demand a
  human stop (§18.1): a decisive cutoff tie that the plan does not auto-break
  (`tie_policy ∈ {manual, None, extra_round, score_fallback}`). Provisional order kept;
  borderline contestants flagged `PENDING`.
- **READY** — every input complete, every deterministic rule executed, every manual node
  decided; the result may be locked/announced.

### `StageDecision` (frozen)
`contestant, outcome_code, source_node, rank, score, reason` plus the bound metadata
(`content_hash`, `schema_version`, `plan_version`, `result_version`).

### Outcome codes (§14) — deterministic classifier
Maintained as a **per-contestant origin tag** that flows through the graph:

- init: each entry contestant has origin `{"entry"}`.
- `SUBTRACT(entry − advanced)`: remainder contestants' origin becomes `{"repechage"}`
  (they are the pool to retry).
- `SELECT` picks `c` → if `"repechage" in origin[c]` → `REPECHAGE`, else `DIRECT`; then
  `origin[c]` gets `{"selected"}` (stable, so later re-selection doesn't reclassify).
- `MANUAL_SELECT` picks `c` → `WILDCARD`.
- `FILL_TO_QUOTA` fills `c` → `FINALIST`.
- End of run: `PENDING` if `c` sits in a REVIEW cutoff, else the last assigned code, else
  `ELIMINATED` if still `entry`/`repechage` and never selected.
- `Composites`: one `CompositeResult` per contestant per `AGGREGATE` node, with the
  per-component `(source, weight, value, contribution)` breakdown.

## Node execution (deterministic)

| Node | Input | Output value | Notable rules |
|------|-------|--------------|---------------|
| ROSTER (entry) | `roster` | `tuple` | identity |
| PARTITION | Roster | GroupMap | `group_of[by]`; missing assignment → HOLD; groups in roster order |
| PAIR | Roster | PairSet | odd + no `odd_policy` → HOLD (compiler already ERRORs); otherwise pair in roster order |
| ASSESS | Roster | ScoreMap | `vote_source`→`vote_scores`; else `round`→`round_scores`; missing any pool score → HOLD; `trimmed_mean` drops top/bottom then averages (Decimal) |
| AGGREGATE | ScoreMaps | ScoreMap | `weighted_sum`=Σ(w·v), `average`=Σv/n; missing a component value for a pool contestant → HOLD (§16.2); optional `conversion` |
| RANK | ScoreMap | RankedRoster | sort desc/asc then roster order; never reorders ties by DB order |
| SELECT | RankedRoster | Roster | take `count`; boundary tie + non-auto-break `tie_policy` → REVIEW + `PENDING` borderline |
| SUBTRACT | Roster, Roster | Roster | minuend ∖ subtrahend, preserve minuend order |
| MERGE | Rosters | Roster | dedupe, first-seen order, sources in node order |
| FILL_TO_QUOTA | Roster, GroupMap | GroupMap | §10.8 generic primitive (see below) |
| MANUAL_SELECT | Roster/GroupMap | GroupMap | needs `manual[key]`; absent → HOLD with §10.9 message; picks allowed `0..quota` |

### FillToQuota (§10.8) — generic primitive
`target` (each `into` group), `current selected`, `pool` (the `from` roster, ordered),
`ranking` (implicit: the `from` order), `exclude selected`, `take need`. For each group in
`into` order, `need = quota − current(group)`; if `need > 0`, pull contestant from the
`from` pool (skipping anyone already selected into a group) until `need` met. **If the
pool runs out before every group's need is met → HOLD** (never silently fill fewer).

### Unsupported
`BRANCH` / `AWARD` → `UnsupportedNodeError` (deferred; documented).

## Files

- **`ruleset/resolver.py`** (NEW, DB-free) — `OutcomeCode`, `ResolverState`,
  `RESULT_VERSION = 1`, `UnsupportedNodeError`, frozen dataclasses
  (`ResolveInput`, `StageDecision`, `CompositeResult`, `ResolveResult`),
  `resolve(definition, inputs, plan=None) -> ResolveResult`, and the ordered node
  executors + the outcome classifier.
- **`ruleset/test_resolver.py`** (NEW) — see tests below. Reuses
  `test_schema._def` + `weighted_composite_topn()` / `partition_subtract_repechage_merge()`.
- No migrations, no admin, no services, no schema/model edits.

## Tests (`SimpleTestCase`, DB-free)

1. `weighted_composite_topn` fully scored → **READY**, top-N `DIRECT`, below `ELIMINATED`.
2. One pool contestant missing a round score → **HOLD**, reason names the contestant.
3. Boundary tie, no `tie_policy` → **REVIEW**, borderline `PENDING`, provisional order stable.
4. Boundary tie, `tie_policy: auto_break` → **READY**, deterministic roster-order break.
5. `MANUAL_SELECT` with no submitted decision → **HOLD** + §10.9 message
   (来源 / 允许 0..quota / 当前已选).
6. `MANUAL_SELECT` with a submission → **READY**, outcome `WILDCARD`.
7. `FILL_TO_QUOTA` pool too small → **HOLD** (never silently fewer).
8. `FILL_TO_QUOTA` completes → **READY**, outcome `FINALIST`.
9. `partition_subtract_repechage_merge` full flow → **READY** with a mix of
   `DIRECT` / `REPECHAGE` / `WILDCARD` / `FINALIST` / `ELIMINATED`.
10. `trimmed_mean` scoring computes the expected average.
11. **Idempotency**: `resolve(def, inputs, plan)` twice → identical `to_dict()`.
12. **No raw mutation**: input dicts unchanged after resolve (frozen + assert).
13. **Binding**: passing a plan stamps `content_hash`/`schema_version`/`plan_version`/
    `result_version`.
14. **Perf (soft)**: synthesize 100 contestants × 10 judges × 3-stage composite; assert
    READY and wall time under a generous bound (≥ the §10.10 200 ms target but not so
    tight it flakes in CI).
15. `BRANCH`/`AWARD` in a definition → `UnsupportedNodeError`.

## Verification

1. `uv run ruff check ruleset` + `uv run ruff format --check ruleset`.
2. `uv run python manage.py check`.
3. `uv run python manage.py test ruleset` (M1-C + M1-D + M1-E green).
4. `uv run python manage.py test` (no regression).
5. `uv run python manage.py makemigrations --check --dry-run` (no drift — M1-E adds no models).
6. §21 report; commit author `Zn070515 <302025510036@zjut.edu.cn>`, **no Co-Authored-By**;
   non-ff merge to main; push via `GIT_SSH_COMMAND="ssh -o ProxyCommand=none" git push origin main`.

## Deferred to M1-F

- Binding plan round keys ↔ `ContestRound`, reading raw `ScoreRecord`/`VoteResult`,
  cross-stage composite ($15 Stage2 = Stage1·w + R3·w) as an injected seed.
- Persisting `StageResult`/`StageDecision`/`CompositeResult` + the golden 2025 simulation.
- `BRANCH`/`AWARD` execution & `REPLACE`.
