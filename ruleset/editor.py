"""Pure form <-> definition serialization for the M1-I ruleset editor.

This module is deliberately DB-free. It converts the editor's self-submitting POST
payload into the typed ``nodes`` list (reusing :data:`~ruleset.schema.NODE_TYPE_SPEC`),
and builds a synthetic :class:`~ruleset.resolver.ResolveInput` so a DRAFT ruleset can be
Preview'd before it is ever wired to real rounds.

It never assembles a whole definition document. The root is owned by
:func:`ruleset.services.update_ruleset_definition_section`, which replaces the single
section an editor owns and returns every sibling section byte-identical; a helper here
that returned ``{"schema_version", "nodes"}`` would delete ``checkpoints`` /
``context`` / ``questionnaire`` on each save.
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
    "pairing_policy": "配对策略",
    "decision_source": "决策来源",
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
    "tie_break_source": "平局参考成绩",
    "ranking_source": "排名依据",
}

_FIELD_ALLOWED = {
    "scale": ["hundred", "ten", "raw", "ordinal", "votes"],
    "mode": ["mean", "trimmed_mean"],
    "tie_policy": ["auto_break", "extra_round", "manual", "score_fallback"],
    "odd_policy": ["bye", "wildcard", "manual", "reject"],
    "pairing_policy": ["ADJACENT", "HIGH_LOW"],
    "vote_purpose": ["POPULARITY", "SCORE_COMPONENT", "SELECTION", "OTHER"],
    "decision_source": ["manual_recorded_result"],
}

_FIELD_HELP = {
    "source": "选择本节点读取的上游结果；只会显示当前顺序中合法的来源。",
    "round": "填写活动绑定中的轮次键，评分节点会读取该轮次的原始分。",
    "scale": "决定这个节点的数值单位，例如百分制、十分制或名次。",
    "mode": "选择多个评委分数如何合成为一个选手分数。",
    "trim_high": "去掉的最高分数量；不需要时留空。",
    "trim_low": "去掉的最低分数量；不需要时留空。",
    "min_judges": "至少收到多少名有效评委的分数才允许进入计算。",
    "descending": "勾选后数值越大排名越靠前。",
    "tie_policy": "出现同分时采用的处理方式；人工裁定会停在人工决策环节。",
    "by": "按哪个分组结果处理；分组节点本身填写业务上的分组依据。",
    "count": "从来源中选出的名额数量。",
    "quota": "希望补足到的名额数量。",
    "groups": "人工决策或分组要处理的组数。",
    "odd_policy": "遇到人数为奇数时如何处理。",
    "pairing_policy": "决定选手如何组成配对。",
    "decision_source": "对决结果从哪里记录；当前只支持人工记录。",
    "vote_source": "选择绑定中的投票来源键，不要填写数据库编号。",
    "vote_purpose": "说明投票数据用于人气、成绩组成还是晋级选择。",
    "award": "填写面向工作人员和公示使用的奖项名称。",
    "minuend": "选择需要被排除项的名单来源。",
    "subtrahend": "选择要从被减数中排除的名单来源。",
    "sources": "选择要合并的多个名单来源。",
    "within": "把计算范围限制在某个上游结果内；不需要时留空。",
    "tie_break_source": "同分时参考的上游成绩来源；不需要时留空。",
    "ranking_source": "补足名额时使用的排名来源；不需要时留空。",
    "branches": "高级分支配置；普通赛制不需要编辑。",
    "conversion": "高级分数换算配置；普通赛制不需要编辑。",
    "aggregate": "选择需要合成的上游成绩及权重，权重会由服务层校验。",
}

_FIELD_OPTION_LABELS = {
    "scale": {
        "hundred": "百分制",
        "ten": "十分制",
        "raw": "原始分",
        "ordinal": "名次",
        "votes": "票数",
    },
    "mode": {
        "mean": "平均分",
        "trimmed_mean": "去极值平均分",
    },
    "tie_policy": {
        "auto_break": "按规则自动处理",
        "extra_round": "加赛",
        "manual": "人工裁定",
        "score_fallback": "按备用成绩",
    },
    "odd_policy": {
        "bye": "轮空",
        "wildcard": "候补晋级",
        "manual": "人工安排",
        "reject": "不允许奇数",
    },
    "pairing_policy": {
        "ADJACENT": "相邻配对",
        "HIGH_LOW": "高低配对",
    },
    "vote_purpose": {
        "POPULARITY": "人气投票",
        "SCORE_COMPONENT": "成绩组成部分",
        "SELECTION": "晋级选择",
        "OTHER": "其他用途",
    },
    "decision_source": {
        "manual_recorded_result": "人工记录结果",
    },
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


def field_help():
    return dict(_FIELD_HELP)


def field_allowed():
    return {k: list(v) for k, v in _FIELD_ALLOWED.items()}


def field_option_labels():
    return {key: dict(value) for key, value in _FIELD_OPTION_LABELS.items()}


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


def definition_nodes(definition) -> list[dict]:
    """Return the ``nodes`` list of a stored definition, unnormalized.

    The editor round-trips what the operator actually wrote, so this reads the raw root
    rather than :func:`~ruleset.schema.parse_definition`'s normalized view (which also
    stamps derived keys such as ``outputs``). Accepts a JSON string or a parsed mapping.
    """
    if isinstance(definition, str):
        try:
            definition = json.loads(definition)
        except ValueError as exc:
            raise ValueError("赛制定义不是合法 JSON。") from exc
    nodes = definition.get("nodes") if isinstance(definition, dict) else None
    if not isinstance(nodes, list):
        raise ValueError("赛制定义缺少 nodes 列表。")
    return nodes


def nodes_from_form(form) -> list[dict]:
    """Rebuild the ``nodes`` list from the editor's POST payload.

    Returns the node list alone — the caller patches ``definition.nodes`` as one section,
    so ``checkpoints`` / ``context`` / ``questionnaire`` are never touched by a node edit.

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
            if field == "sources":
                values = form.getlist(f"{token}_{field}") if hasattr(form, "getlist") else []
                if not values:
                    values = [form.get(f"{token}_{field}", "")]
                raw_sources = [
                    item.strip()
                    for value in values
                    for item in value.split(",")
                    if item.strip()
                ]
                if raw_sources:
                    node[field] = raw_sources
                continue
            raw = form.get(f"{token}_{field}", "").strip()
            if raw:
                node[field] = _coerce(field, raw)
        nodes.append(node)
    parse_definition({"nodes": nodes})
    return nodes


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
