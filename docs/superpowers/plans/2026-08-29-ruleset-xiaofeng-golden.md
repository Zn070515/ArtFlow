# M1-G 2025 校十佳屏峰 Golden Simulation Implementation Plan

**Goal:** Prove the 校十佳屏峰 control flow (group direct / remainder / repechage / merge / manual group decision / conditional fill) is expressible via the same generic primitives, and keep a deterministic, DB-bound golden.

**Architecture:** The entire 校十佳 chain is ONE frozen definition resolved with ONE `resolve()` call. The only engine addition is an optional `by` (a PARTITION node key) on SELECT that picks top-`count` per group. Everything else — SUBTRACT, MERGE, PARTITION, MANUAL_SELECT, FILL_TO_QUOTA — is already generic. Finalists are read from `node_values["filled"]` because every merged contestant already carries DIRECT/REPECHAGE via first-writer-wins.

**Tech Stack:** Python 3.12, Django 6.0.8, uv, `ruleset/{schema,compiler,resolver}.py`, `singer_contest/{models,services,tests}.py`.

---

### Task 1: SELECT `by` group-scope (engine + schema)

**Files:**
- Modify: `ruleset/schema.py` — SELECT NodeSpec `optional`/`source_refs`/`expects`.
- Modify: `ruleset/resolver.py:343` — `_select` reads `node.get("by")`.

- [x] **Step 1: Add `by` to the SELECT schema spec.** `optional=("tie_policy", "by")`, `source_refs=("source", "by")`, `expects={"source": _RANKED_ROSTER, "by": _GROUP_MAP}`.
- [x] **Step 2: Implement the group branch in `_select`.** When `by` present, iterate `st.values[by]` groups, pick `count` per group in partition order, flatten `picked`, assign DIRECT/REPECHAGE on first-writer-wins, and emit a boundary-tie REVIEW per group.

---

### Task 2: Compiler `by` support

**Files:**
- Modify: `ruleset/compiler.py` — `_resolve` SELECT branch + `_source_refs`.

- [x] **Step 1: `pool_sig`/`pool_relation` for a `by`-scoped select.** It stays a `POOL_SUBSET`; its flat size depends on the partition's group count, so `size = None if node.get("by") else node["count"]`.
- [x] **Step 2: `_source_refs` appends `node["by"]`.**

---

### Task 3: Golden 校十佳 full-graph resolve (pure, DB-free)

**Files:**
- Modify: `ruleset/test_schema.py` — `test_group_scoped_select_parses` + `xiaofeng_chain()`.
- Modify: `ruleset/test_resolver.py` — `ResolverGroupScopedSelectTests` + `GoldenSchiduiXiaofengTests`.
- Modify: `ruleset/test_compiler.py` — `test_xiaofeng_chain_compiles` + `test_xiaofeng_fallback_invalid_aggregate_rejected`.

- [x] **Step 1: `xiaofeng_chain()`** builds the 10-node chain (groups_initial / assess_r1 / rank_r1 / direct / leftover / repech_r1 / repech_rank / top12 / repech_r2 / repech_rank2 / top7 / merged / final_groups / manual / filled).
- [x] **Step 2: `_xiaofeng_inputs(manual)`** gives roster c1..c20, round_scores r1/r2, group_of initial_group+final_group, manual picks.
- [x] **Step 3: Assert G1–G4** — deterministic direct=[c1,c5,c9,c13,c17], top7=[c2,c3,c4,c6,c7,c8,c10], merged=12; filled GROUP_MAP per case; READY state.
- [x] **Step 4: §12.4 validator** — an aggregate referencing the full roster fails `MISSING_SCORE_DEPENDENCY`; the missing-round field is relaxed to `in ("r2", "r3")`.

---

### Task 4: DB-bound golden 校十佳

**Files:**
- Modify: `singer_contest/tests.py` — `_xiaofeng_definition()` + `GoldenSchiduiXiaofengDbTests`.

- [x] **Step 1: `_xiaofeng_definition()`** returns the same 10-node chain as JSON (no 2025 special-casing).
- [x] **Step 2: `GoldenSchiduiXiaofengDbTests.setUp`** — 20 singers, 5 judges, r1/r2 `ContestRound`s, deterministic `ScoreRecord`s (100−idx, 200−idx across 5 identical judges so the mean reproduces exactly).
- [x] **Step 3: `_group_of()` / `_manual()`** — 5 initial groups × 4, 3 final groups × 4, and a manual pick where F3 is short by one (exercises `FILL_TO_QUOTA`).
- [x] **Step 4: `run_ruleset`** — assert `stage.status == READY`, `decisions.count() == 20`, 5 DIRECT / 12 REPECHAGE / 3 ELIMINATED, direct winners are creation order 1/5/9/13/17 (global R1 rank 1/5/9/13/17), and the filled GROUP_MAP for the 6 finalists.

---

### Task 5: Lint / tests / merge

**Files:**
- Docs: `docs/superpowers/specs/2026-08-29-ruleset-xiaofeng-golden-design.md` (commit separately).
- Branch: `m1-g-xiaofeng-golden`.

- [ ] **Step 1: Lint.** `uv run ruff check ruleset singer_contest` + `uv run ruff format --check ruleset singer_contest`.
- [ ] **Step 2: Scoped suites.** `uv run python manage.py test ruleset.test_resolver ruleset.test_schema ruleset.test_compiler singer_contest`.
- [ ] **Step 3: Migration + system check.** `uv run python manage.py makemigrations --check --dry-run` + `uv run python manage.py check`.
- [ ] **Step 4: Full suite.** `uv run python manage.py test`.
- [ ] **Step 5: §21 report.**
- [ ] **Step 6: Commit + non-ff merge + push.** Branch `m1-g-xiaofeng-golden`, author `Zn070515 <302025510036@zjut.edu.cn>`, no Co-Authored-By, non-ff merge to main, `GIT_SSH_COMMAND="ssh -o ProxyCommand=none" git push origin main`.
