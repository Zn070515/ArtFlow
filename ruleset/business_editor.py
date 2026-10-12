"""Safe business-level editing for the linear contest ruleset subset.

The business editor deliberately owns a small, deterministic projection of the graph. It
can generate and update ordinary score → rank → select stages, while complex historical
graphs remain readable through the advanced editor and are never rewritten by inference.
"""

from __future__ import annotations

import json
from copy import deepcopy
from decimal import Decimal, InvalidOperation

from django.core.exceptions import ValidationError

from .schema import ENTRY_KEY, parse_definition

_EDITABLE_TYPES = frozenset({"ROSTER", "ASSESS", "AGGREGATE", "RANK", "SELECT"})
_BUSINESS_SCORING_MODES = frozenset({"average", "drop_high_low"})
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


def _scoring_mode(value, *, field: str) -> str:
    mode = str(value or "average")
    if mode not in _BUSINESS_SCORING_MODES:
        raise ValidationError(f"{field} 不是受支持的评分方式。")
    return mode


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
    stage_scoring_mode = _scoring_mode(stage.get("scoring_mode"), field=f"阶段“{key}”评分方式")
    audience_source = str(stage.get("audience_source") or "").strip()
    audience_source_stage_key = str(stage.get("audience_source_stage_key") or "").strip()
    raw_audience_source_stage_index = stage.get("audience_source_stage_index")
    audience_source_stage_index = None
    if raw_audience_source_stage_index not in (None, ""):
        try:
            audience_source_stage_index = int(raw_audience_source_stage_index)
        except (TypeError, ValueError) as exc:
            raise ValidationError(f"阶段“{key}”的观众来源名单阶段标识无效。") from exc
        if audience_source_stage_index < 0 or audience_source_stage_index >= index:
            raise ValidationError(f"阶段“{key}”的观众来源名单阶段标识无效。")
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
                    "scoring_mode": stage_scoring_mode,
                    "source": str(stage.get("source") or "").strip(),
                    "source_stage_key": str(stage.get("source_stage_key") or "").strip(),
                    "source_stage_index": stage.get("source_stage_index") or "",
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
            source_weight = _decimal(source.get("weight", "0"), field=f"阶段“{key}”评委来源权重")
            if not source_weight:
                raise ValidationError(f"阶段“{key}”的评委来源权重必须大于 0。")
            source_scoring_mode = _scoring_mode(
                source.get("scoring_mode", stage_scoring_mode),
                field=f"阶段“{key}”评分方式",
            )
            if source_scoring_mode != stage_scoring_mode:
                raise ValidationError(f"阶段“{key}”不能混用多种评分方式。")
            normalized_source: dict[str, str] = {
                "round_key": source_round,
                "round_name": str(source.get("round_name") or "").strip(),
                "weight": _decimal_text(source_weight),
                "scoring_mode": source_scoring_mode,
                "source": str(source.get("source") or "").strip(),
            }
            source_stage_key = str(source.get("source_stage_key") or "").strip()
            if source_stage_key:
                normalized_source["source_stage_key"] = source_stage_key
            raw_source_stage_index = source.get("source_stage_index")
            if raw_source_stage_index not in (None, ""):
                try:
                    source_stage_index = int(raw_source_stage_index)
                except (TypeError, ValueError) as exc:
                    raise ValidationError(f"阶段“{key}”的评委来源名单阶段标识无效。") from exc
                if source_stage_index < 0 or source_stage_index >= index:
                    raise ValidationError(f"阶段“{key}”的评委来源名单阶段标识无效。")
                normalized_source["source_stage_index"] = str(source_stage_index)
            judge_sources.append(normalized_source)
        source_total = sum((Decimal(source["weight"]) for source in judge_sources), Decimal("0"))
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
        "scoring_mode": judge_sources[0]["scoring_mode"] if judge_sources else stage_scoring_mode,
        "advance_count": advance_count,
        "judge_weight": _decimal_text(weights["judge_weight"]),
        "previous_weight": _decimal_text(weights["previous_weight"]),
        "audience_weight": _decimal_text(weights["audience_weight"]),
        "vote_source": vote_source,
        "audience_source": audience_source,
        "audience_source_stage_key": audience_source_stage_key,
        "audience_source_stage_index": (
            str(audience_source_stage_index) if audience_source_stage_index is not None else ""
        ),
    }


def _normalized_stages(stages) -> list[dict]:
    if not isinstance(stages, (list, tuple)):
        raise ValidationError("比赛阶段必须是列表。")
    result = [_normalize_stage(stage, index) for index, stage in enumerate(stages, start=1)]
    keys = [stage["key"] for stage in result]
    if len(keys) != len(set(keys)):
        raise ValidationError("比赛阶段标识不能重复。")

    def stable_source_key(raw_key, raw_index, *, stage_key: str, stage_index: int) -> str:
        if raw_key not in (None, ""):
            stable_key = str(raw_key).strip()
            if stable_key not in {ENTRY_KEY, *keys[: stage_index - 1]}:
                raise ValidationError(f"阶段“{stage_key}”引用了无效的上游阶段标识。")
            return stable_key
        if raw_index not in (None, ""):
            try:
                source_index = int(raw_index)
            except (TypeError, ValueError) as exc:
                raise ValidationError(f"阶段“{stage_key}”的上游名单阶段标识无效。") from exc
            if source_index < 0 or source_index >= stage_index:
                raise ValidationError(f"阶段“{stage_key}”的上游名单阶段标识无效。")
            return ENTRY_KEY if source_index == 0 else keys[source_index - 1]
        return ENTRY_KEY if stage_index == 1 else keys[stage_index - 2]

    for stage_index, stage in enumerate(result, start=1):
        for source in stage["judge_sources"]:
            source["source_stage_key"] = stable_source_key(
                source.get("source_stage_key"),
                source.pop("source_stage_index", None),
                stage_key=stage["key"],
                stage_index=stage_index,
            )
        stage["audience_source_stage_key"] = stable_source_key(
            stage.get("audience_source_stage_key"),
            stage.pop("audience_source_stage_index", None),
            stage_key=stage["key"],
            stage_index=stage_index,
        )
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
    existing_business = context.get("business")
    if existing_business is None:
        business_context = {}
    elif isinstance(existing_business, dict):
        business_context = deepcopy(existing_business)
    else:
        raise ValidationError("赛制 context.business 必须是对象。")
    business_context["stages"] = deepcopy(normalized)
    context["business"] = business_context

    nodes: list[dict] = [] if normalized else [{"key": "roster", "type": "ROSTER"}]
    used = set() if normalized else {"roster"}
    checkpoints: list[dict] = []
    previous_output = ENTRY_KEY
    previous_score = ""
    generated_outputs_by_stage = {ENTRY_KEY: ENTRY_KEY}
    assess_nodes_by_signature: dict[tuple[str, str, str], str] = {}
    for index, stage in enumerate(normalized, start=1):
        score_sources: list[dict] = []
        judge_weight = Decimal(stage["judge_weight"])
        previous_weight = Decimal(stage["previous_weight"])
        audience_weight = Decimal(stage["audience_weight"])

        if judge_weight:
            for judge_source in stage["judge_sources"]:
                source = judge_source.get("source") or previous_output
                source_stage_key = judge_source.get("source_stage_key")
                if source_stage_key:
                    source = generated_outputs_by_stage.get(str(source_stage_key))
                    if source is None:
                        raise ValidationError(f"阶段“{stage['key']}”引用了无法重映射的上游名单。")
                assess_signature = (
                    judge_source["round_key"],
                    source,
                    judge_source["scoring_mode"],
                )
                assess_key = assess_nodes_by_signature.get(assess_signature)
                if assess_key is None:
                    assess_key = _unique_key(used, f"assess_{judge_source['round_key']}")
                    nodes.append(
                        {
                            "key": assess_key,
                            "type": "ASSESS",
                            "source": source,
                            "round": judge_source["round_key"],
                            **(
                                {
                                    "mode": "trimmed_mean",
                                    "trim_high": 1,
                                    "trim_low": 1,
                                }
                                if judge_source["scoring_mode"] == "drop_high_low"
                                else {"mode": "mean"}
                            ),
                        }
                    )
                    assess_nodes_by_signature[assess_signature] = assess_key
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
            audience_source = stage.get("audience_source") or previous_output
            audience_source_stage_key = stage.get("audience_source_stage_key")
            if audience_source_stage_key:
                audience_source = generated_outputs_by_stage.get(str(audience_source_stage_key), "")
                if not audience_source:
                    raise ValidationError(f"阶段“{stage['key']}”引用了无法重映射的观众名单。")
            if audience_source not in generated_outputs_by_stage.values():
                raise ValidationError(f"阶段“{stage['key']}”引用了无法识别的观众名单。")
            audience_key = _unique_key(used, f"assess_{stage['vote_source']}")
            nodes.append(
                {
                    "key": audience_key,
                    "type": "ASSESS",
                    "source": audience_source,
                    "vote_source": stage["vote_source"],
                    "vote_purpose": "SCORE_COMPONENT",
                }
            )
            score_sources.append({"source": audience_key, "weight": _json_number(audience_weight)})

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
        nodes.append({"key": rank_key, "type": "RANK", "source": score_key, "descending": True})
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
        generated_outputs_by_stage[stage["key"]] = output_key
        previous_output = output_key
        previous_score = score_key
    return nodes, checkpoints, context


def _unsupported(reason: str) -> dict:
    return {"supported": False, "editable": False, "reason": reason, "stages": []}


def _component_decimal(component: dict) -> Decimal:
    return _decimal(component.get("weight"), field="综合成绩权重")


def _raw_definition(definition) -> dict:
    if isinstance(definition, dict):
        return deepcopy(definition)
    if isinstance(definition, str):
        loaded = json.loads(definition)
        if isinstance(loaded, dict):
            return loaded
    raise ValidationError("赛制定义根必须是对象。")


def _unexpected_fields(node: dict, allowed: set[str], *, label: str) -> str | None:
    unexpected = sorted(set(node) - allowed)
    if unexpected:
        return f"{label}包含业务编辑器无法保留的字段：{unexpected[0]}。"
    return None


def _assess_mode(node: dict, *, label: str) -> tuple[str, str | None]:
    if node.get("scale") is not None:
        return "", f"{label}声明了评分尺度，业务编辑器不能无损表达换算。"
    if node.get("min_judges") is not None:
        return "", f"{label}声明了最少评委数，业务编辑器不能无损表达。"
    mode = node.get("mode") or "mean"
    if mode == "mean":
        if node.get("trim_high") is not None or node.get("trim_low") is not None:
            return "", f"{label}的截尾参数不能由业务编辑器无损表达。"
        return "average", None
    if mode == "trimmed_mean" and node.get("trim_high") == 1 and node.get("trim_low") == 1:
        return "drop_high_low", None
    return "", f"{label}的评分方式不能由业务编辑器无损表达。"


def infer_business_stages(definition) -> dict:
    """Project only a demonstrably lossless linear graph into business stage cards.

    ``parse_definition`` intentionally returns the executable sections only.  Business
    labels and preserved source scopes live in the raw root context, so this function
    reads both representations and rejects anything it cannot round-trip exactly.
    """
    try:
        raw = _raw_definition(definition)
        parsed = parse_definition(raw)
    except (ValidationError, TypeError, ValueError, json.JSONDecodeError) as exc:
        return _unsupported(f"当前规则定义无法读取，不能无损表达：{exc}")

    nodes = [node for node in (parsed.get("nodes") or ()) if isinstance(node, dict)]
    nodes_by_key: dict[str, dict] = {
        node["key"]: node for node in nodes if isinstance(node.get("key"), str)
    }
    unsupported_types = [
        str(node.get("type") or "") for node in nodes if node.get("type") not in _EDITABLE_TYPES
    ]
    if unsupported_types:
        label = _COMPLEX_LABELS.get(unsupported_types[0], "复杂")
        return _unsupported(f"当前赛制包含{label}规则，业务编辑器不能无损表达。")

    # The blank editor is a first-class state.  It is deliberately narrower than a
    # normal stage graph so a stray node can never be silently deleted by a save.
    if (
        len(nodes) == 1
        and nodes[0] == {"key": "roster", "type": "ROSTER"}
        and not raw.get("checkpoints")
    ):
        return {"supported": True, "editable": True, "reason": "", "stages": []}

    checkpoints = list(parsed.get("checkpoints") or ())
    if not checkpoints:
        outputs = [node for node in nodes if node.get("type") == "SELECT"]
        if not outputs:
            return _unsupported("尚未识别到可编辑的晋级阶段。")
        checkpoints = [
            {"key": f"stage{index}", "output": node["key"], "decisions": ()}
            for index, node in enumerate(outputs, start=1)
        ]

    raw_context = raw.get("context")
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
    used: set[str] = set()
    previous_output = ENTRY_KEY
    previous_score = ""
    available_rosters = {ENTRY_KEY}
    roster_stage_key_by_output = {ENTRY_KEY: ENTRY_KEY}
    for index, checkpoint in enumerate(checkpoints, start=1):
        stage_key = str(checkpoint.get("key") or f"stage{index}")
        if checkpoint.get("decisions"):
            return _unsupported(f"阶段“{stage_key}”包含人工决定，业务编辑器不能无损表达。")
        output_key = checkpoint.get("output")
        if not isinstance(output_key, str):
            return _unsupported(f"阶段“{stage_key}”缺少输出节点。")
        output = nodes_by_key.get(output_key) or {}
        if output.get("type") != "SELECT" or not isinstance(output.get("count"), int):
            return _unsupported(f"阶段“{stage_key}”不是标准晋级阶段。")
        issue = _unexpected_fields(
            output, {"key", "type", "source", "count"}, label=f"阶段“{stage_key}”的晋级节点"
        )
        if issue:
            return _unsupported(issue)
        rank_key = output.get("source")
        rank = nodes_by_key.get(rank_key) if isinstance(rank_key, str) else None
        if not isinstance(rank, dict) or rank.get("type") != "RANK":
            return _unsupported(f"阶段“{stage_key}”缺少标准排名节点，不能无损表达。")
        if not isinstance(rank_key, str):
            return _unsupported(f"阶段“{stage_key}”缺少标准排名节点，不能无损表达。")
        issue = _unexpected_fields(
            rank, {"key", "type", "source", "descending"}, label=f"阶段“{stage_key}”的排名节点"
        )
        if issue or rank.get("descending") is not True:
            return _unsupported(issue or f"阶段“{stage_key}”的排名规则不能由业务编辑器无损表达。")
        aggregate_key = rank.get("source")
        aggregate = nodes_by_key.get(aggregate_key) if isinstance(aggregate_key, str) else None
        if not isinstance(aggregate, dict) or aggregate.get("type") != "AGGREGATE":
            return _unsupported(f"阶段“{stage_key}”缺少标准综合成绩节点。")
        if not isinstance(aggregate_key, str):
            return _unsupported(f"阶段“{stage_key}”缺少标准综合成绩节点。")
        if "conversion" in aggregate:
            return _unsupported(f"阶段“{stage_key}”包含换算规则，业务编辑器不能无损表达。")
        issue = _unexpected_fields(
            aggregate,
            {"key", "type", "within", "aggregate"},
            label=f"阶段“{stage_key}”的综合成绩节点",
        )
        if issue:
            return _unsupported(issue)
        if aggregate.get("within") != previous_output:
            return _unsupported(f"阶段“{stage_key}”的成绩范围不能由业务编辑器无损表达。")
        aggregate_spec = aggregate.get("aggregate")
        if not isinstance(aggregate_spec, dict):
            return _unsupported(f"阶段“{stage_key}”的综合成绩配置不能由业务编辑器无损表达。")
        if (
            set(aggregate_spec) != {"type", "components"}
            or aggregate_spec.get("type") != "weighted_sum"
        ):
            return _unsupported(f"阶段“{stage_key}”的综合算法不能由业务编辑器无损表达。")
        components = aggregate_spec.get("components")
        if not isinstance(components, list) or not components:
            return _unsupported(f"阶段“{stage_key}”没有可编辑的成绩来源。")

        used.update({output_key, rank_key, aggregate_key})
        judge_weight = Decimal("0")
        previous_weight = Decimal("0")
        audience_weight = Decimal("0")
        judge_sources: list[dict] = []
        vote_source = ""
        audience_source = ""
        audience_source_stage_key = ""
        scoring_modes: set[str] = set()
        component_sources: set[str] = set()
        for component in components:
            if not isinstance(component, dict) or set(component) != {"source", "weight"}:
                return _unsupported(f"阶段“{stage_key}”的成绩来源不能由业务编辑器无损表达。")
            source_key = component.get("source")
            if not isinstance(source_key, str) or source_key in component_sources:
                return _unsupported(f"阶段“{stage_key}”的成绩来源不能由业务编辑器无损表达。")
            component_sources.add(source_key)
            try:
                weight = _component_decimal(component)
            except ValidationError as exc:
                return _unsupported(f"阶段“{stage_key}”的成绩权重不能由业务编辑器无损表达：{exc}")
            source_node = nodes_by_key.get(source_key) or {}
            source_type = source_node.get("type")
            if source_type == "ASSESS":
                source_origin = source_node.get("source")
                if source_origin not in available_rosters:
                    return _unsupported(
                        f"阶段“{stage_key}”的评委来源范围不能由业务编辑器无损表达。"
                    )
                issue = _unexpected_fields(
                    source_node,
                    {
                        "key",
                        "type",
                        "source",
                        "round",
                        "vote_source",
                        "vote_purpose",
                        "mode",
                        "trim_high",
                        "trim_low",
                        "scale",
                        "min_judges",
                    },
                    label=f"阶段“{stage_key}”的成绩评估节点",
                )
                if issue:
                    return _unsupported(issue)
                if source_node.get("vote_source"):
                    if (
                        source_node.get("round")
                        or source_node.get("vote_purpose") != "SCORE_COMPONENT"
                    ):
                        return _unsupported(
                            f"阶段“{stage_key}”的观众分来源不能由业务编辑器无损表达。"
                        )
                    if any(
                        source_node.get(field) is not None
                        for field in ("mode", "trim_high", "trim_low", "scale", "min_judges")
                    ):
                        return _unsupported(
                            f"阶段“{stage_key}”的观众分配置不能由业务编辑器无损表达。"
                        )
                    current_vote_source = str(source_node["vote_source"])
                    if vote_source and vote_source != current_vote_source:
                        return _unsupported(f"阶段“{stage_key}”包含多个观众分来源。")
                    vote_source = current_vote_source
                    audience_source = str(source_origin)
                    audience_source_stage_key = roster_stage_key_by_output[source_origin]
                    audience_weight += weight
                elif source_node.get("round"):
                    if source_node.get("vote_purpose") is not None:
                        return _unsupported(
                            f"阶段“{stage_key}”的评委来源不能由业务编辑器无损表达。"
                        )
                    mode, mode_issue = _assess_mode(
                        source_node, label=f"阶段“{stage_key}”的评委来源"
                    )
                    if mode_issue:
                        return _unsupported(mode_issue)
                    scoring_modes.add(mode)
                    judge_weight += weight
                    judge_sources.append(
                        {
                            "round_key": str(source_node["round"]),
                            "round_name": "",
                            "weight": _decimal_text(weight),
                            "source": str(source_origin),
                            "scoring_mode": mode,
                            "source_stage_key": roster_stage_key_by_output[source_origin],
                        }
                    )
                else:
                    return _unsupported(f"阶段“{stage_key}”的评估来源不能由业务编辑器无损表达。")
                used.add(source_key)
            elif source_key == previous_score:
                previous_weight += weight
                used.add(source_key)
            else:
                return _unsupported(f"阶段“{stage_key}”包含业务编辑器无法识别的成绩来源。")

        total = judge_weight + previous_weight + audience_weight
        if total != Decimal("1"):
            return _unsupported(f"阶段“{stage_key}”的成绩权重不能由业务编辑器无损表达。")
        if not judge_sources:
            return _unsupported(f"阶段“{stage_key}”缺少评委轮次。")
        if len(scoring_modes) > 1:
            return _unsupported(f"阶段“{stage_key}”混用了多种评分方式。")
        saved = context_by_key.get(stage_key) or {}
        stages.append(
            {
                "key": stage_key,
                "name": str(saved.get("name") or f"第{index}阶段"),
                "round_key": judge_sources[0]["round_key"],
                "round_name": str(saved.get("round_name") or ""),
                "judge_sources": judge_sources,
                "scoring_mode": next(iter(scoring_modes), "average"),
                "advance_count": output["count"],
                "judge_weight": _decimal_text(judge_weight),
                "previous_weight": _decimal_text(previous_weight),
                "audience_weight": _decimal_text(audience_weight),
                "vote_source": vote_source,
                "audience_source": audience_source,
                "audience_source_stage_key": audience_source_stage_key,
            }
        )
        previous_output = output_key
        previous_score = aggregate_key
        available_rosters.add(output_key)
        roster_stage_key_by_output[output_key] = stage_key

    all_keys = set(nodes_by_key)
    if all_keys - used:
        extra = sorted(all_keys - used)[0]
        return _unsupported(f"节点“{extra}”未连接到业务阶段，业务编辑器不能无损表达。")
    return {"supported": True, "editable": True, "reason": "", "stages": stages}
