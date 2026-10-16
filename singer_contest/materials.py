"""Business-language projections for the 2026 live competition materials.

The projection deliberately reads the existing questionnaire responses, material checks,
submission files, and group-chorus aggregates.  It owns no upload state and cannot be used
to bypass the file or supplement authorities.
"""

from __future__ import annotations

from dataclasses import dataclass

from django.core.exceptions import ValidationError
from files.models import MaterialCheck
from ruleset.models import RulesetVersion
from ruleset.services import current_frozen_version

from .group_chorus import group_material_readiness
from .models import GroupStage, SingerRegistration

LIVE_PERSONAL_ROUNDS = ("r2", "r3")

#: What those rounds are called where a round has to be *named* rather than described — the
#: questionnaire designer's round picker. The material pages title the same rounds by what
#: arrives there ("第二轮个人材料"), which is a sentence about the page, not a name for the
#: round; the picker needs the latter.
LIVE_PERSONAL_ROUND_NAMES = {"r2": "踢馆轮", "r3": "第三轮"}


@dataclass(frozen=True)
class LiveMaterialContract:
    """The frozen questionnaire questions that make up one personal-round contract."""

    round_key: str
    question_keys: tuple[str, ...]
    labels: tuple[str, ...]


def _questionnaire_plan(version):
    from questionnaire.registration import questionnaire_plan

    try:
        return questionnaire_plan(version)
    except ValidationError:
        return None


def personal_material_contracts(version) -> tuple[LiveMaterialContract, ...]:
    """Return required personal material questions for rounds two and three."""
    plan = _questionnaire_plan(version)
    if plan is None or plan.subject != "participant":
        return ()
    contracts = []
    for round_key in LIVE_PERSONAL_ROUNDS:
        questions = tuple(
            question for question in plan.questions_for_round(round_key) if question.get("required")
        )
        contracts.append(
            LiveMaterialContract(
                round_key=round_key,
                question_keys=tuple(str(question["key"]) for question in questions),
                labels=tuple(str(question["label"]) for question in questions),
            )
        )
    return tuple(contracts)


def validate_live_material_contract(version) -> tuple[LiveMaterialContract, ...]:
    """Fail closed unless the frozen participant questionnaire asks for R2/R3 materials."""
    return validate_live_material_plan(_questionnaire_plan(version))


def validate_live_material_plan(plan) -> tuple[LiveMaterialContract, ...]:
    """Validate an already compiled participant questionnaire plan."""
    if plan is None or plan.subject != "participant":
        raise ValidationError("2026 赛制必须使用选手问卷收集第二、第三轮个人材料。")
    contracts = tuple(
        LiveMaterialContract(
            round_key=round_key,
            question_keys=tuple(
                str(question["key"])
                for question in plan.questions_for_round(round_key)
                if question.get("required")
            ),
            labels=tuple(
                str(question["label"])
                for question in plan.questions_for_round(round_key)
                if question.get("required")
            ),
        )
        for round_key in LIVE_PERSONAL_ROUNDS
    )
    for contract in contracts:
        if not contract.question_keys:
            raise ValidationError(f"{contract.round_key} 必须至少有一项必填个人材料。")
        required_song_key = f"{contract.round_key}.song"
        if required_song_key not in contract.question_keys:
            raise ValidationError(f"{contract.round_key} 必须有必填歌曲材料。")
        required_accompaniment_key = f"{contract.round_key}.accompaniment"
        if required_accompaniment_key not in contract.question_keys:
            raise ValidationError(f"{contract.round_key} 必须有必填伴奏材料。")
    return contracts


def _check_payload(check: MaterialCheck | None, *, item_name: str) -> dict:
    if check is None:
        return {
            "status": MaterialCheck.Status.MISSING,
            "status_label": "未提交",
            "item_name": item_name,
        }
    return {
        "status": check.status,
        "status_label": check.get_status_display(),
        "item_name": check.item_name or item_name,
    }


def _participant_round_progress(
    registrations: list[SingerRegistration], contract: LiveMaterialContract
) -> dict:
    checks = MaterialCheck.objects.filter(
        singer_registration__in=registrations,
        question_key__in=contract.question_keys,
    )
    by_owner = {(check.singer_registration_id, check.question_key): check for check in checks}
    rows = []
    for registration in registrations:
        items = [
            _check_payload(
                by_owner.get((registration.pk, question_key)),
                item_name=label,
            )
            for question_key, label in zip(contract.question_keys, contract.labels, strict=True)
        ]
        missing = [
            item["item_name"]
            for item in items
            if item["status"] != MaterialCheck.Status.APPROVED and item.get("item_name")
        ]
        rows.append(
            {
                "registration_id": registration.pk,
                "official_number": registration.official_number,
                "name": registration.name,
                "ready": not missing and bool(items),
                "missing": missing,
                "items": items,
            }
        )
    return {
        "round_key": contract.round_key,
        "title": "第二轮个人材料" if contract.round_key == "r2" else "第三轮个人材料",
        "question_keys": list(contract.question_keys),
        "participants": rows,
        "ready_count": sum(1 for row in rows if row["ready"]),
        "total_count": len(rows),
    }


def live_material_summary(activity, *, version: RulesetVersion | None = None) -> dict:
    """Build the staff-facing R1 group / R2 personal / R3 personal progress view."""
    version = version or current_frozen_version(activity)
    contracts = (
        personal_material_contracts(version)
        if version is not None
        else tuple(LiveMaterialContract(round_key, (), ()) for round_key in LIVE_PERSONAL_ROUNDS)
    )
    if len(contracts) != len(LIVE_PERSONAL_ROUNDS):
        contracts = tuple(
            LiveMaterialContract(round_key, (), ()) for round_key in LIVE_PERSONAL_ROUNDS
        )
    registrations = list(
        SingerRegistration.objects.filter(
            activity=activity,
            pre_status=SingerRegistration.PreStatus.APPROVED,
        ).order_by("official_number", "pk")
    )
    stages = list(
        GroupStage.objects.filter(activity=activity)
        .prefetch_related("groups__material_checks")
        .order_by("stage_key", "pk")
    )
    group_rows = []
    for stage in stages:
        for group in stage.groups.filter(is_active=True).order_by("group_order", "pk"):
            readiness = group_material_readiness(group)
            group_rows.append(
                {
                    "stage_id": stage.pk,
                    "stage_name": stage.name,
                    "group_id": group.pk,
                    "group_name": group.name,
                    "status": readiness.value,
                    "status_label": {
                        "ready": "已准备",
                        "missing_material": "材料未齐",
                        "missing_member": "缺少组员",
                        "waiting_for_confirmation": "等待确认",
                    }.get(readiness.value, readiness.value),
                }
            )
    return {
        "activity_id": activity.pk,
        "ruleset_version_id": version.pk if version is not None else None,
        "first_round": {
            "title": "第一轮小组材料",
            "groups": group_rows,
            "ready_count": sum(row["status"] == "ready" for row in group_rows),
            "total_count": len(group_rows),
        },
        "personal_rounds": {
            contract.round_key: _participant_round_progress(registrations, contract)
            for contract in contracts
        },
    }
