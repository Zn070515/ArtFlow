"""M1-E deterministic StageResolver: replay a frozen ruleset over raw facts.

Pure, DB-free. Executes the linear subset of plan node types
(ENTRY, PARTITION, PAIR, ASSESS, AGGREGATE, RANK, SELECT, SUBTRACT, MERGE,
FILL_TO_QUOTA, MANUAL_SELECT) deterministically over raw facts, producing
per-contestant StageDecisions with a HOLD/REVIEW/READY resolver state.

Determinism contract (:func:`resolve`) is a pure function of
``(definition, inputs)``. It never touches the DB, the clock, random, or an
unordered queryset. The entry roster tuple is the canonical total order for
every tie-break, partition iteration, merge dedupe, and FillToQuota fill order.

BRANCH and AWARD are not executed this stage (raise :class:`UnsupportedNodeError`).
"""

from __future__ import annotations

import hashlib
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
    # (source, weight, value, contribution) tuples
    components: tuple[tuple[str, Decimal, Decimal, Decimal], ...]

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
    input_fingerprint: str = ""
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
            "input_fingerprint": self.input_fingerprint,
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
            input_fingerprint=data.get("input_fingerprint", ""),
            schema_version=data.get("schema_version", 0),
            plan_version=data.get("plan_version", 0),
            result_version=data.get("result_version", RESULT_VERSION),
        )


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


def inputs_fingerprint(inputs: ResolveInput) -> str:
    """sha256 of the canonical raw-facts snapshot a :class:`ResolveInput` captures.

    Combined with the immutable ``RulesetVersion``, the identity of a result is
    ``(ruleset_version, input_fingerprint)``: recomputing the same ruleset over the same
    raw facts is idempotent (reuse), while any change to the roster, round scores, vote
    scores, group map, or manual decisions yields a new fingerprint and therefore a new
    versioned :class:`ResolveResult`.
    """
    payload = _value_to_jsonable(
        {
            "roster": list(inputs.roster),
            "round_scores": dict(inputs.round_scores),
            "vote_scores": dict(inputs.vote_scores),
            "group_of": dict(inputs.group_of),
            "manual": dict(inputs.manual),
        }
    )
    canonical = json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


def _dep_refs(node: dict) -> list[str]:
    """All node-key references a node consumes (the edges of the forward-only graph)."""
    refs = []
    if node.get("source"):
        refs.append(node["source"])
    if node.get("within"):
        refs.append(node["within"])
    if node.get("by"):
        refs.append(node["by"])
    if node.get("minuend"):
        refs.append(node["minuend"])
    if node.get("subtrahend"):
        refs.append(node["subtrahend"])
    if node.get("from"):
        refs.append(node["from"])
    if node.get("into"):
        refs.append(node["into"])
    if node.get("ranking_source"):
        refs.append(node["ranking_source"])
    refs.extend(node.get("sources") or [])
    agg = node.get("aggregate")
    if isinstance(agg, dict):
        for comp in agg.get("components") or []:
            if comp.get("source"):
                refs.append(comp["source"])
    return [r for r in refs if r]


def _dependency_closure(output_key: str, by_key: dict[str, dict]) -> set[str]:
    """The transitive set of nodes ``output_key`` depends on (excluding the seed).

    The forward-only graph makes the closure a well-ordered subset of the definition:
    executing ``nodes`` filtered to this closure (in definition order) computes exactly
    the subgraph that produces ``output_key`` and nothing more.
    """
    closure: set[str] = set()
    stack = [output_key]
    while stack:
        key = stack.pop()
        if key == ENTRY_KEY or key in closure:
            continue
        closure.add(key)
        node = by_key.get(key)
        if node:
            stack.extend(_dep_refs(node))
    return closure


def _consumed_scopes(nodes: list[dict], closure: set[str]) -> tuple[set, set, set, set]:
    """The raw-fact binding keys the closure actually reads (rounds, votes, groups, manual)."""
    round_keys: set[str] = set()
    vote_keys: set[str] = set()
    group_keys: set[str] = set()
    manual_keys: set[str] = set()
    for node in nodes:
        if node["key"] not in closure:
            continue
        if node.get("round"):
            round_keys.add(node["round"])
        if node.get("vote_source"):
            vote_keys.add(node["vote_source"])
        if node.get("by"):
            group_keys.add(node["by"])
        if node["type"] == "MANUAL_SELECT":
            manual_keys.add(node["key"])
    return round_keys, vote_keys, group_keys, manual_keys


def _scoped_inputs_fingerprint(
    inputs: ResolveInput,
    round_keys: set[str],
    vote_keys: set[str],
    group_keys: set[str],
    manual_keys: set[str],
) -> str:
    """sha256 over the raw facts a checkpoint closure consumes.

    Scoping matters for progressive publication idempotency: a Stage1 checkpoint's input
    identity must NOT change when a future stage's rounds (r3/r4) later arrive. Projecting
    the inputs onto only the closure's binding keys keeps the fingerprint — and therefore
    the StageResult identity — stable while facts the resolver did not read accumulate.
    """
    payload = _value_to_jsonable(
        {
            "roster": list(inputs.roster),
            "round_scores": {k: v for k, v in inputs.round_scores.items() if k in round_keys},
            "vote_scores": {k: v for k, v in inputs.vote_scores.items() if k in vote_keys},
            "group_of": {k: v for k, v in inputs.group_of.items() if k in group_keys},
            "manual": {k: v for k, v in inputs.manual.items() if k in manual_keys},
        }
    )
    canonical = json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


def stage_consumed_scopes(
    definition, checkpoint: str | None
) -> tuple[set[str], set[str], set[str], set[str]]:
    """The raw-fact binding keys a stage consumes (rounds, votes, groups, manual).

    With a ``checkpoint`` the closure is the checkpoint's dependency subgraph; without
    one (a full resolve) the whole definition is consumed. Used by the services layer to
    scope staleness re-checks and dependency-finality checks to exactly what the stage
    actually read — future-stage facts never block an earlier stage.
    """
    parsed = parse_definition(definition)
    nodes = parsed["nodes"]
    by_key = {n["key"]: n for n in nodes}
    if checkpoint:
        checkpoints = parsed.get("checkpoints") or ()
        cp = next((c for c in checkpoints if c["key"] == checkpoint), None)
        if cp is None:
            raise ValueError(f"定义未声明检查点 {checkpoint}。")
        closure = _dependency_closure(cp["output"], by_key)
    else:
        closure = {n["key"] for n in nodes}
    return _consumed_scopes(nodes, closure)


def checkpoint_inputs_fingerprint(definition, inputs: ResolveInput, checkpoint: str) -> str:
    """Recompute the scoped input fingerprint a named checkpoint would consume.

    Mirrors :func:`resolve_to_checkpoint`'s input-projection so the caller can compare a
    stored result's ``input_fingerprint`` against the *current* raw facts without being
    forced to re-execute the whole closure. Returns the same value the stage persisted.
    """
    parsed = parse_definition(definition)
    nodes = parsed["nodes"]
    checkpoints = parsed.get("checkpoints") or ()
    by_key = {n["key"]: n for n in nodes}
    cp = next((c for c in checkpoints if c["key"] == checkpoint), None)
    if cp is None:
        raise ValueError(f"定义未声明检查点 {checkpoint}。")
    closure = _dependency_closure(cp["output"], by_key)
    round_keys, vote_keys, group_keys, manual_keys = _consumed_scopes(nodes, closure)
    return _scoped_inputs_fingerprint(inputs, round_keys, vote_keys, group_keys, manual_keys)


class _Stage:
    """Mutable driver state; frozen into a :class:`ResolveResult` at the end."""

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


def _part(node: dict, st: _Stage, inputs: ResolveInput) -> dict:
    pool: tuple = st.values[node["source"]]
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
                ordered = sorted(dec)
                body = ordered[
                    int(node.get("trim_low") or 0) : len(ordered) - int(node.get("trim_high") or 0)
                ]
                out[c] = sum(body, Decimal("0")) / Decimal(len(body))
            else:
                out[c] = sum(dec, Decimal("0")) / Decimal(len(dec))
    return out


def _union_pool(maps, idx) -> tuple:
    seen: dict[str, int] = {}
    for m in maps:
        for c in m:
            seen.setdefault(c, idx.get(c, 10**9))
    return tuple(sorted(seen, key=lambda c: (seen[c], c)))


def _aggregate(node: dict, st: _Stage, inputs: ResolveInput) -> tuple[dict, tuple]:
    comps = node["aggregate"]["components"]
    agg_type = node["aggregate"]["type"]
    maps = [st.values[c["source"]] for c in comps]
    within = node.get("within")
    if within:
        pool = tuple(st.values[within])
    else:
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
                st.hold.append(f"AGGREGATE {node['key']} 缺失分量 {comp['source']} 对 {c} 的分数。")
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


def _rank(node: dict, st: _Stage, by_key: dict) -> tuple:
    m: dict = st.values[node["source"]]
    desc = node.get("descending", True)
    if desc:
        ordered = tuple(sorted(m.keys(), key=lambda c: (-m[c], st.idx[c])))
    else:
        ordered = tuple(sorted(m.keys(), key=lambda c: (m[c], st.idx[c])))
    st.rank_pos[node["key"]] = {c: i + 1 for i, c in enumerate(ordered)}
    return ordered


def _select(node: dict, st: _Stage, by_key: dict) -> tuple:
    ranked: tuple = st.values[node["source"]]
    count = node["count"]
    score_node = by_key[node["source"]].get("source")
    scores: dict = st.values.get(score_node, {}) if score_node else {}
    policy = node.get("tie_policy")
    by = node.get("by")
    if by:
        # Group-scoped: pick top-count within each group of the partition, flattened
        # in partition order. Roster-first semantics (a contestant belongs to exactly
        # one group) make the per-group picks disjoint.
        picked: list[str] = []
        for g, members in st.values[by].items():
            members_set = set(members)
            ordered = [c for c in ranked if c in members_set]
            lead = ordered[:count]
            picked.extend(lead)
            for c in lead:
                if c not in st.outcome:
                    st.outcome[c] = (
                        OutcomeCode.REPECHAGE
                        if "repechage" in st.origin.get(c, set())
                        else OutcomeCode.DIRECT
                    )
                    st.source_node[c] = node["key"]
            if count > 0 and count < len(ordered):
                boundary = scores.get(ordered[count - 1])
                following = scores.get(ordered[count])
                if (
                    boundary is not None
                    and following is not None
                    and boundary == following
                    and policy != "auto_break"
                ):
                    st.review.append(
                        f"SELECT {node['key']} 组 {g} 在截止名次 {count} 处同分，"
                        f"需人工核定 (tie_policy={policy or 'review'})。"
                    )
        return tuple(picked)
    picked = list(ranked[:count])
    for c in picked:
        if c not in st.outcome:
            if "repechage" in st.origin.get(c, set()):
                st.outcome[c] = OutcomeCode.REPECHAGE
            else:
                st.outcome[c] = OutcomeCode.DIRECT
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
                for c in ranked[count - 1 :]:
                    if scores.get(c) == boundary and c not in st.outcome:
                        st.outcome[c] = OutcomeCode.PENDING
                        st.source_node[c] = node["key"]
    return tuple(picked)


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


def _by_ranking(remaining: list[str], node: dict, st: _Stage) -> list[str]:
    """Order ``remaining`` by a prior ranking node; unknowns tail the pool order.

    ``ranking_source`` is an ordered roster (a RANK/SELECT/ROSTER output). Its order is
    the only meaningful "按分数补足" axis; absent one we fall back to the candidate pool
    order (a deterministic, documented default, not a score ranking).
    """
    ranking = node.get("ranking_source")
    if not ranking:
        return remaining
    ordered = _order(st.values[ranking])
    pos = {c: i for i, c in enumerate(ordered)}
    return sorted(remaining, key=lambda c: (pos.get(c, len(ordered)), st.idx[c]))


def _fill(node: dict, st: _Stage, inputs: ResolveInput) -> dict:
    into: dict = st.values[node["into"]]
    pool: tuple = st.values[node["from"]]
    quota = node["quota"]
    mode = node.get("mode", "global")
    exclude = node.get("exclude_selected", True)
    result: dict[str, list[str]] = {g: list(cs) for g, cs in into.items()}
    selected = {c for cs in result.values() for c in cs}

    def adopt(c: str) -> None:
        if c not in st.outcome:
            st.outcome[c] = OutcomeCode.FINALIST
            st.source_node[c] = node["key"]

    if mode == "each_group":
        # Every target group is topped up individually to `quota` (FILL_EACH_GROUP_TO_QUOTA).
        pool_iter = list(pool)
        unmet: dict[str, int] = {}
        for g, cs in into.items():
            need = quota - len(result[g])
            while need > 0 and pool_iter:
                nxt = pool_iter.pop(0)
                if exclude and nxt in selected:
                    continue
                result[g].append(nxt)
                selected.add(nxt)
                adopt(nxt)
                need -= 1
            if quota - len(result[g]) > 0:
                unmet[g] = quota - len(result[g])
        if unmet:
            st.hold.append(
                f"FILL_TO_QUOTA {node['key']} 来源池不足，未能补满 {unmet}（不静默少补）。"
            )
        return {g: tuple(cs) for g, cs in result.items()}

    # global (§22): fill until the TOTAL across the target map reaches `quota`.
    current = len(selected)
    need = quota - current
    if need <= 0:
        return {g: tuple(cs) for g, cs in result.items()}
    remaining = [c for c in pool if not exclude or c not in selected]
    ranked = _by_ranking(remaining, node, st)
    take = ranked[:need]
    if len(take) < need:
        st.hold.append(
            f"FILL_TO_QUOTA {node['key']} 来源池不足：需要补足 {need} 人，"
            f"仅剩 {len(take)} 名候选（不静默少补）。"
        )
    groups = list(into.keys())
    for i, c in enumerate(take):
        g = groups[i % len(groups)] if groups else ""
        result.setdefault(g, []).append(c)
        selected.add(c)
        adopt(c)
    return {g: tuple(cs) for g, cs in result.items()}


def _manual(node: dict, st: _Stage, inputs: ResolveInput) -> dict:
    src = st.values[node["source"]]
    is_group = isinstance(src, dict)
    quota = node["quota"]
    decisions = inputs.manual.get(node["key"])
    if not decisions:
        st.hold.append(
            f"MANUAL_SELECT {node['key']} 需要人工决定：来源 {node['source']}，"
            f"允许 0~{quota}，当前已选 0。"
        )
        return {}
    valid = True

    def mark_wildcard(c: str) -> None:
        if c not in st.outcome:
            st.outcome[c] = OutcomeCode.WILDCARD
            st.source_node[c] = node["key"]

    if is_group:
        seen: dict[str, str] = {}
        for dk in decisions:
            if dk not in src:
                st.hold.append(f"MANUAL_SELECT {node['key']} 指定了不存在的组 {dk}。")
                valid = False
        for g, cs in src.items():
            chosen = decisions.get(g, ())
            if len(chosen) > quota:
                st.hold.append(
                    f"MANUAL_SELECT {node['key']} {g} 选入 {len(chosen)} 人，超过上限 {quota}。"
                )
                valid = False
            for c in chosen:
                if c not in cs:
                    st.hold.append(
                        f"MANUAL_SELECT {node['key']} 把 {c} 选入 {g}，但 {c} 不属于该组。"
                    )
                    valid = False
                if c in seen and seen[c] != g:
                    st.hold.append(f"MANUAL_SELECT {node['key']} {c} 同时选入 {seen[c]} 和 {g}。")
                    valid = False
                else:
                    seen[c] = g
        if not valid:
            return {}
        result: dict[str, tuple[str, ...]] = {}
        for g, cs in src.items():
            chosen = tuple(_order(c for c in decisions.get(g, ()) if c in cs))
            for c in chosen:
                mark_wildcard(c)
            result[g] = chosen
        return result

    pool_set = set(src)
    for dk in decisions:
        if dk != "":
            st.hold.append(f"MANUAL_SELECT {node['key']} 非分组来源仅允许空组，收到 {dk!r}。")
            valid = False
    raw = decisions.get("", ())
    if len(raw) > quota:
        st.hold.append(f"MANUAL_SELECT {node['key']} 选入 {len(raw)} 人，超过上限 {quota}。")
        valid = False
    for c in raw:
        if c not in pool_set:
            st.hold.append(f"MANUAL_SELECT {node['key']} {c} 不在来源 {node['source']} 中。")
            valid = False
    if not valid:
        return {}
    chosen = tuple(_order(c for c in raw if c in pool_set))
    for c in chosen:
        mark_wildcard(c)
    return {"": chosen}


def _final_status(st: _Stage) -> ResolverState:
    if st.hold:
        return ResolverState.HOLD
    if st.review:
        return ResolverState.REVIEW
    return ResolverState.READY


def _run_node(node: dict, st: _Stage, inputs: ResolveInput, by_key: dict[str, dict]) -> None:
    """Execute one node in place. The forward-only graph guarantees its refs are staged."""
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


def _member_set(value) -> set[str]:
    """Flatten a node value (list or group map) into the set of contestants it holds."""
    if not value:
        return set()
    if isinstance(value, dict):
        members: set[str] = set()
        for cs in value.values():
            members.update(cs)
        return members
    return set(value)


def _build_decisions(
    st: _Stage,
    roster: tuple[str, ...],
    content_hash: str,
    schema_version: int,
    plan_version: int,
    *,
    output_node: str | None = None,
    decisions_spec: tuple[dict, ...] = (),
) -> tuple:
    # A checkpoint declares its official per-stage decision mapping (§6/P0-4). A SELECT
    # node must NOT carry a prior stage's label forward (the Stage2-Top5-shows-Top10 bug:
    # once a contestant is DIRECT in a replayed stage1 Top10, the narrower Top5 cannot
    # demote them). Here the checkpoint's own output/decisions decide, not st.outcome.
    if decisions_spec or output_node is not None:
        spec_outcome = {d["source"]: OutcomeCode(d["outcome"]) for d in decisions_spec}

        def label(c: str) -> tuple[OutcomeCode, str]:
            if decisions_spec:
                for d in decisions_spec:
                    if c in _member_set(st.values.get(d["source"])):
                        return spec_outcome[d["source"]], d["source"]
                return OutcomeCode.ELIMINATED, ""
            if c in _member_set(st.values.get(output_node)):
                return OutcomeCode.DIRECT, output_node
            return OutcomeCode.ELIMINATED, ""

    out = []
    for c in roster:
        if decisions_spec or output_node is not None:
            code, source_node = label(c)
        else:
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
                content_hash=content_hash,
                schema_version=schema_version,
                plan_version=plan_version,
                result_version=RESULT_VERSION,
            )
        )
    return tuple(out)


def _assemble_result(
    st: _Stage, obj, parsed: dict, plan, fingerprint: str, *, cp: dict | None = None
) -> ResolveResult:
    """Freeze stage state into a :class:`ResolveResult` with binding metadata.

    When ``cp`` (a checkpoint dict) is supplied, the per-stage official decisions come
    from its declared ``output``/``decisions`` mapping, not from SELECT side-effects.
    """
    if plan is not None:
        plan_hash = plan.content_hash
        schema_version = plan.schema_version
        plan_version = plan.plan_version
    else:
        plan_hash = content_hash(obj)
        schema_version = parsed["schema_version"]
        plan_version = 0
    node_values = {
        k: _value_to_jsonable(v) for k, v in sorted(st.values.items(), key=lambda kv: kv[0])
    }
    decisions = _build_decisions(
        st,
        st.roster,
        plan_hash,
        schema_version,
        plan_version,
        output_node=cp["output"] if cp is not None else None,
        decisions_spec=cp.get("decisions") or () if cp is not None else (),
    )
    return ResolveResult(
        status=_final_status(st),
        reasons=tuple(st.hold + st.review),
        decisions=decisions,
        composites=tuple(st.composites),
        node_values=node_values,
        content_hash=plan_hash,
        input_fingerprint=fingerprint,
        schema_version=schema_version,
        plan_version=plan_version,
        result_version=RESULT_VERSION,
    )


def resolve(definition, inputs: ResolveInput, plan=None) -> ResolveResult:
    """Deterministically replay ``definition`` over ``inputs``.

    ``plan`` (an :class:`~ruleset.compiler.ExecutionPlan`) supplies only read-only
    binding metadata; it never affects computed values.
    """
    parsed = parse_definition(definition)
    nodes = parsed["nodes"]
    by_key = {n["key"]: n for n in nodes}
    obj = definition if isinstance(definition, dict) else json.loads(definition)
    st = _Stage(inputs.roster)

    for node in nodes:
        _run_node(node, st, inputs, by_key)

    return _assemble_result(st, obj, parsed, plan, inputs_fingerprint(inputs))


def resolve_to_checkpoint(
    definition, inputs: ResolveInput, checkpoint: str, plan=None
) -> ResolveResult:
    """Replay only the dependency closure of a named checkpoint.

    ``checkpoint`` is a ``{key, output}`` entry declared in the definition's optional
    ``checkpoints`` list. Only the nodes that transitively produce ``output`` are
    executed, so future-stage inputs (rounds/votes consumed by later checkpoints) that
    are still missing never force a HOLD — a completed stage publishes READY on its own.
    The result's ``input_fingerprint`` is scoped to the facts the closure consumed, so
    StageResult identity is stable as later rounds arrive. Raises :class:`ValueError` if
    the definition declares no such checkpoint.
    """
    parsed = parse_definition(definition)
    nodes = parsed["nodes"]
    checkpoints = parsed.get("checkpoints") or ()
    by_key = {n["key"]: n for n in nodes}
    obj = definition if isinstance(definition, dict) else json.loads(definition)

    cp = next((c for c in checkpoints if c["key"] == checkpoint), None)
    if cp is None:
        raise ValueError(f"定义未声明检查点 {checkpoint}。")
    closure = _dependency_closure(cp["output"], by_key)

    st = _Stage(inputs.roster)
    for node in nodes:
        if node["key"] in closure:
            _run_node(node, st, inputs, by_key)

    round_keys, vote_keys, group_keys, manual_keys = _consumed_scopes(nodes, closure)
    fingerprint = _scoped_inputs_fingerprint(inputs, round_keys, vote_keys, group_keys, manual_keys)
    return _assemble_result(st, obj, parsed, plan, fingerprint, cp=cp)
