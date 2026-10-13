"""Business-facing ruleset planning schema and validation primitives."""

from __future__ import annotations

import json
from copy import deepcopy
from dataclasses import dataclass
from decimal import Decimal, InvalidOperation
from enum import StrEnum
from typing import Mapping

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
    binding_ready: bool = True
    freeze_ready: bool | None = None

    @property
    def business_complete(self) -> bool:
        return self.candidate_definition is not None and not any(
            issue.blocks_apply and issue.severity is not PlanningSeverity.EXECUTION_RISK
            for issue in self.issues
        )

    @property
    def can_apply(self) -> bool:
        """Whether the pure business candidate is complete.

        Database-aware callers should use :attr:`safe_to_apply`, which also includes
        the activity binding preflight.
        """
        return self.business_complete

    @property
    def safe_to_apply(self) -> bool:
        return self.business_complete and self.binding_ready


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


def _validate_nested_field_objects(
    value: object,
    *,
    stage_id: str,
    field_path: str,
) -> tuple[PlanningIssue, ...]:
    if isinstance(value, Mapping):
        if "resolution" in value or "unit" in value:
            return _validate_field_object(
                value,
                stage_id=stage_id,
                field_path=field_path,
            )
        issues: list[PlanningIssue] = []
        for key, child in value.items():
            issues.extend(
                _validate_nested_field_objects(
                    child,
                    stage_id=stage_id,
                    field_path=f"{field_path}.{key}",
                )
            )
        return tuple(issues)
    if isinstance(value, list):
        issues = []
        for index, child in enumerate(value):
            issues.extend(
                _validate_nested_field_objects(
                    child,
                    stage_id=stage_id,
                    field_path=f"{field_path}[{index}]",
                )
            )
        return tuple(issues)
    return ()


def _confirmed_field_value(value: object) -> tuple[bool, object]:
    if isinstance(value, Mapping) and "resolution" in value:
        return (
            value.get("resolution") == PlanningResolution.CONFIRMED.value
            and value.get("value") not in (None, ""),
            value.get("value"),
        )
    return value not in (None, ""), value


def _required_field_issue(
    *,
    value: object,
    stage_id: str,
    field_path: str,
    code: str,
    message: str,
) -> PlanningIssue | None:
    confirmed, _raw_value = _confirmed_field_value(value)
    if confirmed:
        return None
    return PlanningIssue(
        code=code,
        severity=PlanningSeverity.MISSING_INFORMATION,
        stage_id=stage_id,
        field_path=field_path,
        message=message,
        blocks_apply=True,
    )


def _rubric_missing_issue(value: object, *, stage_id: str, field_path: str) -> PlanningIssue | None:
    if not isinstance(value, Mapping):
        return PlanningIssue(
            code="MISSING_RUBRIC",
            severity=PlanningSeverity.MISSING_INFORMATION,
            stage_id=stage_id,
            field_path=field_path,
            message="这个轮次的评分维度和每项满分尚待确定。",
            blocks_apply=True,
        )
    if (
        _required_field_issue(
            value=value.get("name"),
            stage_id=stage_id,
            field_path=f"{field_path}.name",
            code="MISSING_RUBRIC",
            message="这个轮次的评分表名称尚待确定。",
        )
        is not None
    ):
        return PlanningIssue(
            code="MISSING_RUBRIC",
            severity=PlanningSeverity.MISSING_INFORMATION,
            stage_id=stage_id,
            field_path=field_path,
            message="这个轮次的评分维度和每项满分尚待确定。",
            blocks_apply=True,
        )
    criteria = value.get("criteria")
    if not isinstance(criteria, list) or not criteria:
        return PlanningIssue(
            code="MISSING_RUBRIC",
            severity=PlanningSeverity.MISSING_INFORMATION,
            stage_id=stage_id,
            field_path=f"{field_path}.criteria",
            message="这个轮次至少需要一项评分维度和对应满分。",
            blocks_apply=True,
        )
    for index, criterion in enumerate(criteria):
        if not isinstance(criterion, Mapping):
            return PlanningIssue(
                code="MISSING_RUBRIC",
                severity=PlanningSeverity.MISSING_INFORMATION,
                stage_id=stage_id,
                field_path=f"{field_path}.criteria[{index}]",
                message="这个轮次的评分维度和每项满分尚待确定。",
                blocks_apply=True,
            )
        for field_name, message in (
            ("name", "评分维度名称"),
            ("max_score", "评分维度满分"),
        ):
            if (
                _required_field_issue(
                    value=criterion.get(field_name),
                    stage_id=stage_id,
                    field_path=f"{field_path}.criteria[{index}].{field_name}",
                    code="MISSING_RUBRIC",
                    message=f"这个轮次的{message}尚待确定。",
                )
                is not None
            ):
                return PlanningIssue(
                    code="MISSING_RUBRIC",
                    severity=PlanningSeverity.MISSING_INFORMATION,
                    stage_id=stage_id,
                    field_path=f"{field_path}.criteria[{index}]",
                    message="这个轮次的评分维度和每项满分尚待确定。",
                    blocks_apply=True,
                )
    return None


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
        required_issues: list[PlanningIssue] = []
        participants = stage.get("participants")
        if (
            isinstance(participants, Mapping)
            and (
                issue := _required_field_issue(
                    value=participants.get("count"),
                    stage_id=stage_id,
                    field_path=f"stages[{index}].participants.count",
                    code="MISSING_PARTICIPANT_COUNT",
                    message="这个阶段的参赛人数尚待确定。",
                )
            )
            is not None
        ):
            required_issues.append(issue)
        raw_sources_for_shape = stage.get("judge_sources")
        collaboration_round = isinstance(raw_sources_for_shape, list) and any(
            isinstance(source, Mapping)
            and (
                source.get("format", {}).get("value")
                if isinstance(source.get("format"), Mapping)
                else source.get("format")
            )
            == "collaboration"
            for source in raw_sources_for_shape
        )
        if collaboration_round:
            participant_mapping = participants if isinstance(participants, Mapping) else {}
            if (
                issue := _required_field_issue(
                    value=participant_mapping.get("count"),
                    stage_id=stage_id,
                    field_path=f"stages[{index}].participants.count",
                    code="MISSING_PARTICIPANT_COUNT",
                    message="这个阶段的参赛人数尚待确定。",
                )
            ) is not None:
                required_issues.append(issue)
            for field_name, code, message in (
                ("group_count", "MISSING_GROUP_COUNT", "这个阶段的演唱组数尚待确定。"),
                ("group_size", "MISSING_GROUP_SIZE", "每个演唱组的人数尚待确定。"),
            ):
                if (
                    issue := _required_field_issue(
                        value=participant_mapping.get(field_name),
                        stage_id=stage_id,
                        field_path=f"stages[{index}].participants.{field_name}",
                        code=code,
                        message=message,
                    )
                ) is not None:
                    required_issues.append(issue)
        raw_audience_weight_for_requirements = stage.get("audience_weight")
        if isinstance(raw_audience_weight_for_requirements, Mapping):
            raw_audience_weight_for_requirements = raw_audience_weight_for_requirements.get("value")
        audience_weight_is_nonzero = False
        if raw_audience_weight_for_requirements not in (None, ""):
            try:
                audience_weight_is_nonzero = (
                    parse_percentage(raw_audience_weight_for_requirements).percent > 0
                )
            except ValidationError:
                pass
        if audience_weight_is_nonzero:
            if (
                issue := _required_field_issue(
                    value=stage.get("audience_source"),
                    stage_id=stage_id,
                    field_path=f"stages[{index}].audience_source",
                    code="MISSING_AUDIENCE_SOURCE",
                    message="观众成绩来源尚待确定。",
                )
            ) is not None:
                required_issues.append(issue)
            if (
                issue := _required_field_issue(
                    value=stage.get("audience_conversion"),
                    stage_id=stage_id,
                    field_path=f"stages[{index}].audience_conversion",
                    code="MISSING_AUDIENCE_CONVERSION",
                    message="观众投票到成绩的换算方式尚待确定。",
                )
            ) is not None:
                required_issues.append(issue)
            else:
                raw_conversion = stage.get("audience_conversion")
                if isinstance(raw_conversion, Mapping):
                    raw_conversion = raw_conversion.get("value")
                if raw_conversion not in {"ballot_share_percent", "audience_score_hundred"}:
                    required_issues.append(
                        PlanningIssue(
                            code="INVALID_AUDIENCE_CONVERSION",
                            severity=PlanningSeverity.EXECUTION_RISK,
                            stage_id=stage_id,
                            field_path=f"stages[{index}].audience_conversion",
                            message="观众成绩换算方式不受支持，请选择投票支持率或百分制观众分。",
                            blocks_apply=True,
                        )
                    )
        for field_name, code, message in (
            ("result_method", "MISSING_RESULT_METHOD", "这个阶段的晋级方式尚待确定。"),
            ("previous_weight", "MISSING_PREVIOUS_WEIGHT", "这个阶段的上一阶段成绩比例尚待确定。"),
            ("audience_weight", "MISSING_AUDIENCE_WEIGHT", "这个阶段是否计入观众成绩尚待确定。"),
        ):
            if (
                issue := _required_field_issue(
                    value=stage.get(field_name),
                    stage_id=stage_id,
                    field_path=f"stages[{index}].{field_name}",
                    code=code,
                    message=message,
                )
            ) is not None:
                required_issues.append(issue)
        raw_sources = stage.get("judge_sources")
        if isinstance(raw_sources, list):
            for source_index, raw_source in enumerate(raw_sources):
                if not isinstance(raw_source, Mapping):
                    continue
                raw_format = raw_source.get("format")
                if isinstance(raw_format, Mapping):
                    raw_format = raw_format.get("value")
                if (
                    issue := _required_field_issue(
                        value=raw_format,
                        stage_id=stage_id,
                        field_path=f"stages[{index}].judge_sources[{source_index}].format",
                        code="MISSING_ROUND_FORMAT",
                        message="这个轮次的演唱形式尚待确定。",
                    )
                ) is not None:
                    required_issues.append(issue)
                if (
                    issue := _required_field_issue(
                        value=raw_source.get("scoring_mode"),
                        stage_id=stage_id,
                        field_path=f"stages[{index}].judge_sources[{source_index}].scoring_mode",
                        code="MISSING_SCORING_MODE",
                        message="这个轮次的评分方式尚待确定。",
                    )
                ) is not None:
                    required_issues.append(issue)
                if (
                    issue := _required_field_issue(
                        value=raw_source.get("judge_count"),
                        stage_id=stage_id,
                        field_path=f"stages[{index}].judge_sources[{source_index}].judge_count",
                        code="MISSING_JUDGE_COUNT",
                        message="这个轮次的评委数量尚待确定。",
                    )
                ) is not None:
                    required_issues.append(issue)
                rubric_issue = _rubric_missing_issue(
                    raw_source.get("rubric"),
                    stage_id=stage_id,
                    field_path=f"stages[{index}].judge_sources[{source_index}].rubric",
                )
                if rubric_issue is not None:
                    required_issues.append(rubric_issue)
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
                _validate_nested_field_objects(
                    field_value,
                    stage_id=stage_id,
                    field_path=f"stages[{index}].{field_name}",
                )
            )
        issues.extend(required_issues)
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


def _optional_stage_count(value: object, *, label: str) -> int | None:
    if value is None or value == "":
        return None
    if isinstance(value, Mapping) and value.get("value") in (None, ""):
        return None
    return _stage_count(value, label=label)


def _rubric_definition(value: object, *, label: str) -> dict[str, object] | None:
    if value is None:
        return None
    raw = _as_mapping(value, message=f"{label}必须是对象。")
    name = _stage_text(raw.get("name"), label=f"{label}名称")
    description = ""
    if raw.get("description") is not None:
        description = _stage_text(raw.get("description"), label=f"{label}说明")
    raw_criteria = raw.get("criteria")
    if not isinstance(raw_criteria, list) or not raw_criteria:
        raise ValidationError(f"{label}至少需要一个评分项。")
    criteria: list[dict[str, object]] = []
    total = Decimal("0")
    for index, raw_criterion in enumerate(raw_criteria, start=1):
        criterion = _as_mapping(raw_criterion, message=f"{label}第 {index} 个评分项必须是对象。")
        criterion_name = _stage_text(criterion.get("name"), label=f"{label}第 {index} 个评分项名称")
        raw_max_score = _planning_value(
            criterion.get("max_score"), label=f"{label}第 {index} 个评分项满分"
        )
        try:
            max_score = Decimal(str(raw_max_score))
        except (InvalidOperation, TypeError, ValueError) as exc:
            raise ValidationError(f"{label}第 {index} 个评分项满分无效。") from exc
        if not max_score.is_finite() or max_score <= 0:
            raise ValidationError(f"{label}第 {index} 个评分项满分必须大于 0。")
        criterion_description = ""
        if criterion.get("description") is not None:
            criterion_description = _stage_text(
                criterion.get("description"), label=f"{label}第 {index} 个评分项说明"
            )
        criteria.append(
            {
                "name": criterion_name,
                "max_score": format(max_score.normalize(), "f"),
                "description": criterion_description,
            }
        )
        total += max_score
    if total != Decimal("100"):
        raise ValidationError(f"{label}评分项满分合计必须为 100 分，当前为 {total:g} 分。")
    return {"name": name, "description": description, "criteria": criteria}


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
            raw_stage.get("name"),
            label=f"第 {stage_index} 阶段名称",
            default=f"第{stage_index}阶段",
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
            round_format = _stage_text(
                raw_source.get("format"),
                label=f"阶段“{stage_name}”的第 {round_index} 个演唱形式",
            )
            if round_format not in {"solo", "collaboration"}:
                raise ValidationError(f"阶段“{stage_name}”的演唱形式无效。")
            round_key = _stage_text(
                raw_source.get("round_key"),
                label=f"阶段“{stage_name}”的第 {round_index} 个轮次标识",
                default=round_id,
            )
            weight = _percentage_coefficient(
                raw_source.get("weight"),
                label=f"阶段“{stage_name}”的第 {round_index} 个成绩比例",
            )
            scoring_mode = _stage_text(
                raw_source.get("scoring_mode"),
                label=f"阶段“{stage_name}”的第 {round_index} 个评分方式",
            )
            if scoring_mode not in {"average", "drop_high_low"}:
                raise ValidationError(f"阶段“{stage_name}”的评分方式无效。")
            judge_count = _optional_stage_count(
                raw_source.get("judge_count"),
                label=f"阶段“{stage_name}”的第 {round_index} 个评委数量",
            )
            minimum_judge_count = _optional_stage_count(
                raw_source.get("minimum_judge_count"),
                label=f"阶段“{stage_name}”的第 {round_index} 个最低有效评委数",
            )
            if (
                judge_count is not None
                and minimum_judge_count is not None
                and minimum_judge_count > judge_count
            ):
                raise ValidationError(f"阶段“{stage_name}”的最低有效评委数不能超过评委数量。")
            rubric = _rubric_definition(
                raw_source.get("rubric"),
                label=f"阶段“{stage_name}”的第 {round_index} 个评分标准",
            )
            source_configuration: dict[str, object] = {
                "round_key": round_key,
                "round_name": _stage_text(
                    raw_source.get("name"), label="演唱轮次名称", default=f"第{round_index}轮"
                ),
                "weight": _decimal_text(weight),
                "scoring_mode": scoring_mode,
                "judge_count": judge_count,
                "minimum_judge_count": minimum_judge_count,
                "rubric": rubric,
                "format": round_format,
                "source": _stage_text(
                    raw_source.get("source"),
                    label=f"阶段“{stage_name}”的第 {round_index} 个成绩来源",
                    default=previous_stage_key,
                ),
                "source_stage_key": _stage_text(
                    raw_source.get("source_stage_key"),
                    label=f"阶段“{stage_name}”的第 {round_index} 个名单来源",
                    default=previous_stage_key,
                ),
                "business_id": round_id,
                "create_round": True,
            }
            for optional_field in ("judge_count", "minimum_judge_count", "rubric"):
                if optional_field not in raw_source:
                    source_configuration.pop(optional_field, None)
            judge_sources.append(source_configuration)

        judge_weight = sum(
            (Decimal(str(source["weight"])) for source in judge_sources), Decimal("0")
        )
        previous_weight = _percentage_coefficient(
            raw_stage.get("previous_weight"),
            label=f"阶段“{stage_name}”的上一阶段成绩比例",
        )
        audience_weight = _percentage_coefficient(
            raw_stage.get("audience_weight"),
            label=f"阶段“{stage_name}”的观众成绩比例",
        )
        raw_audience_conversion = raw_stage.get("audience_conversion")
        audience_conversion = ""
        if audience_weight:
            audience_conversion = _stage_text(
                raw_audience_conversion,
                label=f"阶段“{stage_name}”的观众成绩换算方式",
            )
            if audience_conversion not in {"ballot_share_percent", "audience_score_hundred"}:
                raise ValidationError(f"阶段“{stage_name}”的观众成绩换算方式无效。")
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
                "scoring_mode": str(judge_sources[0]["scoring_mode"]),
                "advance_count": advance_count,
                "judge_weight": _decimal_text(judge_weight),
                "previous_weight": _decimal_text(previous_weight),
                "audience_weight": _decimal_text(audience_weight),
                "vote_source": audience_source,
                "audience_conversion": audience_conversion,
                "audience_source": previous_stage_key if audience_weight else "",
                "audience_source_stage_key": previous_stage_key if audience_weight else "",
            }
        )
        raw_participants = raw_stage.get("participants")
        if isinstance(raw_participants, Mapping) and "count" in raw_participants:
            participants = {
                "source": str(raw_participants.get("source") or ""),
                "count": _stage_count(
                    raw_participants.get("count"), label=f"阶段“{stage_name}”的参赛人数"
                ),
            }
            for field_name, label in (("group_count", "演唱组数"), ("group_size", "每组人数")):
                if field_name in raw_participants:
                    participants[field_name] = _stage_count(
                        raw_participants.get(field_name), label=f"阶段“{stage_name}”的{label}"
                    )
            stages[-1]["participants"] = participants
        if raw_stage.get("collaboration_group") is not None:
            stages[-1]["collaboration_group"] = _stage_text(
                raw_stage.get("collaboration_group"), label=f"阶段“{stage_name}”的分组演唱说明"
            )
        previous_stage_key = stage_key
    return stages


def _planning_issue_for_conversion(error: ValidationError) -> PlanningIssue:
    message = str(error)
    if "结果方式" in message:
        code = "UNSUPPORTED_RESULT_METHOD"
        severity = PlanningSeverity.EXECUTION_RISK
    elif "观众成绩换算方式" in message:
        code = "INVALID_AUDIENCE_CONVERSION"
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
    round_configurations_by_key: dict[str, dict[str, object]] = {}
    for stage_index, stage in enumerate(business_stages, start=1):
        raw_sources = stage.get("judge_sources")
        if not isinstance(raw_sources, list):
            continue
        for source in raw_sources:
            if not isinstance(source, Mapping):
                continue
            round_key = str(source["round_key"])
            configuration = round_configurations_by_key.get(round_key)
            if configuration is None:
                configuration = {
                    "business_id": str(source["business_id"]),
                    "business_ids": [],
                    "round_key": round_key,
                    "name": str(source["round_name"]),
                    "scoring_mode": str(source["scoring_mode"]),
                    "format": str(source.get("format") or "solo"),
                    "advance_count": int(str(stage["advance_count"])),
                    "roster_source": "approved"
                    if str(source.get("source_stage_key")) == "entry"
                    else "stage",
                    "roster_source_stage": ""
                    if str(source.get("source_stage_key")) == "entry"
                    else str(source.get("source_stage_key") or stage["key"]),
                    "stage_index": stage_index,
                }
                for field in ("judge_count", "minimum_judge_count", "rubric"):
                    if field in source:
                        configuration[field] = deepcopy(source[field])
                round_configurations_by_key[round_key] = configuration
            else:
                source_roster_stage = str(
                    source.get("source_stage_key") or stage["key"]
                )
                source_execution_facts = {
                    **source,
                    "roster_source": (
                        "approved" if source_roster_stage == "entry" else "stage"
                    ),
                    "roster_source_stage": (
                        "" if source_roster_stage == "entry" else source_roster_stage
                    ),
                }
                for field in (
                    "format",
                    "judge_count",
                    "minimum_judge_count",
                    "scoring_mode",
                    "rubric",
                    "roster_source",
                    "roster_source_stage",
                ):
                    expected = configuration.get(field)
                    actual = source_execution_facts.get(field)
                    if field == "minimum_judge_count" and expected is None and actual is None:
                        continue
                    if expected == actual:
                        continue
                    issues.append(
                        PlanningIssue(
                            code="INCONSISTENT_SHARED_ROUND_CONFIGURATION",
                            severity=PlanningSeverity.BUSINESS_CONFLICT,
                            round_id=round_key,
                            field_path=f"rounds.{round_key}.{field}",
                            message=(
                                f"共享轮次“{round_key}”在不同阶段的{field}配置不一致，"
                                "不能静默采用首次配置。"
                            ),
                            blocks_apply=True,
                        )
                    )
            business_ids = configuration["business_ids"]
            assert isinstance(business_ids, list)
            business_ids.append(str(source["business_id"]))
    round_configurations = tuple(round_configurations_by_key.values())
    change_summary = tuple(
        (
            f"{stage['name']}按 {stage['judge_weight']} / "
            f"{stage['audience_weight']} 合成，晋级 {stage['advance_count']} 人"
        )
        for stage in business_stages
    )
    return PlanningCompileResult(
        issues=tuple(issues),
        candidate_definition=candidate_definition,
        business_stages=tuple(business_stages),
        round_configurations=round_configurations,
        change_summary=change_summary,
    )


def _historical_stage_payload(stage: Mapping[str, object], index: int) -> dict[str, object]:
    business_id = str(stage.get("key") or f"stage{index}")
    round_sources = _mapping_list(stage.get("judge_sources"))

    def percentage_value(value: object) -> str:
        try:
            return _decimal_text(Decimal(str(value)) * Decimal("100"))
        except (InvalidOperation, ValueError):
            return ""

    def round_payload(round_index: int, round_source: Mapping[str, object]) -> dict[str, object]:
        result: dict[str, object] = {
            "business_id": str(
                round_source.get("round_key")
                or round_source.get("business_id")
                or f"{business_id}-round-{round_index}"
            ),
            "round_key": str(
                round_source.get("round_key")
                or round_source.get("business_id")
                or f"{business_id}-round-{round_index}"
            ),
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
            "format": str(round_source.get("format") or "solo"),
            "scoring_mode": planning_field(
                str(round_source.get("scoring_mode") or "average"),
                PlanningResolution.CONFIRMED,
                "历史规则定义",
                "text",
            ),
            "source": str(round_source.get("source") or "entry"),
            "source_stage_key": str(round_source.get("source_stage_key") or "entry"),
            "weight": planning_field(
                percentage_value(round_source.get("weight", "")),
                PlanningResolution.CONFIRMED,
                "历史规则定义",
                "percent",
            ),
        }
        for field in ("judge_count", "minimum_judge_count", "rubric"):
            if field in round_source:
                result[field] = deepcopy(round_source[field])
        return result

    payload: dict[str, object] = {
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
            round_payload(round_index, round_source)
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
                "business_id": str(
                    round_source.get("round_key")
                    or round_source.get("business_id")
                    or f"{business_id}-round-{round_index}"
                ),
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
    try:
        audience_weight = Decimal(str(stage.get("audience_weight") or "0"))
    except (InvalidOperation, ValueError):
        audience_weight = Decimal("0")
    if audience_weight:
        payload["audience_conversion"] = planning_field(
            str(stage.get("audience_conversion") or ""),
            PlanningResolution.CONFIRMED
            if stage.get("audience_conversion")
            else PlanningResolution.PENDING,
            "历史规则定义" if stage.get("audience_conversion") else "需要确认投票换算规则",
            "text",
        )
    for field in ("participants", "collaboration_group"):
        if field in stage:
            payload[field] = deepcopy(stage[field])
    return payload


def planning_projection_from_definition(definition: object) -> PlanningProjection:
    """Create an editable projection only for the lossless linear rules subset."""
    from ruleset.business_editor import infer_business_stages
    from ruleset.editor import human_ruleset_summary
    from ruleset.schema import parse_definition

    try:
        inferred = infer_business_stages(definition)
        if inferred.get("supported") and inferred.get("editable"):
            stages = tuple(deepcopy(stage) for stage in _mapping_list(inferred.get("stages")))
            payload_stages = tuple(
                _historical_stage_payload(stage, index)
                for index, stage in enumerate(stages, start=1)
            )
            round_refs: dict[str, dict[str, object]] = {}
            stage_refs: dict[str, dict[str, object]] = {}
            for stage, source in zip(payload_stages, stages, strict=True):
                round_keys = [
                    str(round_source.get("round_key") or "")
                    for round_source in _mapping_list(source.get("judge_sources"))
                ]
                stage_refs[str(stage["business_id"])] = {
                    "stage_key": str(source.get("key") or ""),
                    "round_keys": round_keys,
                }
                for round_key in round_keys:
                    if round_key:
                        round_refs[round_key] = {
                            "round_key": round_key,
                        }
            execution_refs = {
                "rounds": round_refs,
                "stages": stage_refs,
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
