"""Business-facing ruleset planning schema and validation primitives."""

from __future__ import annotations

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
        for field_name, field_value in stage.items():
            issues.extend(
                _validate_field_object(
                    field_value,
                    stage_id=stage_id,
                    field_path=f"stages[{index}].{field_name}",
                )
            )
    return tuple(issues)

