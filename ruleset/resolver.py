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
    picked = list(ranked[:count])
    score_node = by_key[node["source"]].get("source")
    scores: dict = st.values.get(score_node, {}) if score_node else {}
    policy = node.get("tie_policy")
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
            if nxt not in st.outcome:
                st.outcome[nxt] = OutcomeCode.FINALIST
                st.source_node[nxt] = node["key"]
            need -= 1
    unmet = {g: quota - len(result[g]) for g in into if quota - len(result[g]) > 0}
    if unmet:
        st.hold.append(f"FILL_TO_QUOTA {node['key']} 来源池不足，未能补满 {unmet}（不静默少补）。")
    return {g: tuple(cs) for g, cs in result.items()}


def _manual(node: dict, st: _Stage, inputs: ResolveInput) -> dict:
    src = st.values[node["source"]]
    is_group = isinstance(src, dict)
    pool_set = {c for cs in src.values() for c in cs} if is_group else set(src)
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


def _final_status(st: _Stage) -> ResolverState:
    if st.hold:
        return ResolverState.HOLD
    if st.review:
        return ResolverState.REVIEW
    return ResolverState.READY


def _build_decisions(
    st: _Stage,
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
                content_hash=content_hash,
                schema_version=schema_version,
                plan_version=plan_version,
                result_version=RESULT_VERSION,
            )
        )
    return tuple(out)


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
    decisions = _build_decisions(st, st.roster, plan_hash, schema_version, plan_version)
    return ResolveResult(
        status=_final_status(st),
        reasons=tuple(st.hold + st.review),
        decisions=decisions,
        composites=tuple(st.composites),
        node_values=node_values,
        content_hash=plan_hash,
        schema_version=schema_version,
        plan_version=plan_version,
        result_version=RESULT_VERSION,
    )
