"""Pure form <-> definition serialization for the M1-I ruleset editor.

This module is deliberately DB-free. It converts the editor's self-submitting POST
payload into a typed ``definition`` dict (reusing :data:`~ruleset.schema.NODE_TYPE_SPEC`),
and builds a synthetic :class:`~ruleset.resolver.ResolveInput` so a DRAFT ruleset can be
Preview'd before it is ever wired to real rounds.
"""

from __future__ import annotations

import json
from decimal import Decimal

from ruleset.resolver import ResolveInput
from ruleset.schema import ENTRY_KEY, NODE_TYPE_SPEC, parse_definition

_FIELD_LABELS = {
    "key": "节点键",
    "type": "类型",
    "source": "来源",
    "round": "轮次键",
    "scale": "分数制",
    "mode": "计分方式",
    "trim_high": "去最高",
    "trim_low": "去最低",
    "min_judges": "最低评委数",
    "descending": "降序",
    "tie_policy": "平局处理",
    "by": "按分组",
    "count": "数量",
    "quota": "名额",
    "groups": "组数",
    "odd_policy": "奇数处理",
    "vote_source": "投票来源",
    "vote_purpose": "投票用途",
    "award": "奖项",
    "minuend": "被减数",
    "subtrahend": "减数",
    "sources": "来源列表",
    "branches": "分支",
    "conversion": "换算",
    "aggregate": "加权合成",
    "within": "限定范围",
}

_FIELD_ALLOWED = {
    "scale": ["hundred", "ten", "raw", "ordinal", "votes"],
    "mode": ["mean", "trimmed_mean"],
    "tie_policy": ["auto_break", "extra_round", "manual", "score_fallback"],
    "odd_policy": ["bye", "wildcard", "manual", "reject"],
    "vote_purpose": ["POPULARITY", "SCORE_COMPONENT", "SELECTION", "OTHER"],
}

# Numeric node fields coerced to int when present (schema enforces non-negative int).
_INT_FIELDS = frozenset({"trim_high", "trim_low", "min_judges", "count", "quota", "groups"})
_BOOL_FIELDS = frozenset({"descending"})
# Structured sub-objects edited as a raw JSON string in the form.
_JSON_FIELDS = frozenset({"branches", "conversion"})


def available_sources(nodes, index):
    """Return the source keys a node at ``index`` may legally reference.

    Forward-only order: ``entry`` first, then every prior node key in order.
    """
    prior = [n["key"] for n in nodes[:index]]
    return [ENTRY_KEY] + prior


def field_labels():
    return dict(_FIELD_LABELS)


def field_allowed():
    return {k: list(v) for k, v in _FIELD_ALLOWED.items()}


def _bool(payload) -> bool:
    return payload in ("1", "true", "True", "on")


def _parse_aggregate(form, token) -> dict:
    components = []
    i = 0
    while True:
        src = form.get(f"{token}_aggregate_component_{i}_source", "").strip()
        if not src:
            break
        weight = form.get(f"{token}_aggregate_component_{i}_weight", "").strip()
        components.append({"source": src, "weight": float(weight)})
        i += 1
    agg_type = form.get(f"{token}_aggregate_type", "weighted_sum").strip() or "weighted_sum"
    return {"type": agg_type, "components": components}


def _coerce(field, raw):
    if field in _INT_FIELDS:
        return int(raw)
    if field == "sources":
        return [token.strip() for token in raw.split(",") if token.strip()]
    return raw


def definition_from_form(form) -> dict:
    """Rebuild a typed ``definition`` dict from the editor's POST payload.

    ``node_order`` is a comma-listed set of ``node_<index>`` form prefixes; each
    prefix carries ``<token>_<field>`` name/value pairs. Raises on a forward
    reference or any schema violation (via :func:`~ruleset.schema.parse_definition`),
    so the view can surface the error and never persist a bad graph.
    """
    order = [t for t in (form.get("node_order") or "").split(",") if t]
    nodes = []
    for token in order:
        node = {"key": form.get(f"{token}_key", "").strip()}
        node_type = form.get(f"{token}_type", "").strip()
        spec = NODE_TYPE_SPEC.get(node_type)
        if spec is None:
            raise ValueError(f"unknown node type {node_type!r}")
        node["type"] = node_type
        for field in list(spec.required) + list(spec.optional):
            if field == "aggregate":
                node["aggregate"] = _parse_aggregate(form, token)
                continue
            if field == "within":
                raw = form.get(f"{token}_within", "").strip()
                if raw:
                    node["within"] = raw
                continue
            if field in _BOOL_FIELDS:
                if _bool(form.get(f"{token}_{field}", "")):
                    node[field] = True
                continue
            if field in _JSON_FIELDS:
                raw = form.get(f"{token}_{field}_json", "").strip()
                if raw:
                    node[field] = json.loads(raw)
                continue
            raw = form.get(f"{token}_{field}", "").strip()
            if raw:
                node[field] = _coerce(field, raw)
        nodes.append(node)
    definition = {"schema_version": 1, "nodes": nodes}
    parse_definition(definition)
    return definition


def synthetic_resolve_input(definition):
    """Build a :class:`ResolveInput` over a synthetic 16-person roster.

    Every ``round`` referenced by any node gets a deterministic score table (two
    judges), and every ``vote_source`` gets a deterministic vote table. This makes
    a DRAFT ruleset Previewable without any real activity data.
    """
    nodes = parse_definition(definition)["nodes"]
    roster = tuple(str(i) for i in range(1, 17))
    round_scores: dict[str, dict[str, tuple[Decimal, ...]]] = {}
    vote_scores: dict[str, dict[str, Decimal]] = {}
    for node in nodes:
        rnd = node.get("round")
        if rnd and rnd not in round_scores:
            round_scores[rnd] = {
                str(i): (Decimal(str((100 - i + 1) / 10)), Decimal(str((100 - i + 1) / 10)))
                for i in range(1, 17)
            }
        vote_src = node.get("vote_source")
        if vote_src and vote_src not in vote_scores:
            vote_scores[vote_src] = {str(i): Decimal(str((100 - i + 1) / 10)) for i in range(1, 17)}
    return ResolveInput(
        roster=roster,
        round_scores=round_scores,
        vote_scores=vote_scores,
    )


def preview_definition(definition, *, context=None):
    """Compile then resolve ``definition`` over a synthetic input.

    Returns ``(report, plan, result)``. ``result`` is ``None`` when the graph does
    not compile (no plan), or when the resolver cannot produce a final state.
    """
    from ruleset.compiler import compile_definition
    from ruleset.resolver import resolve

    report, plan = compile_definition(definition, context=context)
    if not report.passes() or plan is None:
        return report, plan, None
    inputs = synthetic_resolve_input(definition)
    result = resolve(definition, inputs, plan=plan)
    return report, plan, result
