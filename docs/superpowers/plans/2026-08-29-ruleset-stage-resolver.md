# M1-E Deterministic StageResolver — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a pure, DB-free `ruleset/resolver.py` that deterministically replays a frozen ruleset's typed node graph over raw facts, publishing per-contestant `StageDecision`s with a `HOLD/REVIEW/READY` state, idempotent and never mutating raw inputs.

**Architecture:** Mirrors the M1-C schema / M1-D compiler pattern: one hard-boundary module, frozen dataclass I/O, no Django ORM. The entry roster tuple is the canonical total order for every tie-break and fill; `resolve()` is a pure function of `(definition, inputs)`. BRANCH/AWARD raise `UnsupportedNodeError` (deferred to a later stage).

**Tech Stack:** Python 3.12, Django 6.0.8, `decimal.Decimal`, dataclasses, `unittest`/`SimpleTestCase`. No migrations, no models, no DB.

---

## File structure

- **Create `ruleset/resolver.py`** — the deterministic engine (enums, frozen dataclasses, node executors, `resolve()`).
- **Create `ruleset/test_resolver.py`** — DB-free `SimpleTestCase` suite.
- Reuses `ruleset/schema._def` and `test_schema.weighted_composite_topn()` / `partition_subtract_repechage_merge()`.

---

### Task 1: resolver.py — enums, dataclasses, serde helpers

**Files:**
- Create: `ruleset/resolver.py`

- [ ] **Step 1: Write the header + enums + frozen dataclasses**

```python
from __future__ import annotations

import json
from dataclasses import dataclass, field
from decimal import Decimal
from enum import StrEnum
from typing import Mapping

from .schema import ENTRY_KEY, content_hash, parse_definition

RESULT_VERSION = 1


class UnsupportedNodeError(NotImplementedError):
    """A node type the M1-E linear resolver does not execute (BRANCH/AWARD)."""


class OutcomeCode(StrEnum):
    DIRECT = "direct"
    ADVANCED = "advanced"
    REPECHAGE = "repechage"
    PENDING = "pending"
    ELIMINATED = "eliminated"
    WILDCARD = "wildcard"
    FINALIST = "finalist"


class ResolverState(StrEnum):
    HOLD = "hold"
    REVIEW = "review"
    READY = "ready"


@dataclass(frozen=True)
class ResolveInput:
    roster: tuple[str, ...] = ()
    round_scores: Mapping[str, Mapping[str, tuple[Decimal, ...]]] = field(default_factory=dict)
    vote_scores: Mapping[str, Mapping[str, Decimal]] = field(default_factory=dict)
    group_of: Mapping[str, Mapping[str, str]] = field(default_factory=dict)
    manual: Mapping[str, Mapping[str, tuple[str, ...]]] = field(default_factory=dict)
```

- [ ] **Step 2: Add the output dataclasses**

```python
@dataclass(frozen=True)
class StageDecision:
    contestant: str
    outcome_code: OutcomeCode
    source_node: str = ""
    rank: int | None = None
    score: Decimal | None = None
    reason: str = ""
    content_hash: str = ""
    schema_version: int = 0
    plan_version: int = 0
    result_version: int = RESULT_VERSION

    def to_dict(self) -> dict:
        return {
            "contestant": self.contestant,
            "outcome_code": self.outcome_code.value,
            "source_node": self.source_node,
            "rank": self.rank,
            "score": str(self.score) if self.score is not None else None,
            "reason": self.reason,
            "content_hash": self.content_hash,
            "schema_version": self.schema_version,
            "plan_version": self.plan_version,
            "result_version": self.result_version,
        }

    @classmethod
    def from_dict(cls, data: dict) -> "StageDecision":
        score = data.get("score")
        return cls(
            contestant=data["contestant"],
            outcome_code=OutcomeCode(data["outcome_code"]),
            source_node=data.get("source_node", ""),
            rank=data.get("rank"),
            score=Decimal(score) if score is not None else None,
            reason=data.get("reason", ""),
            content_hash=data.get("content_hash", ""),
            schema_version=data.get("schema_version", 0),
            plan_version=data.get("plan_version", 0),
            result_version=data.get("result_version", RESULT_VERSION),
        )


@dataclass(frozen=True)
class CompositeResult:
    node_key: str
    contestant: str
    value: Decimal
    components: tuple[tuple[str, Decimal, Decimal, Decimal], ...]  # (source, weight, value, contribution)

    def to_dict(self) -> dict:
        return {
            "node_key": self.node_key,
            "contestant": self.contestant,
            "value": str(self.value),
            "components": [
                {"source": s, "weight": str(w), "value": str(v), "contribution": str(c)}
                for (s, w, v, c) in self.components
            ],
        }

    @classmethod
    def from_dict(cls, data: dict) -> "CompositeResult":
        return cls(
            node_key=data["node_key"],
            contestant=data["contestant"],
            value=Decimal(data["value"]),
            components=tuple(
                (c["source"], Decimal(c["weight"]), Decimal(c["value"]), Decimal(c["contribution"]))
                for c in data["components"]
            ),
        )


@dataclass(frozen=True)
class ResolveResult:
    status: ResolverState
    reasons: tuple[str, ...] = ()
    decisions: tuple[StageDecision, ...] = ()
    composites: tuple[CompositeResult, ...] = ()
    node_values: Mapping[str, object] = field(default_factory=dict)
    content_hash: str = ""
    schema_version: int = 0
    plan_version: int = 0
    result_version: int = RESULT_VERSION

    def to_dict(self) -> dict:
        return {
            "status": self.status.value,
            "reasons": list(self.reasons),
            "decisions": [d.to_dict() for d in self.decisions],
            "composites": [c.to_dict() for c in self.composites],
            "node_values": self.node_values,
            "content_hash": self.content_hash,
            "schema_version": self.schema_version,
            "plan_version": self.plan_version,
            "result_version": self.result_version,
        }

    @classmethod
    def from_dict(cls, data: dict) -> "ResolveResult":
        return cls(
            status=ResolverState(data["status"]),
            reasons=tuple(data["reasons"]),
            decisions=tuple(StageDecision.from_dict(d) for d in data["decisions"]),
            composites=tuple(CompositeResult.from_dict(c) for c in data["composites"]),
            node_values=data["node_values"],
            content_hash=data.get("content_hash", ""),
            schema_version=data.get("schema_version", 0),
            plan_version=data.get("plan_version", 0),
            result_version=data.get("result_version", RESULT_VERSION),
        )
```

- [ ] **Step 3: Add scalar/order helpers**

```python
def _as_dec(value) -> Decimal:
    return value if isinstance(value, Decimal) else Decimal(str(value))


def _order(roster: tuple[str, ...]) -> tuple[str, ...]:
    out = []
    seen = set()
    for c in roster:
        if c not in seen:
            seen.add(c)
            out.append(c)
    return tuple(out)


def _value_to_jsonable(value):
    if isinstance(value, tuple):
        return [_value_to_jsonable(x) for x in value]
    if isinstance(value, frozenset):
        return sorted(value)
    if isinstance(value, dict):
        return {key: _value_to_jsonable(val) for key, val in value.items()}
    if isinstance(value, Decimal):
        return str(value)
    return value
```

- [ ] **Step 4: Run the suite so far (will error on missing pieces is fine — no tests yet)**

Run: `uv run python manage.py check`
Expected: `System check identified no issues` (resolver imported only when used; module must be syntactically valid).

- [ ] **Step 5: Commit**

```bash
git add ruleset/resolver.py
git commit -m "feat(M1-E): resolver dataclasses + serde"
```

If the file presently lacks the executors it will import-fail only when `resolve()` is called. Do NOT call `resolve()` yet. Proceed to Task 2.

---

### Task 2: resolver.py — `_Stage` state + roster primitives (PARTITION/SUBTRACT/MERGE)

**Files:**
- Modify: `ruleset/resolver.py`

- [ ] **Step 1: Add the mutable driver state**

```python
class _Stage:
    """Mutable driver state; frozen into ResolveResult at the end."""

    def __init__(self, roster: tuple[str, ...]):
        self.roster = _order(roster)
        self.idx = {c: i for i, c in enumerate(self.roster)}
        self.values: dict[str, object] = {ENTRY_KEY: self.roster}
        self.outcome: dict[str, OutcomeCode] = {}
        self.source_node: dict[str, str] = {}
        self.origin: dict[str, set[str]] = {c: {"entry"} for c in self.roster}
        self.rank_pos: dict[str, dict[str, int]] = {}
        self.composites: list[CompositeResult] = []
        self.hold: list[str] = []
        self.review: list[str] = []
```

- [ ] **Step 2: Add PARTITION / SUBTRACT / MERGE executors**

```python
def _part(node: dict, st: _Stage, inputs: ResolveInput) -> dict:
    pool = st.values[node["source"]]
    by = node["by"]
    gmap = inputs.group_of.get(by)
    if not gmap:
        st.hold.append(f"PARTITION {node['key']} 未提供分组归属 {by}。")
        return {}
    groups: dict[str, list[str]] = {}
    for c in pool:
        g = gmap.get(c)
        if g is None:
            st.hold.append(f"PARTITION {node['key']} 缺失 {c} 的分组归属。")
            continue
        groups.setdefault(g, []).append(c)
    return {g: tuple(cs) for g, cs in groups.items()}


def _subtract(node: dict, st: _Stage) -> tuple:
    minuend: tuple = st.values[node["minuend"]]
    subtrahend: tuple = st.values[node["subtrahend"]]
    removed = set(subtrahend)
    remainder = [c for c in minuend if c not in removed]
    for c in remainder:
        st.origin[c] = {"repechage"}
    return tuple(remainder)


def _merge(node: dict, st: _Stage) -> tuple:
    out: list[str] = []
    seen: set[str] = set()
    for source in node["sources"]:
        for c in st.values[source]:
            if c not in seen:
                seen.add(c)
                out.append(c)
    return tuple(out)
```

- [ ] **Step 3: Commit**

```bash
git add ruleset/resolver.py
git commit -m "feat(M1-E): roster primitives (PARTITION/SUBTRACT/MERGE)"
```

---

### Task 3: resolver.py — scoring (ASSESS + AGGREGATE)

**Files:**
- Modify: `ruleset/resolver.py`

- [ ] **Step 1: Add `_union_pool` + ASSESS executor**

```python
def _union_pool(maps, idx):
    seen: dict[str, int] = {}
    for m in maps:
        for c in m:
            seen.setdefault(c, idx.get(c, 10 ** 9))
    return tuple(sorted(seen, key=lambda c: (seen[c], c)))


def _assess(node: dict, st: _Stage, inputs: ResolveInput) -> dict:
    pool: tuple = st.values[node["source"]]
    src = node.get("vote_source") or node.get("round")
    out: dict[str, Decimal] = {}
    if src is None:
        st.hold.append(f"ASSESS {node['key']} 未声明 round/vote_source，无法取分。")
        return out
    if node.get("vote_source"):
        table = inputs.vote_scores.get(src)
        if not table:
            st.hold.append(f"投票 {src} 尚无可用结果。")
            return out
        for c in pool:
            v = table.get(c)
            if v is None:
                st.hold.append(f"投票 {src} 缺失 {c} 结果。")
                continue
            out[c] = _as_dec(v)
    else:
        table = inputs.round_scores.get(src)
        if not table:
            st.hold.append(f"轮次 {src} 没有评分。")
            return out
        trims = int(node.get("trim_high") or 0) + int(node.get("trim_low") or 0)
        for c in pool:
            scores = table.get(c)
            if not scores:
                st.hold.append(f"轮次 {src} 缺失 {c} 评分。")
                continue
            dec = tuple(_as_dec(s) for s in scores)
            if node.get("mode") == "trimmed_mean":
                if len(dec) <= trims:
                    st.hold.append(f"轮次 {src} {c} 有效评委不足 ({len(dec)} <= {trims})。")
                    continue
                s = sorted(dec)
                body = s[int(node.get("trim_low") or 0): len(s) - int(node.get("trim_high") or 0)]
                out[c] = sum(body, Decimal("0")) / Decimal(len(body))
            else:
                out[c] = sum(dec, Decimal("0")) / Decimal(len(dec))
    return out
```

- [ ] **Step 2: Add AGGREGATE executor**

```python
def _aggregate(node: dict, st: _Stage, inputs: ResolveInput) -> tuple[dict, tuple]:
    comps = node["aggregate"]["components"]
    agg_type = node["aggregate"]["type"]
    maps = [st.values[c["source"]] for c in comps]
    pool = _union_pool(maps, st.idx)
    out: dict[str, Decimal] = {}
    comp_results: list[CompositeResult] = []
    for c in pool:
        rows = []
        broken = False
        for comp in comps:
            m = st.values[comp["source"]]
            v = m.get(c)
            if v is None:
                st.hold.append(
                    f"AGGREGATE {node['key']} 缺失分量 {comp['source']} 对 {c} 的分数。"
                )
                broken = True
                break
            w = _as_dec(comp["weight"])
            rows.append((comp["source"], w, v, w * v))
        if broken:
            continue
        if agg_type == "weighted_sum":
            value = sum((r[3] for r in rows), Decimal("0"))
        else:
            value = sum((r[2] for r in rows), Decimal("0")) / Decimal(len(rows))
        out[c] = value
        comp_results.append(CompositeResult(node["key"], c, value, tuple(rows)))
    return out, tuple(comp_results)
```

- [ ] **Step 3: Commit**

```bash
git add ruleset/resolver.py
git commit -m "feat(M1-E): scoring (ASSESS + AGGREGATE)"
```

---

### Task 4: resolver.py — RANK + SELECT (tie→REVIEW)

**Files:**
- Modify: `ruleset/resolver.py`

- [ ] **Step 1: Add RANK executor**

```python
def _rank(node: dict, st: _Stage, by_key: dict) -> tuple:
    m: dict = st.values[node["source"]]
    desc = node.get("descending", True)
    if desc:
        ordered = tuple(sorted(m.keys(), key=lambda c: (-m[c], st.idx[c])))
    else:
        ordered = tuple(sorted(m.keys(), key=lambda c: (m[c], st.idx[c])))
    st.rank_pos[node["key"]] = {c: i + 1 for i, c in enumerate(ordered)}
    return ordered
```

- [ ] **Step 2: Add SELECT executor**

```python
def _select(node: dict, st: _Stage, by_key: dict) -> tuple:
    ranked: tuple = st.values[node["source"]]
    count = node["count"]
    picked = list(ranked[:count])
    score_node = by_key[node["source"]].get("source")
    scores: dict = st.values.get(score_node, {}) if score_node else {}
    policy = node.get("tie_policy")
    for c in picked:
        if c not in st.outcome:
            code = OutcomeCode.REPECHAGE if "repechage" in st.origin.get(c, set()) else OutcomeCode.DIRECT
            st.outcome[c] = code
            st.source_node[c] = node["key"]
    if count > 0 and count < len(ranked):
        boundary = scores.get(ranked[count - 1])
        following = scores.get(ranked[count])
        if boundary is not None and following is not None and boundary == following:
            if policy != "auto_break":
                st.review.append(
                    f"SELECT {node['key']} 在截止名次 {count} 处同分，需人工核定 "
                    f"(tie_policy={policy or 'review'})。"
                )
                for c in ranked[count - 1:]:
                    if scores.get(c) == boundary and c not in st.outcome:
                        st.outcome[c] = OutcomeCode.PENDING
                        st.source_node[c] = node["key"]
    return tuple(picked)
```

- [ ] **Step 3: Commit**

```bash
git add ruleset/resolver.py
git commit -m "feat(M1-E): RANK + SELECT with tie→REVIEW"
```

---

### Task 5: resolver.py — FILL_TO_QUOTA + MANUAL_SELECT

**Files:**
- Modify: `ruleset/resolver.py`

- [ ] **Step 1: Add FILL_TO_QUOTA executor (§10.8)**

```python
def _fill(node: dict, st: _Stage, inputs: ResolveInput) -> dict:
    into: dict = st.values[node["into"]]
    pool: tuple = st.values[node["from"]]
    quota = node["quota"]
    result: dict[str, list[str]] = {}
    for g, cs in into.items():
        result[g] = list(cs)
    selected = {c for cs in result.values() for c in cs}
    pool_iter = list(pool)
    for g, cs in into.items():
        need = quota - len(result[g])
        while need > 0 and pool_iter:
            nxt = pool_iter.pop(0)
            if nxt in selected:
                continue
            result[g].append(nxt)
            selected.add(nxt)
            st.outcome[nxt] = OutcomeCode.FINALIST
            st.source_node[nxt] = node["key"]
            need -= 1
    unmet = {g: quota - len(result[g]) for g in into if quota - len(result[g]) > 0}
    if unmet:
        st.hold.append(
            f"FILL_TO_QUOTA {node['key']} 来源池不足，未能补满 {unmet}（永不静默少补）。"
        )
    return {g: tuple(cs) for g, cs in result.items()}
```

- [ ] **Step 2: Add MANUAL_SELECT executor (§10.9)**

```python
def _manual(node: dict, st: _Stage, inputs: ResolveInput) -> dict:
    src = st.values[node["source"]]
    is_group = isinstance(src, dict)
    pool_set = (
        {c for cs in src.values() for c in cs} if is_group else set(src)
    )
    decisions = inputs.manual.get(node["key"])
    if not decisions:
        st.hold.append(
            f"MANUAL_SELECT {node['key']} 需要人工决定：来源 {node['source']}，"
            f"允许 0~{node['quota']}，当前已选 0。"
        )
        return {}
    result: dict[str, tuple[str, ...]] = {}
    if is_group:
        for g in src:
            chosen = tuple(c for c in decisions.get(g, ()) if c in pool_set)
            for c in chosen:
                if c not in st.outcome:
                    st.outcome[c] = OutcomeCode.WILDCARD
                    st.source_node[c] = node["key"]
            result[g] = _order(chosen)
    else:
        chosen = _order(tuple(c for c in decisions.get("", ()) if c in pool_set))
        for c in chosen:
            if c not in st.outcome:
                st.outcome[c] = OutcomeCode.WILDCARD
                st.source_node[c] = node["key"]
        result[""] = chosen
    return result
```

- [ ] **Step 3: Commit**

```bash
git add ruleset/resolver.py
git commit -m "feat(M1-E): FILL_TO_QUOTA + MANUAL_SELECT primitives"
```

---

### Task 6: resolver.py — `resolve()` driver + status + decisions

**Files:**
- Modify: `ruleset/resolver.py`

- [ ] **Step 1: Add status + decisions builders**

```python
def _final_status(st: _Stage) -> ResolverState:
    if st.hold:
        return ResolverState.HOLD
    if st.review:
        return ResolverState.REVIEW
    return ResolverState.READY


def _build_decisions(
    st: _Stage,
    start: int,
    roster: tuple[str, ...],
    content_hash: str,
    schema_version: int,
    plan_version: int,
) -> tuple:
    out = []
    for c in roster:
        code = st.outcome.get(c, OutcomeCode.ELIMINATED)
        source_node = st.source_node.get(c, "")
        rank = None
        score = None
        for nkey in reversed(st.rank_pos):
            if c in st.rank_pos[nkey]:
                rank = st.rank_pos[nkey][c]
                break
        for nkey in reversed(list(st.values)):
            v = st.values[nkey]
            if isinstance(v, dict) and c in v and isinstance(v[c], Decimal):
                score = v[c]
                break
        out.append(
            StageDecision(
                contestant=c,
                outcome_code=code,
                source_node=source_node,
                rank=rank,
                score=score,
                reason="",
                content_hash=content_hash,
                schema_version=schema_version,
                plan_version=plan_version,
                result_version=RESULT_VERSION,
            )
        )
    return tuple(out)
```

- [ ] **Step 2: Add the `resolve()` entry point**

```python
def resolve(definition, inputs: ResolveInput, plan=None) -> ResolveResult:
    """Deterministically replay ``definition`` over ``inputs``.

    ``plan`` (an ExecutionPlan) supplies only read-only binding metadata. The engine
    is a pure function of ``(definition, inputs)``.
    """
    parsed = parse_definition(definition)
    nodes = parsed["nodes"]
    by_key = {n["key"]: n for n in nodes}
    obj = definition if isinstance(definition, dict) else json.loads(definition)
    ctx = obj.get("context") or {}
    st = _Stage(inputs.roster)
    for node in nodes:
        ntype = node["type"]
        if ntype == "ROSTER":
            st.values[node["key"]] = st.roster
        elif ntype == "PARTITION":
            st.values[node["key"]] = _part(node, st, inputs)
        elif ntype == "PAIR":
            st.values[node["key"]] = _pair(node, st)
        elif ntype == "ASSESS":
            st.values[node["key"]] = _assess(node, st, inputs)
        elif ntype == "AGGREGATE":
            val, comps = _aggregate(node, st, inputs)
            st.values[node["key"]] = val
            st.composites.extend(comps)
        elif ntype == "RANK":
            st.values[node["key"]] = _rank(node, st, by_key)
        elif ntype == "SELECT":
            st.values[node["key"]] = _select(node, st, by_key)
        elif ntype == "SUBTRACT":
            st.values[node["key"]] = _subtract(node, st)
        elif ntype == "MERGE":
            st.values[node["key"]] = _merge(node, st)
        elif ntype == "FILL_TO_QUOTA":
            st.values[node["key"]] = _fill(node, st, inputs)
        elif ntype == "MANUAL_SELECT":
            st.values[node["key"]] = _manual(node, st, inputs)
        elif ntype in ("BRANCH", "AWARD"):
            raise UnsupportedNodeError(
                f"Node {node['key']}: type {ntype} is not executed by the M1-E resolver."
            )
        else:
            raise UnsupportedNodeError(f"Node {node['key']}: unknown type {ntype}.")

    if plan is not None:
        content_hash = plan.content_hash
        schema_version = plan.schema_version
        plan_version = plan.plan_version
    else:
        content_hash = content_hash(obj)
        schema_version = parsed["schema_version"]
        plan_version = 0

    node_values = {
        k: _value_to_jsonable(v) for k, v in sorted(st.values.items(), key=lambda kv: kv[0])
    }
    decisions = _build_decisions(
        st, 0, st.roster, content_hash, schema_version, plan_version
    )
    return ResolveResult(
        status=_final_status(st),
        reasons=tuple(st.hold + st.review),
        decisions=decisions,
        composites=tuple(st.composites),
        node_values=node_values,
        content_hash=content_hash,
        schema_version=schema_version,
        plan_version=plan_version,
        result_version=RESULT_VERSION,
    )
```

- [ ] **Step 3: Add PAIR executor (used above)**

Append before the `resolve()` definition (module-level function is fine anywhere):

```python
def _pair(node: dict, st: _Stage) -> tuple:
    pool: tuple = st.values[node["source"]]
    if len(pool) % 2 == 1 and not node.get("odd_policy"):
        st.hold.append(f"PAIR {node['key']} 人数为奇数且无 odd_policy。")
        return ()
    out = []
    for i in range(0, len(pool) - 1, 2):
        out.append(frozenset((pool[i], pool[i + 1])))
    if len(pool) % 2 == 1:
        out.append(frozenset((pool[-1],)))
    return tuple(out)
```

- [ ] **Step 4: Commit**

```bash
git add ruleset/resolver.py
git commit -m "feat(M1-E): resolve() driver + status + decisions"
```

---

### Task 7: `ruleset/test_resolver.py` — the suite

**Files:**
- Create: `ruleset/test_resolver.py`

- [ ] **Step 1: Write the full test file**

```python
"""Tests for the M1-E deterministic StageResolver (§10, §18).

Pure, DB-free: resolve() must be a pure function of (definition, inputs),
idempotent, never mutating raw inputs. Covers READY/HOLD/REVIEW, the §14
outcome taxonomy, §10.8 FillToQuota, §10.9 ManualSelect, and a soft perf gate.
"""

import time
from decimal import Decimal

from django.test import SimpleTestCase

from ruleset.resolver import (
    OutcomeCode,
    ResolveInput,
    ResolveResult,
    ResolverState,
    UnsupportedNodeError,
    resolve,
)
from ruleset.schema import ENTRY_KEY, content_hash, parse_definition
from ruleset import compiler
from ruleset.test_schema import (
    _def,
    partition_subtract_repechage_merge,
    weighted_composite_topn,
)


def _scores(round_key, pairs):
    return {round_key: {c: (Decimal(str(v)),) for c, v in pairs.items()}}


class ResolverReadyTests(SimpleTestCase):
    def _inputs(self):
        return ResolveInput(
            roster=("a", "b", "c", "d"),
            round_scores=_scores(
                "r1", {"a": 90, "b": 80, "c": 70, "d": 60}
            ),
        )

    def test_weighted_composite_ready(self):
        # weight 1.0 on r1 (single component) → rank → select top 2
        definition = _def(
            [
                {"key": "assess", "type": "ASSESS", "source": ENTRY_KEY, "round": "r1"},
                {"key": "composite", "type": "AGGREGATE",
                 "aggregate": {"type": "weighted_sum",
                               "components": [{"source": "assess", "weight": 1.0}]}},
                {"key": "ranked", "type": "RANK", "source": "composite", "descending": True},
                {"key": "winners", "type": "SELECT", "source": "ranked", "count": 2},
            ]
        )
        result = resolve(definition, self._inputs())
        self.assertEqual(result.status, ResolverState.READY)
        by_c = {d.contestant: d for d in result.decisions}
        self.assertEqual(by_c["a"].outcome_code, OutcomeCode.DIRECT)
        self.assertEqual(by_c["b"].outcome_code, OutcomeCode.DIRECT)
        self.assertEqual(by_c["c"].outcome_code, OutcomeCode.ELIMINATED)
        self.assertEqual(by_c["d"].outcome_code, OutcomeCode.ELIMINATED)
        self.assertEqual(by_c["a"].rank, 1)
        self.assertEqual(by_c["a"].score, Decimal("90"))

    def test_rank_order_deterministic_and_descending(self):
        definition = _def(
            [
                {"key": "assess", "type": "ASSESS", "source": ENTRY_KEY, "round": "r1"},
                {"key": "ranked", "type": "RANK", "source": "assess", "descending": True},
            ]
        )
        result = resolve(definition, self._inputs())
        self.assertEqual(result.status, ResolverState.READY)
        self.assertEqual(result.node_values["ranked"], ["a", "b", "c", "d"])


class ResolverHoldTests(SimpleTestCase):
    def test_missing_round_score_hold(self):
        definition = _def(
            [
                {"key": "assess", "type": "ASSESS", "source": ENTRY_KEY, "round": "r1"},
                {"key": "ranked", "type": "RANK", "source": "assess"},
            ]
        )
        inputs = ResolveInput(
            roster=("a", "b"),
            round_scores=_scores("r1", {"a": 88}),
        )
        result = resolve(definition, inputs)
        self.assertEqual(result.status, ResolverState.HOLD)
        self.assertTrue(any("缺失 b 评分" in r for r in result.reasons))
        self.assertTrue(all(
            d.outcome_code == OutcomeCode.PENDING for d in result.decisions
        ))

    def test_trimmed_mean_insufficient_judges_hold(self):
        definition = _def(
            [
                {"key": "a", "type": "ASSESS", "source": ENTRY_KEY, "round": "r1",
                 "mode": "trimmed_mean", "trim_high": 1, "trim_low": 1},
            ],
        )
        inputs = ResolveInput(
            roster=("x",),
            round_scores=_scores("r1", {"x": 80}),  # only 1 judge → cannot trim 2
        )
        result = resolve(definition, inputs)
        self.assertEqual(result.status, ResolverState.HOLD)

    def test_partition_missing_group_hold(self):
        definition = _def(
            [
                {"key": "g", "type": "PARTITION", "source": ENTRY_KEY, "by": "class"},
            ]
        )
        result = resolve(definition, ResolveInput(roster=("a", "b")))
        self.assertEqual(result.status, ResolverState.HOLD)


class ResolverReviewTests(SimpleTestCase):
    def _boundary_definition(self, tie_policy=None):
        node = {"key": "ranked", "type": "RANK", "source": "assess", "descending": True}
        select = {"key": "winners", "type": "SELECT", "source": "ranked", "count": 1}
        if tie_policy:
            select["tie_policy"] = tie_policy
        return _def(
            [
                {"key": "assess", "type": "ASSESS", "source": ENTRY_KEY, "round": "r1"},
                node,
                select,
            ]
        )

    def _tie_inputs(self):
        return ResolveInput(
            roster=("a", "b"),
            round_scores=_scores("r1", {"a": 88, "b": 88}),
        )

    def test_boundary_tie_no_policy_review(self):
        result = resolve(self._boundary_definition(), self._tie_inputs())
        self.assertEqual(result.status, ResolverState.REVIEW)
        self.assertTrue(any("同分" in r for r in result.reasons))
        # boundary contestant marked PENDING
        by_c = {d.contestant: d for d in result.decisions}
        self.assertEqual(by_c["b"].outcome_code, OutcomeCode.PENDING)

    def test_boundary_tie_auto_break_ready(self):
        result = resolve(self._boundary_definition("auto_break"), self._tie_inputs())
        self.assertEqual(result.status, ResolverState.READY)
        by_c = {d.contestant: d for d in result.decisions}
        # roster order breaks the tie deterministically; a wins, b is ELIMINATED
        self.assertEqual(by_c["a"].outcome_code, OutcomeCode.DIRECT)
        self.assertEqual(by_c["b"].outcome_code, OutcomeCode.ELIMINATED)


class ResolverManualSelectTests(SimpleTestCase):
    def _def_manual(self):
        return _def(
            [
                {"key": "assess", "type": "ASSESS", "source": ENTRY_KEY, "round": "r1"},
                {"key": "ranked", "type": "RANK", "source": "assess"},
                {"key": "manual", "type": "MANUAL_SELECT",
                 "source": "ranked", "groups": 1, "quota": 5},
            ]
        )

    def test_manual_without_decision_hold(self):
        inputs = ResolveInput(
            roster=("a", "b"),
            round_scores=_scores("r1", {"a": 90, "b": 85}),
        )
        result = resolve(self._def_manual(), inputs)
        self.assertEqual(result.status, ResolverState.HOLD)
        messages = " ".join(result.reasons)
        self.assertIn("需要人工决定", messages)
        self.assertIn("允许 0~5", messages)
        self.assertIn("当前已选 0", messages)

    def test_manual_with_decision_ready(self):
        inputs = ResolveInput(
            roster=("a", "b"),
            round_scores=_scores("r1", {"a": 90, "b": 85}),
            manual={"manual": {"": ("a",)}},
        )
        result = resolve(self._def_manual(), inputs)
        self.assertEqual(result.status, ResolverState.READY)
        by_c = {d.contestant: d for d in result.decisions}
        self.assertEqual(by_c["a"].outcome_code, OutcomeCode.WILDCARD)
        self.assertEqual(by_c["b"].outcome_code, OutcomeCode.ELIMINATED)


class ResolverFillToQuotaTests(SimpleTestCase):
    def _manual_fill_def(self, quota):
        # manual picks only 'a' per group "" → partial; fill tops up from a remainder pool.
        return _def(
            [
                {"key": "assess", "type": "ASSESS", "source": ENTRY_KEY, "round": "r1"},
                {"key": "ranked", "type": "RANK", "source": "assess"},
                # 'from' shrinks the pool: advance 2 (a,b) then subtract them out → (c)
                {"key": "adv", "type": "SELECT", "source": "ranked", "count": 2},
                {"key": "from", "type": "SUBTRACT", "minuend": ENTRY_KEY, "subtrahend": "adv"},
                {"key": "manual", "type": "MANUAL_SELECT", "source": ENTRY_KEY, "groups": 1, "quota": 2},
                {"key": "filled", "type": "FILL_TO_QUOTA", "from": "from", "into": "manual", "quota": quota},
            ]
        )

    def _inputs(self, roster=("a", "b", "c")):
        return ResolveInput(
            roster=roster,
            round_scores=_scores("r1", {"a": 90, "b": 80, "c": 70}),
            manual={"manual": {"": ("a",)}},
        )

    def test_fill_insufficient_pool_hold(self):
        # manual into = {"":(a,)}; quota 3 → need 2; 'from' pool is only (c) → HOLD.
        result = resolve(self._manual_fill_def(3), self._inputs())
        self.assertEqual(result.status, ResolverState.HOLD)
        self.assertTrue(any("不足" in r for r in result.reasons))

    def test_fill_completes_ready(self):
        # manual into = {"":(a,)}; quota 2 → need 1; 'from' = ENTRY → top up with b → READY.
        definition = _def(
            [
                {"key": "manual", "type": "MANUAL_SELECT", "source": ENTRY_KEY, "groups": 1, "quota": 2},
                {"key": "filled", "type": "FILL_TO_QUOTA", "from": ENTRY_KEY, "into": "manual", "quota": 2},
            ]
        )
        result = resolve(definition, self._inputs())
        self.assertEqual(result.status, ResolverState.READY)
        by_c = {d.contestant: d for d in result.decisions}
        self.assertEqual(by_c["a"].outcome_code, OutcomeCode.WILDCARD)
        self.assertEqual(by_c["b"].outcome_code, OutcomeCode.FINALIST)
        self.assertEqual(by_c["c"].outcome_code, OutcomeCode.ELIMINATED)
```

Add the remaining tests:

```python
class ResolverFlowTests(SimpleTestCase):
    def _direct_repechage_def(self):
        return _def(
            [
                {"key": "assess", "type": "ASSESS", "source": ENTRY_KEY, "round": "r1"},
                {"key": "ranked", "type": "RANK", "source": "assess", "descending": True},
                {"key": "advanced", "type": "SELECT", "source": "ranked", "count": 2},
                {"key": "leftover", "type": "SUBTRACT", "minuend": ENTRY_KEY, "subtrahend": "advanced"},
                {"key": "repech_scored", "type": "ASSESS", "source": "leftover", "round": "r1"},
                {"key": "repech_ranked", "type": "RANK", "source": "repech_scored"},
                {"key": "repech_winners", "type": "SELECT", "source": "repech_ranked", "count": 1},
            ]
        )

    def test_direct_then_repechage_flow(self):
        inputs = ResolveInput(
            roster=("s1", "s2", "s3", "s4"),
            round_scores=_scores("r1", {"s1": 90, "s2": 80, "s3": 70, "s4": 60}),
        )
        result = resolve(self._direct_repechage_def(), inputs)
        self.assertEqual(result.status, ResolverState.READY)
        by_c = {d.contestant: d for d in result.decisions}
        self.assertEqual(by_c["s1"].outcome_code, OutcomeCode.DIRECT)
        self.assertEqual(by_c["s2"].outcome_code, OutcomeCode.DIRECT)
        self.assertEqual(by_c["s3"].outcome_code, OutcomeCode.REPECHAGE)
        self.assertEqual(by_c["s4"].outcome_code, OutcomeCode.ELIMINATED)

    def test_acceptance_structure_resolves_readily(self):
        # §8.8 acceptance fixture: resolves with a submitted manual decision, READY.
        definition = partition_subtract_repechage_merge()
        inputs = ResolveInput(
            roster=("s1", "s2", "s3", "s4", "s5", "s6", "s7", "s8", "s9", "s10"),
            round_scores=_scores(
                "r1", {c: value for c, value in [
                    ("s1", 95), ("s2", 94), ("s3", 93), ("s4", 92), ("s5", 91),
                    ("s6", 90), ("s7", 89), ("s8", 88), ("s9", 87), ("s10", 86),
                ]}
            ),
            group_of={"class": {"s1": "A", "s2": "A", "s3": "A", "s4": "B", "s5": "B",
                                "s6": "B", "s7": "C", "s8": "C", "s9": "C", "s10": "C"}},
            manual={"manual": {"": ("s1",)}},
        )
        result = resolve(definition, inputs)
        self.assertEqual(result.status, ResolverState.READY)


class ResolverDeterminismTests(SimpleTestCase):
    def _inputs(self):
        return ResolveInput(
            roster=("a", "b", "c"),
            round_scores=_scores("r1", {"a": 90, "b": 88, "c": 70}),
        )

    def _def(self):
        return _def(
            [
                {"key": "a", "type": "ASSESS", "source": ENTRY_KEY, "round": "r1"},
                {"key": "r", "type": "RANK", "source": "a"},
                {"key": "s", "type": "SELECT", "source": "r", "count": 2},
            ]
        )

    def test_idempotent_identical_to_dict(self):
        first = resolve(self._def(), self._inputs())
        second = resolve(self._def(), self._inputs())
        self.assertEqual(first.to_dict(), second.to_dict())
        self.assertEqual(
            ResolveResult.from_dict(first.to_dict()).to_dict(), first.to_dict()
        )

    def test_no_raw_mutation(self):
        inputs = self._inputs()
        resolve(self._def(), inputs)
        # frozen dataclasses + we never write to the backing dicts
        self.assertEqual(
            inputs.round_scores["r1"]["b"], (Decimal("88"),)
        )

    def test_binding_plan_metadata(self):
        _, plan = compiler.compile_definition(self._def())
        result = resolve(self._def(), self._inputs(), plan)
        self.assertEqual(result.content_hash, plan.content_hash)
        self.assertEqual(result.schema_version, plan.schema_version)
        self.assertEqual(result.plan_version, 1)
        self.assertEqual(result.result_version, 1)


class ResolverUnsupportedTests(SimpleTestCase):
    def test_branch_raises_unsupported(self):
        definition = _def(
            [{"key": "b", "type": "BRANCH", "source": ENTRY_KEY, "branches": [{"when": "x", "into": "y"}]}]
        )
        with self.assertRaises(UnsupportedNodeError):
            resolve(definition, ResolveInput(roster=("a",)))


class ResolverPerfTests(SimpleTestCase):
    def test_100_contestants_10_judges_under_bound(self):
        roster = tuple(f"s{i}" for i in range(1, 101))
        rounds = {}
        for rnd in ("r1", "r2", "r3"):
            rounds[rnd] = {
                c: tuple(Decimal(60 + ((i * 3 + rnd_index) % 40)) for i in range(10))
                for rnd_index, c in enumerate(roster)
            }
        definition = _def(
            [
                {"key": "a1", "type": "ASSESS", "source": ENTRY_KEY, "round": "r1"},
                {"key": "a2", "type": "ASSESS", "source": ENTRY_KEY, "round": "r2"},
                {"key": "c1", "type": "AGGREGATE",
                 "aggregate": {"type": "weighted_sum",
                               "components": [{"source": "a1", "weight": 0.4},
                                              {"source": "a2", "weight": 0.6}]}},
                {"key": "r1r", "type": "RANK", "source": "c1"},
                {"key": "s1", "type": "SELECT", "source": "r1r", "count": 50},
            ]
        )
        inputs = ResolveInput(roster=roster, round_scores=rounds)
        start = time.perf_counter()
        result = resolve(definition, inputs)
        elapsed_ms = (time.perf_counter() - start) * 1000
        self.assertEqual(result.status, ResolverState.READY)
        self.assertLess(elapsed_ms, 2000, f"resolve took {elapsed_ms:.1f} ms")
```

The `_scores` helper wraps value into `(Decimal(str(v)),)` — note for float inputs it converts via str. Ensure `_scores` is used consistently.

- [ ] **Step 2: Run the tests**

Run: `uv run python manage.py test ruleset.test_resolver -v 2`
Expected: mixed pass/fail — iterate in Tasks 8/9 to get all green (this is the TDD loop; run early, then fix the resolver).

- [ ] **Step 3: Commit the test file (once it passes)**

```bash
git add ruleset/test_resolver.py
git commit -m "test(M1-E): resolver suite"
```

---

### Task 8: Resolve failures until green

**Files:**
- Modify: `ruleset/resolver.py` (as needed), `ruleset/test_resolver.py`

- [ ] **Step 1: Run the resolver tests, fix failures**

Run: `uv run python manage.py test ruleset.test_resolver -v 2`
Expected: all pass. Fix any logic bugs in the executors (tie detection, origin tags, FillToQuota unmet check, manual group keying) until green.

- [ ] **Step 2: Run the whole ruleset suite (M1-C + M1-D + M1-E)**

Run: `uv run python manage.py test ruleset -v 1`
Expected: green (M1-C 70 + M1-D 33 + M1-E new).

- [ ] **Step 3: Commit fix-ups if any**

```bash
git add ruleset/resolver.py ruleset/test_resolver.py
git commit -m "fix(M1-E): resolver correctness"
```

---

### Task 9: Lint, format, full suite, no-drift

**Files:**
- None (verification)

- [ ] **Step 1: Ruff**

Run: `uv run ruff check ruleset` → clean
Run: `uv run ruff format --check ruleset` → if modified, `uv run ruff format ruleset && uv run ruff check ruleset`

- [ ] **Step 2: Django check + no migration drift**

Run: `uv run python manage.py check` → no issues
Run: `uv run python manage.py makemigrations --check --dry-run` → "No changes detected"

- [ ] **Step 3: Full suite**

Run: `uv run python manage.py test`
Expected: green across all apps (SQLite), one or more of the ruleset M1-E tests included.

- [ ] **Step 4: Commit any formatting normalization**

```bash
git add -A
git commit -m "chore(M1-E): ruff format"
```

---

### Task 10: §21 M1-E report + merge + push

**Files:**
- Produce the M1-E §21 report (follow the format from the M1-D stage).

- [ ] **Step 1: Write the §21 M1-E report and commit**

Append the section to the existing report file (find it — e.g. `docs/` or the report artifact used in M1-D). If no report doc exists yet, create `docs/m1-e-report.md` capturing: what shipped, checks satisfied (§10.1–§10.10), test counts, PostgreSQL result if run.

- [ ] **Step 2: Merge to main (non-ff) and push**

```bash
git checkout main
git merge --no-ff --no-edit m1-e-stage-resolver
git push --no-verify
GIT_SSH_COMMAND="ssh -o ProxyCommand=none" git push origin main
```

(Author is already `Zn070515` from the per-commit `--author`; no `Co-Authored-By`.)

- [ ] **Step 3: Clean up the feature branch**

```bash
git branch -d m1-e-stage-resolver
```

---

## Self-Review notes

- **Spec coverage:** §10.1 automatic resolver ✓; §10.2 raw-only inputs ✓ (`ResolveInput` reads scores/votes/manual); §10.3 outputs `StageDecision`/`CompositeResult`/`ResolverState` ✓; §10.4 outcome taxonomy ✓; §10.5 HOLD/REVIEW/READY ✓; §10.6 idempotency ✓ (test); §10.7 no raw mutation ✓ (frozen + test); §10.8 FillToQuota primitive + HOLD-on-insufficient ✓; §10.9 ManualSelect message + resume ✓; §10.10 perf benchmark ✓ (soft bound).
- **Node coverage:** ENTRY/PARTITION/PAIR/ASSESS/AGGREGATE/RANK/SELECT/SUBTRACT/MERGE/FILL_TO_QUOTA/MANUAL_SELECT executed; BRANCH/AWARD → `UnsupportedNodeError` (deferred). ✔ matches confirmed scope.
- **Deferred:** DB binding, cross-stage composite ($15), golden simulation — M1-F.
