"""Business-facing ruleset planning schema and validation primitives."""

from __future__ import annotations

import json
from copy import deepcopy
from dataclasses import dataclass
from decimal import Decimal, InvalidOperation
from enum import StrEnum
from typing import Any, Mapping

from django.core.exceptions import ValidationError


class PlanningResolution(StrEnum):
    CONFIRMED = "confirmed"
    PENDING = "pending"
    CONFLICT = "conflict"


class PlanningSeverity(StrEnum):
    MISSING_INFORMATION = "missing_information"
    BUSINESS_CONFLICT = "business_conflict"
    EXECUTION_RISK = "execution_risk"


@dataclass(frozen=True)
class ParsedPercentage:
    percent: Decimal
    coefficient: Decimal
    requires_confirmation: bool
    had_percent_sign: bool


@dataclass(frozen=True)
class PlanningIssue:
    code: str
    severity: PlanningSeverity
    stage_id: str = ""
    round_id: str = ""
    field_path: str = ""
    message: str = ""
    why: str = ""
    confirm_with: str = ""
    blocks_apply: bool = False

    def to_dict(self) -> dict[str, object]:
        return {
            "code": self.code,
            "severity": self.severity.value,
            "stage_id": self.stage_id,
            "round_id": self.round_id,
            "field_path": self.field_path,
            "message": self.message,
            "why": self.why,
            "confirm_with": self.confirm_with,
            "blocks_apply": self.blocks_apply,
        }


@dataclass(frozen=True)
class PlanningProjection:
    stages: tuple[dict[str, object], ...]
    payload: dict[str, object]
    source: str
    editable: bool
    read_only: bool
    notice: str = ""
    summary: dict[str, object] | None = None


@dataclass(frozen=True)
class PlanningCompileResult:
    issues: tuple[PlanningIssue, ...]
    candidate_definition: dict[str, object] | None
    business_stages: tuple[dict[str, object], ...]
    round_configurations: tuple[dict[str, object], ...]
    change_summary: tuple[str, ...]

    @property
    def can_apply(self) -> bool:
        return self.candidate_definition is not None and not any(
            issue.blocks_apply for issue in self.issues
        )


PLANNING_UNITS = frozenset(
    {"text", "person", "group", "judge", "minute", "score", "percent", "vote"}
)


def default_planning_payload() -> dict[str, object]:
    return {"schema_version": 1, "stages": [], "execution_refs": {}}


def planning_field(
    value: object,
    resolution: PlanningResolution | str,
    evidence: str,
    unit: str,
) -> dict[str, object]:
    """Build one versioned business field without changing its value semantics."""
    resolution_value = (
        resolution.value if isinstance(resolution, PlanningResolution) else resolution
    )
    if resolution_value not in {item.value for item in PlanningResolution}:
        raise ValidationError("规划字段的确认状态无效。")
    if unit not in PLANNING_UNITS:
        raise ValidationError("规划字段的单位无效。")
    if not isinstance(evidence, str):
        raise ValidationError("规划字段的依据必须是文字。")
    return {
        "value": value,
        "resolution": resolution_value,
        "evidence": evidence,
        "unit": unit,
    }


def parse_percentage(value: object) -> ParsedPercentage:
    """Parse a human percentage as a percentage value and Decimal coefficient.

    Values are never interpreted as coefficients.  Thus ``0.5`` means 0.5 percent,
    while the missing percent sign is surfaced as a confirmation requirement.
    """
    if isinstance(value, bool) or value is None:
        raise ValidationError("百分比格式无效，请填写 0 到 100 之间的数字。")
    if isinstance(value, Decimal):
        raw = format(value, "f")
    elif isinstance(value, (int, float)):
        raw = str(value)
    elif isinstance(value, str):
        raw = value.strip()
    else:
        raise ValidationError("百分比格式无效，请填写 0 到 100 之间的数字。")
    had_percent_sign = raw.endswith("%")
    if had_percent_sign:
        raw = raw[:-1].strip()
    if not raw or "%" in raw:
        raise ValidationError("百分比格式无效，请填写 0 到 100 之间的数字。")
    try:
        percent = Decimal(raw)
    except (InvalidOperation, ValueError):
        raise ValidationError("百分比格式无效，请填写 0 到 100 之间的数字。") from None
    if not percent.is_finite() or percent < 0 or percent > 100:
        raise ValidationError("百分比必须在 0% 到 100% 之间。")
    return ParsedPercentage(
        percent=percent,
        coefficient=percent / Decimal("100"),
        requires_confirmation=not had_percent_sign and Decimal("0") < percent < Decimal("1"),
        had_percent_sign=had_percent_sign,
    )


def _as_mapping(value: object, *, message: str) -> Mapping[str, object]:
    if not isinstance(value, Mapping):
        raise ValidationError(message)
    return value


def _mapping_list(value: object) -> list[dict[str, object]]:
    if not isinstance(value, list):
        return []
    result: list[dict[str, object]] = []
    for item in value:
        if isinstance(item, Mapping):
            result.append({str(key): item_value for key, item_value in item.items()})
    return result


def _field_issue(
    *,
    code: str,
    severity: PlanningSeverity,
    stage_id: str,
    field_path: str,
    message: str,
    blocks_apply: bool,
) -> PlanningIssue:
    return PlanningIssue(
        code=code,
        severity=severity,
        stage_id=stage_id,
        field_path=field_path,
        message=message,
        blocks_apply=blocks_apply,
    )


def _validate_field_object(
    value: object,
    *,
    stage_id: str,
    field_path: str,
) -> tuple[PlanningIssue, ...]:
    if not isinstance(value, Mapping):
        return ()
    if "resolution" not in value and "unit" not in value:
        return ()
    resolution = value.get("resolution")
    unit = value.get("unit")
    if resolution not in {item.value for item in PlanningResolution}:
        raise ValidationError(f"规划字段 {field_path} 的确认状态无效。")
    if unit not in PLANNING_UNITS:
        raise ValidationError(f"规划字段 {field_path} 的单位无效。")
    issues: list[PlanningIssue] = []
    if resolution == PlanningResolution.CONFLICT.value:
        issues.append(
            _field_issue(
                code="CONFLICTING_EVIDENCE",
                severity=PlanningSeverity.BUSINESS_CONFLICT,
                stage_id=stage_id,
                field_path=field_path,
                message="这个信息有互相冲突的依据，需要负责人确认。",
                blocks_apply=True,
            )
        )
    elif resolution == PlanningResolution.PENDING.value:
        issues.append(
            _field_issue(
                code="MISSING_INFORMATION",
                severity=PlanningSeverity.MISSING_INFORMATION,
                stage_id=stage_id,
                field_path=field_path,
                message="这个信息尚待确定。",
                blocks_apply=True,
            )
        )
    return tuple(issues)


def validate_planning_draft(payload: object) -> tuple[PlanningIssue, ...]:
    """Validate business planning JSON while preserving incomplete-but-saveable input."""
    root = _as_mapping(payload, message="规划草稿必须是 JSON 对象。")
    if root.get("schema_version") != 1:
        raise ValidationError("规划草稿版本不受支持。")
    stages = root.get("stages", [])
    if not isinstance(stages, list):
        raise ValidationError("规划草稿的比赛流程必须是列表。")
    issues: list[PlanningIssue] = []
    for index, raw_stage in enumerate(stages):
        stage = _as_mapping(raw_stage, message="比赛流程中的阶段必须是对象。")
        stage_id = stage.get("business_id")
        if not isinstance(stage_id, str) or not stage_id.strip():
            raise ValidationError(f"第 {index + 1} 个比赛阶段缺少业务标识。")
        participants = stage.get("participants")
        if isinstance(participants, Mapping) and participants.get("count") is None:
            issues.append(
                PlanningIssue(
                    code="MISSING_PARTICIPANT_COUNT",
                    severity=PlanningSeverity.MISSING_INFORMATION,
                    stage_id=stage_id,
                    field_path=f"stages[{index}].participants.count",
                    message="这个阶段的参赛人数尚待确定。",
                    blocks_apply=True,
                )
            )
        raw_sources = stage.get("judge_sources")
        if isinstance(raw_sources, list):
            for source_index, raw_source in enumerate(raw_sources):
                if not isinstance(raw_source, Mapping):
                    continue
                raw_weight = raw_source.get("weight")
                if isinstance(raw_weight, Mapping):
                    raw_weight = raw_weight.get("value")
                if raw_weight not in (None, ""):
                    try:
                        parse_percentage(raw_weight)
                    except ValidationError as exc:
                        raise ValidationError(
                            f"第 {index + 1} 个阶段第 {source_index + 1} 个成绩比例：{exc}"
                        ) from exc
        raw_audience_weight = stage.get("audience_weight")
        if isinstance(raw_audience_weight, Mapping):
            raw_audience_weight = raw_audience_weight.get("value")
        if raw_audience_weight not in (None, ""):
            try:
                parse_percentage(raw_audience_weight)
            except ValidationError as exc:
                raise ValidationError(f"第 {index + 1} 个阶段观众成绩比例：{exc}") from exc
        for field_name, field_value in stage.items():
            issues.extend(
                _validate_field_object(
                    field_value,
                    stage_id=stage_id,
                    field_path=f"stages[{index}].{field_name}",
                )
            )
    return tuple(issues)


def _planning_value(value: object, *, label: str) -> object:
    if isinstance(value, Mapping) and "value" in value:
        resolution = value.get("resolution")
        if resolution != PlanningResolution.CONFIRMED.value:
            raise ValidationError(f"{label} 尚待确定或存在冲突。")
        value = value.get("value")
    if value is None or value == "":
        raise ValidationError(f"{label} 尚待确定。")
    return value


def _decimal_text(value: Decimal) -> str:
    text = format(value, "f").rstrip("0").rstrip(".")
    return text or "0"


def _percentage_coefficient(value: object, *, label: str) -> Decimal:
    parsed = parse_percentage(_planning_value(value, label=label))
    if parsed.requires_confirmation:
        raise ValidationError(f"{label} 的小数含义需要确认。")
    return parsed.coefficient


def _stage_text(value: object, *, label: str, default: str = "") -> str:
    if value is None or value == "":
        return default
    return str(_planning_value(value, label=label)).strip()


def _stage_count(value: object, *, label: str) -> int:
    raw = _planning_value(value, label=label)
    try:
        count = int(str(raw))
    except (TypeError, ValueError) as exc:
        raise ValidationError(f"{label} 必须是正整数。") from exc
    if count <= 0:
        raise ValidationError(f"{label} 必须是正整数。")
    return count


def planning_payload_to_business_stages(payload: Mapping[str, object]) -> list[dict[str, object]]:
    """Convert a complete planning payload into the existing linear editor shape."""
    issues = validate_planning_draft(payload)
    if any(issue.blocks_apply for issue in issues):
        raise ValidationError("规划草稿仍有待确认事项。")
    raw_stages = payload.get("stages")
    if not isinstance(raw_stages, list) or not raw_stages:
        raise ValidationError("至少需要一个比赛阶段。")

    stages: list[dict[str, object]] = []
    previous_stage_key = "entry"
    for stage_index, raw_stage in enumerate(raw_stages, start=1):
        if not isinstance(raw_stage, Mapping):
            raise ValidationError("比赛阶段必须是对象。")
        stage_key = f"stage{stage_index}"
        stage_name = _stage_text(
            raw_stage.get("name"), label=f"第 {stage_index} 阶段名称", default=f"第{stage_index}阶段"
        )
        advance_count = _stage_count(
            raw_stage.get("advance_count"), label=f"阶段“{stage_name}”的晋级人数"
        )
        result_method = _stage_text(
            raw_stage.get("result_method"), label=f"阶段“{stage_name}”的结果方式"
        )
        if result_method != "top_n":
            raise ValidationError(f"阶段“{stage_name}”的结果方式不能由普通工作台应用。")

        raw_sources = raw_stage.get("judge_sources")
        if not isinstance(raw_sources, list) or not raw_sources:
            raise ValidationError(f"阶段“{stage_name}”缺少评委成绩来源。")
        judge_sources: list[dict[str, object]] = []
        for round_index, raw_source in enumerate(raw_sources, start=1):
            if not isinstance(raw_source, Mapping):
                raise ValidationError(f"阶段“{stage_name}”的评委成绩来源必须是对象。")
            round_id = _stage_text(
                raw_source.get("business_id"),
                label=f"阶段“{stage_name}”的第 {round_index} 个演唱轮次",
                default=f"round-{stage_index}-{round_index}",
            )
            round_key = _stage_text(
                raw_source.get("round_key"),
                label=f"阶段“{stage_name}”的第 {round_index} 个轮次标识",
                default=round_id,
            )
            weight = _percentage_coefficient(
                raw_source.get("weight"),
                label=f"阶段“{stage_name}”的第 {round_index} 个成绩比例",
            )
            judge_sources.append(
                {
                    "round_key": round_key,
                    "round_name": _stage_text(
                        raw_source.get("name"), label="演唱轮次名称", default=f"第{round_index}轮"
                    ),
                    "weight": _decimal_text(weight),
                    "scoring_mode": "average",
                    "source": previous_stage_key,
                    "source_stage_key": previous_stage_key,
                    "business_id": round_id,
                    "create_round": True,
                }
            )

        judge_weight = sum(
            (Decimal(str(source["weight"])) for source in judge_sources), Decimal("0")
        )
        previous_weight = _percentage_coefficient(
            raw_stage.get("previous_weight", "0"),
            label=f"阶段“{stage_name}”的上一阶段成绩比例",
        )
        audience_weight = _percentage_coefficient(
            raw_stage.get("audience_weight", "0"),
            label=f"阶段“{stage_name}”的观众成绩比例",
        )
        raw_audience_source = raw_stage.get("audience_source")
        if isinstance(raw_audience_source, Mapping) and raw_audience_source.get("value") in (
            None,
            "",
        ):
            audience_source = ""
        else:
            audience_source = _stage_text(
                raw_audience_source,
                label="观众成绩来源",
                default="",
            )
        if audience_weight and not audience_source:
            raise ValidationError(f"阶段“{stage_name}”使用观众成绩时必须有来源。")
        if judge_weight + previous_weight + audience_weight != Decimal("1"):
            raise ValidationError(f"阶段“{stage_name}”的成绩比例必须合计为 100%。")
        stages.append(
            {
                "key": stage_key,
                "name": stage_name,
                "round_key": str(judge_sources[0]["round_key"]),
                "round_name": str(judge_sources[0]["round_name"]),
                "judge_sources": judge_sources,
                "scoring_mode": "average",
                "advance_count": advance_count,
                "judge_weight": _decimal_text(judge_weight),
                "previous_weight": _decimal_text(previous_weight),
                "audience_weight": _decimal_text(audience_weight),
                "vote_source": audience_source,
                "audience_source": previous_stage_key if audience_weight else "",
                "audience_source_stage_key": previous_stage_key if audience_weight else "",
            }
        )
        previous_stage_key = stage_key
    return stages


def _planning_issue_for_conversion(error: ValidationError) -> PlanningIssue:
    message = str(error)
    if "结果方式" in message:
        code = "UNSUPPORTED_RESULT_METHOD"
        severity = PlanningSeverity.EXECUTION_RISK
    else:
        code = "WEIGHTS_INCOMPLETE"
        severity = PlanningSeverity.MISSING_INFORMATION
    return PlanningIssue(
        code=code,
        severity=severity,
        message=message,
        blocks_apply=True,
    )


def prepare_planning_compile(
    payload: Mapping[str, object], current_definition: object
) -> PlanningCompileResult:
    """Validate and prepare a candidate without writing executable state."""
    from ruleset.business_editor import business_definition_from_stages, infer_business_stages
    from ruleset.schema import parse_definition

    issues = list(validate_planning_draft(payload))
    try:
        business_stages = planning_payload_to_business_stages(payload)
    except ValidationError as exc:
        issues.append(_planning_issue_for_conversion(exc))
        return PlanningCompileResult(
            issues=tuple(issues),
            candidate_definition=None,
            business_stages=(),
            round_configurations=(),
            change_summary=(),
        )

    current_projection = infer_business_stages(current_definition)
    if not current_projection.get("supported"):
        issues.append(
            PlanningIssue(
                code="CURRENT_DEFINITION_COMPLEX",
                severity=PlanningSeverity.EXECUTION_RISK,
                message="当前正式规则包含复杂结构，需要专业工具修改。",
                blocks_apply=True,
            )
        )
        return PlanningCompileResult(
            issues=tuple(issues),
            candidate_definition=None,
            business_stages=tuple(business_stages),
            round_configurations=(),
            change_summary=(),
        )
    if isinstance(current_definition, str):
        current_root = json.loads(current_definition)
    elif isinstance(current_definition, dict):
        current_root = deepcopy(current_definition)
    else:
        raise ValidationError("赛制定义必须是 JSON 对象或 JSON 文字。")
    parsed_root = parse_definition(current_root)
    existing_context = parsed_root.get("context")
    if not isinstance(existing_context, dict):
        existing_context = {}
    nodes, checkpoints, context = business_definition_from_stages(
        business_stages,
        existing_context=existing_context,
    )
    candidate_definition: dict[str, object] = {
        "schema_version": parsed_root.get("schema_version", 1),
        "nodes": nodes,
        "checkpoints": checkpoints,
        "context": context,
    }
    round_configurations_list: list[dict[str, object]] = []
    for stage_index, stage in enumerate(business_stages, start=1):
        raw_sources = stage.get("judge_sources")
        if not isinstance(raw_sources, list):
            continue
        for source in raw_sources:
            if not isinstance(source, Mapping):
                continue
            round_configurations_list.append(
                {
                    "business_id": str(source["business_id"]),
                    "round_key": str(source["round_key"]),
                    "name": str(source["round_name"]),
                    "scoring_mode": str(source["scoring_mode"]),
                    "advance_count": int(str(stage["advance_count"])),
                    "roster_source": "approved" if stage_index == 1 else "stage",
                    "roster_source_stage": "" if stage_index == 1 else str(stage["key"]),
                    "stage_index": stage_index,
                }
            )
    round_configurations = tuple(round_configurations_list)
    change_summary = tuple(
        f"{stage['name']}按 {stage['judge_weight']} / {stage['audience_weight']} 合成，晋级 {stage['advance_count']} 人"
        for stage in business_stages
    )
    return PlanningCompileResult(
        issues=tuple(issues),
        candidate_definition=candidate_definition,
        business_stages=tuple(business_stages),
        round_configurations=round_configurations,
        change_summary=change_summary,
    )


def _historical_stage_payload(
    stage: Mapping[str, object], index: int
) -> dict[str, object]:
    business_id = str(stage.get("key") or f"stage{index}")
    round_sources = _mapping_list(stage.get("judge_sources"))
    def percentage_value(value: object) -> str:
        try:
            return _decimal_text(Decimal(str(value)) * Decimal("100"))
        except (InvalidOperation, ValueError):
            return ""

    return {
        "business_id": business_id,
        "name": planning_field(
            str(stage.get("name") or f"第 {index} 阶段"),
            PlanningResolution.CONFIRMED,
            "历史规则定义",
            "text",
        ),
        "advance_count": planning_field(
            stage.get("advance_count"),
            PlanningResolution.CONFIRMED,
            "历史规则定义",
            "person",
        ),
        "result_method": planning_field(
            "top_n", PlanningResolution.CONFIRMED, "历史规则定义", "text"
        ),
        "judge_sources": [
            {
                "business_id": f"{business_id}-{round_index}",
                "round_key": f"{business_id}-{round_index}",
                "name": planning_field(
                    str(
                        round_source.get("round_name")
                        or round_source.get("round_key")
                        or f"第 {round_index} 轮"
                    ),
                    PlanningResolution.CONFIRMED,
                    "历史规则定义",
                    "text",
                ),
                "format": "solo",
                "weight": planning_field(
                    percentage_value(round_source.get("weight", "")),
                    PlanningResolution.CONFIRMED,
                    "历史规则定义",
                    "percent",
                ),
            }
            for round_index, round_source in enumerate(round_sources, start=1)
        ],
        "judge_weight": planning_field(
            percentage_value(stage.get("judge_weight", "0")),
            PlanningResolution.CONFIRMED,
            "历史规则定义",
            "percent",
        ),
        "previous_weight": planning_field(
            percentage_value(stage.get("previous_weight", "0")),
            PlanningResolution.CONFIRMED,
            "历史规则定义",
            "percent",
        ),
        "audience_weight": planning_field(
            percentage_value(stage.get("audience_weight", "0")),
            PlanningResolution.CONFIRMED,
            "历史规则定义",
            "percent",
        ),
        "audience_source": planning_field(
            str(stage.get("vote_source") or stage.get("audience_source") or ""),
            PlanningResolution.CONFIRMED,
            "历史规则定义",
            "vote",
        ),
        "execution_rounds": [
            {
                "business_id": f"{business_id}-round-{round_index}",
                "name": planning_field(
                    str(
                        round_source.get("round_name")
                        or round_source.get("round_key")
                        or "演唱轮次"
                    ),
                    PlanningResolution.CONFIRMED,
                    "历史规则定义",
                    "text",
                ),
            }
            for round_index, round_source in enumerate(round_sources, start=1)
        ],
    }


def planning_projection_from_definition(definition: object) -> PlanningProjection:
    """Create an editable projection only for the lossless linear rules subset."""
    from ruleset.business_editor import infer_business_stages
    from ruleset.editor import human_ruleset_summary
    from ruleset.schema import parse_definition

    try:
        inferred = infer_business_stages(definition)
        if inferred.get("supported") and inferred.get("editable"):
            stages = tuple(
                deepcopy(stage) for stage in _mapping_list(inferred.get("stages"))
            )
            payload_stages = tuple(
                _historical_stage_payload(stage, index)
                for index, stage in enumerate(stages, start=1)
            )
            execution_refs = {
                str(stage["business_id"]): {
                    "stage_key": str(source.get("key") or ""),
                    "round_keys": [
                        str(round_source.get("round_key") or "")
                        for round_source in _mapping_list(source.get("judge_sources"))
                    ],
                }
                for stage, source in zip(payload_stages, stages, strict=True)
            }
            return PlanningProjection(
                stages=stages,
                payload={
                    "schema_version": 1,
                    "stages": list(payload_stages),
                    "execution_refs": execution_refs,
                },
                source="historical_projection",
                editable=True,
                read_only=False,
            )

        if not isinstance(definition, (dict, str)):
            raise TypeError("规则定义必须是 JSON 对象或 JSON 文字。")
        parsed = parse_definition(definition)
        summary = human_ruleset_summary(definition)
        node_types = [
            str(node.get("type") or "")
            for node in parsed.get("nodes", [])
            if isinstance(node, Mapping)
        ]
        notice = str(summary.get("notice") or "当前规则包含复杂结构，不能在普通工作台中无损修改。")
        if "MANUAL_SELECT" in node_types:
            notice += " 当前规则包含人工决定，需要负责人确认。"
        return PlanningProjection(
            stages=tuple(deepcopy(stage) for stage in _mapping_list(summary.get("stages"))),
            payload={"schema_version": 1, "stages": [], "execution_refs": {}},
            source="historical_read_only",
            editable=False,
            read_only=True,
            notice=notice,
            summary={
                "human": summary,
                "node_types": node_types,
                "checkpoints": parsed.get("checkpoints", []),
            },
        )
    except (TypeError, ValueError, ValidationError, json.JSONDecodeError) as exc:
        return PlanningProjection(
            stages=(),
            payload={"schema_version": 1, "stages": [], "execution_refs": {}},
            source="historical_read_only",
            editable=False,
            read_only=True,
            notice=f"当前规则定义无法读取，请使用专业工具：{exc}",
        )

