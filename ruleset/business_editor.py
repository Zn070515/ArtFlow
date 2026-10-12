"""Safe business-level editing for the linear contest ruleset subset.

The business editor deliberately owns a small, deterministic projection of the graph. It
can generate and update ordinary score → rank → select stages, while complex historical
graphs remain readable through the advanced editor and are never rewritten by inference.
"""

from __future__ import annotations

from copy import deepcopy
from decimal import Decimal, InvalidOperation

from django.core.exceptions import ValidationError

from .schema import ENTRY_KEY, parse_definition


_EDITABLE_TYPES = frozenset({"ROSTER", "ASSESS", "AGGREGATE", "RANK", "SELECT"})
_COMPLEX_LABELS = {
    "PARTITION": "分组",
    "MANUAL_SELECT": "人工选择",
    "BRANCH": "分支",
    "PAIR": "配对",
    "DUEL": "对决",
    "FILL_TO_QUOTA": "补足名额",
}


def _decimal(value, *, field: str, minimum: Decimal = Decimal("0")) -> Decimal:
    try:
        result = Decimal(str(value))
    except (InvalidOperation, TypeError, ValueError) as exc:
        raise ValidationError(f"{field} 必须是数字。") from exc
    if not result.is_finite() or result < minimum:
        raise ValidationError(f"{field} 必须是大于等于 {minimum} 的有限数字。")
    return result


def _decimal_text(value: Decimal) -> str:
    text = format(value, "f").rstrip("0").rstrip(".")
    return text or "0"


def _json_number(value: Decimal) -> int | float:
    if value == value.to_integral_value():
        return int(value)
    return float(value)


def _stage_key(stage, index: int) -> str:
    key = str(stage.get("key") or f"stage{index}").strip()
    if not key:
        raise ValidationError(f"第 {index} 个比赛阶段必须有标识。")
    return key


def _normalize_stage(stage, index: int) -> dict:
    if not isinstance(stage, dict):
        raise ValidationError(f"第 {index} 个比赛阶段必须是对象。")
    key = _stage_key(stage, index)
    raw_advance_count = stage.get("advance_count")
    if raw_advance_count is None:
        raise ValidationError(f"阶段“{key}”的晋级人数必须是正整数。")
    try:
        advance_count = int(str(raw_advance_count))
    except (TypeError, ValueError) as exc:
        raise ValidationError(f"阶段“{key}”的晋级人数必须是正整数。") from exc
    if advance_count <= 0:
        raise ValidationError(f"阶段“{key}”的晋级人数必须是正整数。")

    weights = {
        "judge_weight": _decimal(stage.get("judge_weight", "1"), field=f"阶段“{key}”评委权重"),
        "previous_weight": _decimal(
            stage.get("previous_weight", "0"), field=f"阶段“{key}”上一阶段权重"
        ),
        "audience_weight": _decimal(
            stage.get("audience_weight", "0"), field=f"阶段“{key}”观众权重"
        ),
    }
    total = sum(weights.values(), Decimal("0"))
    if total != Decimal("1"):
        raise ValidationError(f"阶段“{key}”的成绩权重必须合计为 1。")
    if index == 1 and weights["previous_weight"]:
        raise ValidationError("第一阶段不能引用上一阶段成绩。")
    raw_judge_sources = stage.get("judge_sources")
    if raw_judge_sources is None:
        round_key = str(stage.get("round_key") or "").strip()
        if weights["judge_weight"] and not round_key:
            raise ValidationError(f"阶段“{key}”必须绑定轮次标识。")
        judge_sources = (
            [
                {
                    "round_key": round_key,
                    "round_name": str(stage.get("round_name") or "").strip(),
                    "weight": _decimal_text(weights["judge_weight"]),
                }
            ]
            if weights["judge_weight"]
            else []
        )
    else:
        if not isinstance(raw_judge_sources, (list, tuple)) or not raw_judge_sources:
            raise ValidationError(f"阶段“{key}”的评委来源必须是非空列表。")
        judge_sources = []
        for source_index, source in enumerate(raw_judge_sources, start=1):
            if not isinstance(source, dict):
                raise ValidationError(f"阶段“{key}”的第 {source_index} 个评委来源必须是对象。")
            source_round = str(source.get("round_key") or "").strip()
            if not source_round:
                raise ValidationError(f"阶段“{key}”的评委来源必须绑定轮次标识。")
            source_weight = _decimal(
                source.get("weight", "0"), field=f"阶段“{key}”评委来源权重"
            )
            if not source_weight:
                raise ValidationError(f"阶段“{key}”的评委来源权重必须大于 0。")
            judge_sources.append(
                {
                    "round_key": source_round,
                    "round_name": str(source.get("round_name") or "").strip(),
                    "weight": _decimal_text(source_weight),
                }
            )
        source_total = sum(
            (Decimal(source["weight"]) for source in judge_sources), Decimal("0")
        )
        if source_total != weights["judge_weight"]:
            raise ValidationError(f"阶段“{key}”的评委来源权重必须合计为评委权重。")
    round_key = judge_sources[0]["round_key"] if judge_sources else ""
    vote_source = str(stage.get("vote_source") or "").strip()
    if weights["audience_weight"] and not vote_source:
        raise ValidationError(f"阶段“{key}”使用观众权重时必须绑定投票来源。")
    if not weights["audience_weight"]:
        vote_source = ""
    return {
        "key": key,
        "name": str(stage.get("name") or f"第{index}阶段").strip(),
        "round_key": round_key,
        "round_name": judge_sources[0]["round_name"] if judge_sources else "",
        "judge_sources": judge_sources,
        "advance_count": advance_count,
        "judge_weight": _decimal_text(weights["judge_weight"]),
        "previous_weight": _decimal_text(weights["previous_weight"]),
        "audience_weight": _decimal_text(weights["audience_weight"]),
        "vote_source": vote_source,
    }


def _normalized_stages(stages) -> list[dict]:
    if not isinstance(stages, (list, tuple)):
        raise ValidationError("比赛阶段必须是列表。")
    result = [_normalize_stage(stage, index) for index, stage in enumerate(stages, start=1)]
    keys = [stage["key"] for stage in result]
    if len(keys) != len(set(keys)):
        raise ValidationError("比赛阶段标识不能重复。")
    return result


def _unique_key(used: set[str], base: str) -> str:
    key = base
    index = 2
    while key in used:
        key = f"{base}_{index}"
        index += 1
    used.add(key)
    return key


def business_definition_from_stages(
    stages, *, existing_context: dict | None = None
) -> tuple[list[dict], list[dict], dict]:
    """Generate a deterministic linear graph and business context from stage cards."""
    normalized = _normalized_stages(stages)
    context = deepcopy(existing_context or {})
    if not isinstance(context, dict):
        raise ValidationError("赛制 context 必须是对象。")
    context["business"] = {"stages": deepcopy(normalized)}

    nodes: list[dict] = [] if normalized else [{"key": "roster", "type": "ROSTER"}]
    used = set() if normalized else {"roster"}
    checkpoints: list[dict] = []
    previous_output = ENTRY_KEY
    previous_score = ""
    for index, stage in enumerate(normalized, start=1):
        round_key = stage["round_key"]
        score_sources: list[dict] = []
        judge_weight = Decimal(stage["judge_weight"])
        previous_weight = Decimal(stage["previous_weight"])
        audience_weight = Decimal(stage["audience_weight"])

        if judge_weight:
            for judge_source in stage["judge_sources"]:
                assess_key = _unique_key(used, f"assess_{judge_source['round_key']}")
                nodes.append(
                    {
                        "key": assess_key,
                        "type": "ASSESS",
                        "source": previous_output,
                        "round": judge_source["round_key"],
                    }
                )
                score_sources.append(
                    {
                        "source": assess_key,
                        "weight": _json_number(Decimal(judge_source["weight"])),
                    }
                )
        if previous_weight:
            if not previous_score:
                raise ValidationError(f"阶段“{stage['key']}”不能引用不存在的上一阶段成绩。")
            score_sources.insert(
                0,
                {"source": previous_score, "weight": _json_number(previous_weight)},
            )
        if audience_weight:
            audience_key = _unique_key(used, f"assess_{stage['vote_source']}")
            nodes.append(
                {
                    "key": audience_key,
                    "type": "ASSESS",
                    "source": previous_output,
                    "vote_source": stage["vote_source"],
                    "vote_purpose": "SCORE_COMPONENT",
                }
            )
            score_sources.append(
                {"source": audience_key, "weight": _json_number(audience_weight)}
            )

        score_key = _unique_key(used, stage["key"])
        nodes.append(
            {
                "key": score_key,
                "type": "AGGREGATE",
                "within": previous_output,
                "aggregate": {"type": "weighted_sum", "components": score_sources},
            }
        )
        rank_key = _unique_key(used, f"rank{index}")
        nodes.append(
            {"key": rank_key, "type": "RANK", "source": score_key, "descending": True}
        )
        output_base = f"top{stage['advance_count']}"
        output_key = _unique_key(used, output_base)
        nodes.append(
            {
                "key": output_key,
                "type": "SELECT",
                "source": rank_key,
                "count": stage["advance_count"],
            }
        )
        checkpoints.append({"key": stage["key"], "output": output_key})
        previous_output = output_key
        previous_score = score_key
    return nodes, checkpoints, context


def _unsupported(reason: str) -> dict:
    return {"supported": False, "editable": False, "reason": reason, "stages": []}


def _component_decimal(component: dict) -> Decimal:
    return _decimal(component.get("weight"), field="综合成绩权重")


def infer_business_stages(definition) -> dict:
    """Safely project a linear graph into business stage cards."""
    try:
        parsed = parse_definition(definition)
    except ValidationError as exc:
        return _unsupported(f"当前规则定义无法读取：{exc}")
    nodes = [node for node in (parsed.get("nodes") or ()) if isinstance(node, dict)]
    nodes_by_key: dict[str, dict] = {
        node["key"]: node
        for node in nodes
        if isinstance(node.get("key"), str)
    }
    unsupported_types = [
        str(node.get("type") or "") for node in nodes if node.get("type") not in _EDITABLE_TYPES
    ]
    if unsupported_types:
        label = _COMPLEX_LABELS.get(unsupported_types[0], "复杂")
        return _unsupported(f"当前赛制包含{label}规则，业务编辑器不能无损表达。")

    checkpoints = list(parsed.get("checkpoints") or ())
    if not checkpoints:
        outputs = [node for node in nodes if node.get("type") == "SELECT"]
        if not outputs:
            return _unsupported("尚未识别到可编辑的晋级阶段。")
        checkpoints = [
            {"key": f"stage{index}", "output": node["key"]}
            for index, node in enumerate(outputs, start=1)
        ]

    raw_context = parsed.get("context")
    context = raw_context if isinstance(raw_context, dict) else {}
    raw_business = context.get("business")
    business = raw_business if isinstance(raw_business, dict) else {}
    raw_stage_context = business.get("stages")
    stage_context = raw_stage_context if isinstance(raw_stage_context, list) else []
    context_by_key: dict[str, dict] = {
        item["key"]: item
        for item in stage_context
        if isinstance(item, dict) and isinstance(item.get("key"), str)
    }
    stages: list[dict] = []
    previous_score = ""
    for index, checkpoint in enumerate(checkpoints, start=1):
        output_key = checkpoint.get("output")
        if not isinstance(output_key, str):
            return _unsupported(f"阶段“{checkpoint.get('key', index)}”缺少输出节点。")
        output = nodes_by_key.get(output_key) or {}
        if output.get("type") != "SELECT" or not isinstance(output.get("count"), int):
            return _unsupported(f"阶段“{checkpoint.get('key', index)}”不是标准晋级阶段。")
        current = output
        visited = set()
        aggregate = None
        while current and current.get("key") not in visited:
            visited.add(current.get("key"))
            if current.get("type") == "AGGREGATE":
                aggregate = current
                break
            source = current.get("source")
            current = nodes_by_key.get(source) if isinstance(source, str) else None
        if aggregate is None:
            return _unsupported(f"阶段“{checkpoint.get('key', index)}”缺少可编辑的综合成绩。")

        judge_weight = Decimal("0")
        previous_weight = Decimal("0")
        audience_weight = Decimal("0")
        judge_sources = []
        vote_source = ""
        for component in (aggregate.get("aggregate") or {}).get("components") or ():
            source_key = component.get("source")
            source_node = nodes_by_key.get(source_key) or {}
            weight = _component_decimal(component)
            source_type = source_node.get("type")
            if source_type == "ASSESS" and source_node.get("vote_source"):
                audience_weight += weight
                vote_source = str(source_node.get("vote_source"))
            elif source_type == "ASSESS" and source_node.get("round"):
                judge_weight += weight
                judge_sources.append(
                    {
                        "round_key": str(source_node.get("round")),
                        "round_name": "",
                        "weight": _decimal_text(weight),
                    }
                )
            elif source_key == previous_score:
                previous_weight += weight
            else:
                return _unsupported(
                    f"阶段“{checkpoint.get('key', index)}”包含业务编辑器无法识别的成绩来源。"
                )
        if not judge_sources:
            return _unsupported(f"阶段“{checkpoint.get('key', index)}”缺少评委轮次。")
        stage_key = str(checkpoint.get("key") or f"stage{index}")
        saved = context_by_key.get(stage_key) or {}
        stages.append(
            {
                "key": stage_key,
                "name": str(saved.get("name") or f"第{index}阶段"),
                "round_key": judge_sources[0]["round_key"],
                "round_name": str(saved.get("round_name") or ""),
                "judge_sources": judge_sources,
                "advance_count": output["count"],
                "judge_weight": _decimal_text(judge_weight),
                "previous_weight": _decimal_text(previous_weight),
                "audience_weight": _decimal_text(audience_weight),
                "vote_source": vote_source,
            }
        )
        previous_score = aggregate.get("key") or ""
    return {"supported": True, "editable": True, "reason": "", "stages": stages}
