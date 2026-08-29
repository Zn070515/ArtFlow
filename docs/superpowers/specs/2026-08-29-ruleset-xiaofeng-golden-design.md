# M1-G — 2025 校十佳屏峰 Golden Simulation (control-flow, DB-bound)

Date: 2026-08-29 · Feature branch `m1-g-xiaofeng-golden` · Author `Zn070515`

## Problem

M1-F proved the DB-bound engine reproduces the 2025 院十佳 Excel formula (§11) — a
**linear, single-track** chain (15 → 10 → 5 → 3) with no branching. The 校十佳屏峰
(§12) is the other half of the story: its historical flow is **control-flow-heavy**, with
group-direct advancement, a remainder/repechage track, a merge of both tracks, per-group
final selection, manual group decision, and conditional fill-to-quota. The job of M1-G is
to prove all of that control flow is expressible with the **same generic primitives** —
no dedicated 屏峰 resolver, no per-node Python branch — and to keep the golden
deterministic and DB-bound.

## Architecture decision (resolves the group-top1 gap)

The 校十佳 chain differs from 院十佳 in one fundamental way: the first stage advances
**top1 per initial group**, not top-N globally. A global `SELECT count=1` would advance
only the single highest-scoring contestant overall, which is wrong. Group-scoped top-1
cannot be expressed by any combination of the existing primitives (SELECT, SUBTRACT,
MERGE, RANK) alone.

**The one engine addition:** `SELECT` gains an optional `by` field (a PARTITION node key
producing a GROUP_MAP). When `by` is present, the select picks `count` per group and
flattens the per-group leads in partition order. Roster-first semantics (a contestant
belongs to exactly one group) keep the per-group picks disjoint, so the result is a valid
ROSTER. Everything else — SUBTRACT remainder, MERGE tracks, PARTITION final-groups,
MANUAL_SELECT, FILL_TO_QUOTA — is already a generic M1-C/M1-D/M1-E primitive.

The 2025-specific numbers (5 groups × 4 singers, top1/group, R1 top12, R2 top7, 3 final
groups × quota 2, finalists 6) all live in the **definition**, not in Python. The driver is
generic (`run_ruleset`). §12.7 "同一套通用 primitive" and §18 "无 2025 特判" are
satisfied.

### The 校十佳 definition (single graph, one resolve)

```
groups_initial PARTITION source=entry by=initial_group
assess_r1       ASSESS source=entry round=r1
rank_r1         RANK source=assess_r1 desc
direct          SELECT source=rank_r1 count=1 by=groups_initial
leftover        SUBTRACT minuend=entry subtrahend=direct
repech_r1       ASSESS source=leftover round=r1
repech_rank     RANK source=repech_r1 desc
top12           SELECT source=repech_rank count=12
repech_r2       ASSESS source=top12 round=r2
repech_rank2    RANK source=repech_r2 desc
top7            SELECT source=repech_rank2 count=7
merged          MERGE sources=[direct, top7]
final_groups    PARTITION source=merged by=final_group
manual          MANUAL_SELECT source=final_groups groups=3 quota=2
filled          FILL_TO_QUOTA from=merged into=manual quota=2
```

The `direct` select (with `by=groups_initial`) is the group-scoped primitive; `leftover`
SUBTRACT + `repech_*` + `top12/top7` is the remainder/repechage track; `merged` MERGE joins
the two tracks; `final_groups` PARTITION + `manual` MANUAL_SELECT + `filled`
FILL_TO_QUOTA implement the per-group final decision with conditional fill.

## Outcome-code caveat (read finalists from `node_values`, not outcome codes)

In 校十佳, `_select` assigns either DIRECT (no `repechage` origin tag) or REPECHAGE
(origin tag from the `leftover` SUBTRACT) on **first-writer-wins**. Every contestant who
reaches `merged` already carries one of those two codes — the `direct` advancees via the
`direct` select, the `repech` advancees via `top12`/`top7`. The later `manual`/`filled`
nodes therefore never overwrite a code (they only fill the GROUP_MAP roster). So the
**finalists must be read from `node_values["filled"]`** (the GROUP_MAP), not from any
per-contestant outcome code.

## §12.4 / §12.5 audit notes (recorded, not guessed)

- **§12.4 (historical fallback):** the historical formula references R1+R2+R3, but a
  R1-direct contestant has no R2. This must **fail validation** (`MISSING_SCORE_DEPENDENCY`)
  at compile time, never be guessed by the resolver. Covered by
  `CompilerInvalidCorpusTests::test_xiaofeng_fallback_invalid_aggregate_rejected`.
- **§12.5 (historical wording ambiguity):** the rulebook wording "第一轮小组第一、第二直接
  晋级" is ambiguous about whether the second place also advances directly. This stage records
  the ambiguity and uses **top1-per-group** as the golden control flow; a second direct slot is
  not added because the historical record does not resolve the ambiguity. The engine can express
  "top-2-per-group" by changing `count=1` to `count=2` in the `direct` select if a later review
  resolves it one way.

## Files

### Core engine + schema (small, additive)
- **`ruleset/schema.py`** — add `by` to the SELECT optional tuple; add `source_refs` entry
  `"by"` and `expects={"source": _RANKED_ROSTER, "by": _GROUP_MAP}`.
- **`ruleset/resolver.py`** — `_select` reads `node.get("by")`; when present, iterate the
  partition's groups and pick `count` per group in partition order, setting DIRECT/REPECHAGE
  on first-writer-wins and emitting a boundary-tie REVIEW per group.
- **`ruleset/compiler.py`** — `_resolve` marks a `by`-scoped select's pool size `None`
  (group count is not statically known); `_source_refs` appends `node["by"]`.

### Golden tests (pure, DB-free) — M1-G definition, in the ruleset package
- **`ruleset/test_schema.py`** — `test_group_scoped_select_parses` + the `xiaofeng_chain()`
  fixture (asserts the whole 10-node chain parses).
- **`ruleset/test_resolver.py`** — `ResolverGroupScopedSelectTests` (top1-per-group, group-scoped
  vs global) + `GoldenSchiduiXiaofengTests` G1–G4 (deterministic 20-singer inputs, layered
  READY + finalist assertions).
- **`ruleset/test_compiler.py`** — `test_xiaofeng_chain_compiles` (valid corpus) +
  `test_xiaofeng_fallback_invalid_aggregate_rejected` (§12.4).

### DB-bound golden — in the singer_contest package
- **`singer_contest/tests.py`** — `_xiaofeng_definition()` + `GoldenSchiduiXiaofengDbTests`:
  20 singers, 5 judges, r1/r2 `ScoreRecord`s, `group_of={"initial_group", "final_group"}`,
  `manual` picks with a short F3 (exercises `FILL_TO_QUOTA`), calling the generic
  `run_ruleset`. Asserts READY, 20 decisions with 5 DIRECT / 12 REPECHAGE / 3 ELIMINATED,
  direct winners at creation order 1/5/9/13/17 (global R1 rank 1/5/9/13/17), and the filled
  GROUP_MAP (`node_values["filled"]`) for the 6 finalists.

## Tasks (TDD, small increments)

1. **Schema `by`** — add optional `by` to SELECT; Test: a `by`-scoped select parses.
2. **Resolver `by`** — implement the group branch in `_select`; Test: top1-per-group returns
   per-group leads, distinct from a global top1; boundary-tie raises REVIEW not READY.
3. **Compiler `by`** — `_source_refs` + `pool size None`; Test: the full chain compiles clean.
4. **Golden 院… 校十佳 full-graph (pure)** — `xiaofeng_chain()` definition + deterministic
   20-singer inputs; assert G1–G4 READY + finalists.
5. **§12.4 invalid-fallback validator** — assert an aggregate referencing the full roster
   fails `MISSING_SCORE_DEPENDENCY`; relaxation: allow either `r2` or `r3` as the missing round.
6. **DB-bound golden** — `GoldenSchiduiXiaofengDbTests`; assert READY + the outcome-code
   distribution + direct winners + filled GROUP_MAP.
7. **Lint / tests / merge** — `ruff`, full `ruleset` + `singer_contest` + full `manage.py test`,
   `makemigrations --check`, `manage.py check`, §21 report, non-ff merge to main, push.

## Deferred to later stages

- 校十佳 is the last Excel-formula golden. `BRANCH`/`AWARD` execution and any conditional
  node execution remain out of scope for this stage (§8.6).
- Grouping a `direct`-first vs `repechage`-first ordering rule inside `merged` is assumed
  (direct advancees first) and is definition-level, not engine-level.

## Verification

1. `uv run ruff check ruleset singer_contest` + `uv run ruff format --check ruleset singer_contest`.
2. `uv run python manage.py test ruleset.test_resolver ruleset.test_schema ruleset.test_compiler`
   (M1-C/…/M1-F stay green — the `by` change is additive).
3. `uv run python manage.py test singer_contest` (M1-F + M1-G golden).
4. `uv run python manage.py makemigrations --check --dry-run` (no drift).
5. `uv run python manage.py check`.
6. `uv run python manage.py test` (full, no regression).
7. §21 report; non-ff merge of `m1-g-xiaofeng-golden` to main; push via
   `GIT_SSH_COMMAND="ssh -o ProxyCommand=none" git push origin main`; author
   `Zn070515 <302025510036@zjut.edu.cn>`, **no Co-Authored-By**.
