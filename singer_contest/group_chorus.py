"""Audited authority services for the conditional Group Chorus stage."""

from __future__ import annotations

import json
from collections.abc import Iterable
from enum import StrEnum
from typing import Any

from accounts.services import require_current_staff
from common.authority import GROUP_STAGE_STATE, authority_write
from common.models import AuditLog
from core.models import Activity
from core.policies import ActivityAction
from core.services import lock_activity_for_action
from django.core.exceptions import PermissionDenied, ValidationError
from django.db import transaction
from django.utils import timezone

from .models import Group, GroupMembership, GroupStage, SingerRegistration


def _operator(operator):
    return require_current_staff(operator)


def _stage_for_update(stage: GroupStage) -> GroupStage:
    return GroupStage.objects.select_for_update().select_related("activity").get(pk=stage.pk)


def _approved_singers(activity) -> dict[str, SingerRegistration]:
    return {
        str(singer.pk): singer
        for singer in SingerRegistration.objects.filter(
            activity=activity, pre_status=SingerRegistration.PreStatus.APPROVED
        ).order_by("pk")
    }


def _normalize_specs(stage: GroupStage, specs: Iterable[dict[str, Any]], *, complete: bool):
    if not isinstance(specs, list):
        raise ValidationError("分组合唱分组必须是列表。")
    approved = _approved_singers(stage.activity)
    seen: set[str] = set()
    normalized: list[tuple[str, list[SingerRegistration]]] = []
    names: set[str] = set()
    for index, raw in enumerate(specs, start=1):
        if not isinstance(raw, dict):
            raise ValidationError(f"第 {index} 个分组合唱组必须是对象。")
        name = str(raw.get("name") or "").strip() or f"第 {index} 组"
        if name in names:
            raise ValidationError("分组合唱组名称不能重复。")
        raw_ids = raw.get("singer_ids")
        if not isinstance(raw_ids, list) or not raw_ids:
            raise ValidationError(f"分组合唱组 {name} 必须包含至少一名成员。")
        members: list[SingerRegistration] = []
        for raw_id in raw_ids:
            singer_id = str(raw_id)
            if singer_id not in approved:
                raise ValidationError("分组合唱成员必须是当前活动已审核通过的选手。")
            if singer_id in seen:
                raise ValidationError("同一名选手不能同时属于多个分组合唱组。")
            seen.add(singer_id)
            members.append(approved[singer_id])
        names.add(name)
        normalized.append((name, members))
    if not normalized:
        raise ValidationError("至少需要一个分组合唱组。")
    if complete and seen != set(approved):
        missing = sorted(set(approved) - seen, key=int)
        raise ValidationError(f"必须覆盖当前全部审核通过的选手，缺少：{missing}。")
    return normalized


def _snapshot(stage: GroupStage) -> list[dict[str, Any]]:
    return [
        {
            "group_order": group.group_order,
            "name": group.name,
            "is_active": group.is_active,
            "singer_ids": list(
                group.memberships.filter(is_current=True)
                .order_by("singer_id")
                .values_list("singer_id", flat=True)
            ),
        }
        for group in stage.groups.order_by("group_order", "pk")
    ]


def _write_audit(*, operator, action_type, stage, old_value="", new_value="", note=""):
    audit = AuditLog.objects.create(
        operator=operator,
        action_type=action_type,
        target=f"GroupStage:{stage.pk}",
        old_value=old_value,
        new_value=new_value,
        note=note,
    )
    from realtime.events import schedule_activity_event

    schedule_activity_event(
        stage.activity_id,
        event="group_stage.changed",
        resource=f"group-stage:{stage.pk}",
        revision=stage.updated_at.isoformat() if stage.updated_at else audit.pk,
        actor={"id": operator.pk, "username": operator.get_username()},
        details={"action": action_type, "status": stage.status},
    )
    return audit


@transaction.atomic
def create_group_stage(activity: Activity, *, stage_key: str, name: str, operator) -> GroupStage:
    current_operator = _operator(operator)
    locked_activity = lock_activity_for_action(activity, ActivityAction.SCORE)
    with authority_write(GROUP_STAGE_STATE):
        stage = GroupStage.objects.create(
            activity=locked_activity,
            stage_key=str(stage_key or "").strip(),
            name=str(name or "").strip(),
            is_test_data=locked_activity.is_test_mode,
        )
    _write_audit(
        operator=current_operator,
        action_type=AuditLog.ActionType.CREATE_GROUP_STAGE,
        stage=stage,
        new_value=json.dumps(
            {"stage_key": stage.stage_key, "name": stage.name}, ensure_ascii=False
        ),
    )
    return stage


@transaction.atomic
def record_group_stage(stage: GroupStage, specs: list[dict[str, Any]], operator) -> GroupStage:
    current_operator = _operator(operator)
    locked_activity = lock_activity_for_action(stage.activity, ActivityAction.SCORE)
    locked_stage = _stage_for_update(stage)
    if locked_stage.activity_id != locked_activity.pk:
        raise PermissionDenied("分组合唱赛段不属于当前活动。")
    if locked_stage.status != GroupStage.Status.DRAFT:
        raise ValidationError("只有待录入的分组合唱赛段可以录入分组。")
    normalized = _normalize_specs(locked_stage, specs, complete=False)
    with authority_write(GROUP_STAGE_STATE):
        Group.objects.filter(stage=locked_stage).delete()
        for group_order, (name, members) in enumerate(normalized, start=1):
            group = Group.objects.create(
                stage=locked_stage,
                name=name,
                group_order=group_order,
                is_active=True,
                is_test_data=locked_stage.is_test_data,
            )
            GroupMembership.objects.bulk_create(
                [
                    GroupMembership(
                        group=group,
                        singer=singer,
                        is_current=True,
                        added_by=current_operator,
                    )
                    for singer in members
                ]
            )
    _write_audit(
        operator=current_operator,
        action_type=AuditLog.ActionType.UPDATE_GROUP_STAGE,
        stage=locked_stage,
        new_value=json.dumps(_snapshot(locked_stage), ensure_ascii=False),
    )
    return locked_stage


@transaction.atomic
def confirm_group_stage(stage: GroupStage, operator) -> GroupStage:
    current_operator = _operator(operator)
    locked_activity = lock_activity_for_action(stage.activity, ActivityAction.SCORE)
    locked_stage = _stage_for_update(stage)
    if locked_stage.activity_id != locked_activity.pk:
        raise PermissionDenied("分组合唱赛段不属于当前活动。")
    if locked_stage.status != GroupStage.Status.DRAFT:
        raise ValidationError("只有待录入的分组合唱赛段可以确认。")
    specs = [
        {
            "name": group.name,
            "singer_ids": list(
                group.memberships.filter(is_current=True).values_list("singer_id", flat=True)
            ),
        }
        for group in locked_stage.groups.filter(is_active=True).order_by("group_order", "pk")
    ]
    _normalize_specs(locked_stage, specs, complete=True)
    now = timezone.now()
    with authority_write(GROUP_STAGE_STATE):
        locked_stage.status = GroupStage.Status.CONFIRMED
        locked_stage.confirmed_at = now
        locked_stage.confirmed_by = current_operator
        locked_stage.save(update_fields=["status", "confirmed_at", "confirmed_by", "updated_at"])
    _write_audit(
        operator=current_operator,
        action_type=AuditLog.ActionType.CONFIRM_GROUP_STAGE,
        stage=locked_stage,
        new_value=json.dumps(
            {"status": locked_stage.status, "groups": _snapshot(locked_stage)},
            ensure_ascii=False,
        ),
    )
    return locked_stage


@transaction.atomic
def freeze_group_stage(stage: GroupStage, operator) -> GroupStage:
    current_operator = _operator(operator)
    locked_activity = lock_activity_for_action(stage.activity, ActivityAction.SCORE)
    locked_stage = _stage_for_update(stage)
    if locked_stage.activity_id != locked_activity.pk:
        raise PermissionDenied("分组合唱赛段不属于当前活动。")
    if locked_stage.status != GroupStage.Status.CONFIRMED:
        raise ValidationError("只有已确认的分组合唱赛段可以冻结。")
    now = timezone.now()
    with authority_write(GROUP_STAGE_STATE):
        locked_stage.status = GroupStage.Status.FROZEN
        locked_stage.frozen_at = now
        locked_stage.frozen_by = current_operator
        locked_stage.save(update_fields=["status", "frozen_at", "frozen_by", "updated_at"])
    _write_audit(
        operator=current_operator,
        action_type=AuditLog.ActionType.FREEZE_GROUP_STAGE,
        stage=locked_stage,
        new_value=json.dumps(_snapshot(locked_stage), ensure_ascii=False),
    )
    return locked_stage


@transaction.atomic
def correct_group_stage(
    stage: GroupStage, specs: list[dict[str, Any]], operator, *, reason: str
) -> GroupStage:
    current_operator = _operator(operator)
    reason = str(reason or "").strip()
    if not reason:
        raise ValidationError("必须说明成员修正原因。")
    locked_activity = lock_activity_for_action(stage.activity, ActivityAction.SCORE)
    locked_stage = _stage_for_update(stage)
    if locked_stage.activity_id != locked_activity.pk:
        raise PermissionDenied("分组合唱赛段不属于当前活动。")
    if locked_stage.status not in (GroupStage.Status.CONFIRMED, GroupStage.Status.FROZEN):
        raise ValidationError("只有已确认或已冻结的分组合唱赛段可以修正。")
    from .services import ensure_group_stage_not_consumed_by_confirmed_stage

    ensure_group_stage_not_consumed_by_confirmed_stage(locked_stage)
    _ensure_group_stage_not_bound_by_frozen_ruleset(locked_stage)
    normalized = _normalize_specs(locked_stage, specs, complete=True)
    old_snapshot = _snapshot(locked_stage)
    old_status = locked_stage.status
    now = timezone.now()
    with authority_write(GROUP_STAGE_STATE):
        current_memberships = list(
            GroupMembership.objects.filter(group__stage=locked_stage, is_current=True)
        )
        for membership in current_memberships:
            membership.is_current = False
            membership.left_at = now
            membership.removed_by = current_operator
            membership.change_reason = reason
            membership.save(update_fields=["is_current", "left_at", "removed_by", "change_reason"])

        active_groups = {
            group.group_order: group for group in locked_stage.groups.select_for_update().all()
        }
        wanted_orders = set(range(1, len(normalized) + 1))
        for group_order, group in active_groups.items():
            if group_order not in wanted_orders and group.is_active:
                group.is_active = False
                group.save(update_fields=["is_active", "updated_at"])
        for group_order, (name, members) in enumerate(normalized, start=1):
            group = active_groups.get(group_order)
            if group is None:
                group = Group.objects.create(
                    stage=locked_stage,
                    name=name,
                    group_order=group_order,
                    is_active=True,
                    is_test_data=locked_stage.is_test_data,
                )
            else:
                group.name = name
                group.is_active = True
                group.save(update_fields=["name", "is_active", "updated_at"])
            GroupMembership.objects.bulk_create(
                [
                    GroupMembership(
                        group=group,
                        singer=singer,
                        is_current=True,
                        added_by=current_operator,
                        change_reason=reason,
                    )
                    for singer in members
                ]
            )
        locked_stage.confirmed_at = now
        locked_stage.confirmed_by = current_operator
        update_fields = ["confirmed_at", "confirmed_by", "updated_at"]
        if old_status == GroupStage.Status.FROZEN:
            locked_stage.frozen_at = now
            locked_stage.frozen_by = current_operator
            update_fields.extend(["frozen_at", "frozen_by"])
        locked_stage.save(update_fields=update_fields)
    _write_audit(
        operator=current_operator,
        action_type=AuditLog.ActionType.CORRECT_GROUP_STAGE,
        stage=locked_stage,
        old_value=json.dumps(old_snapshot, ensure_ascii=False),
        new_value=json.dumps(_snapshot(locked_stage), ensure_ascii=False),
        note=reason,
    )
    return locked_stage


def current_group_members(group: Group):
    """Return only the membership rows that grant current Group access."""
    return group.memberships.filter(is_current=True).select_related("singer").order_by("singer_id")


def _ensure_group_stage_not_bound_by_frozen_ruleset(stage: GroupStage) -> None:
    """A frozen ruleset owns an immutable GroupStage membership snapshot."""
    from ruleset.models import RulesetVersion

    for binding in RulesetVersion.objects.filter(
        ruleset__activity_id=stage.activity_id,
        status=RulesetVersion.Status.FROZEN,
    ).values_list("binding", flat=True):
        stage_ids = {
            str(stage_id) for stage_id in (binding or {}).get("group_stage_keys", {}).values()
        }
        if str(stage.pk) in stage_ids:
            raise ValidationError("该分组合唱赛段已被冻结赛制使用，请先建立后继赛制版本。")


class GroupReadiness(StrEnum):
    WAITING_FOR_CONFIRMATION = "waiting_for_confirmation"
    MISSING_MEMBER = "missing_member"
    MISSING_MATERIAL = "missing_material"
    READY = "ready"


def group_material_readiness(group: Group) -> GroupReadiness:
    """Evaluate the minimum formal Group Chorus material contract."""
    from files.models import MaterialCheck, SubmissionFile

    if group.stage.status == GroupStage.Status.DRAFT or not group.is_active:
        return GroupReadiness.WAITING_FOR_CONFIRMATION
    if not group.memberships.filter(is_current=True).exists():
        return GroupReadiness.MISSING_MEMBER
    required_purposes = [
        SubmissionFile.Purpose.ACCOMPANIMENT,
        SubmissionFile.Purpose.PERFORMANCE_VIDEO,
    ]
    current_files = SubmissionFile.objects.filter(
        group=group,
        is_current=True,
        file_purpose__in=required_purposes,
    )
    if not current_files.exists():
        return GroupReadiness.MISSING_MATERIAL
    checks = MaterialCheck.objects.filter(group=group, required=True)
    questionnaire_checks = checks.exclude(question_key="")
    if questionnaire_checks.exclude(status=MaterialCheck.Status.APPROVED).exists():
        return GroupReadiness.MISSING_MATERIAL
    # The legacy "合唱伴奏" check is an either/or contract: an approved audio file or
    # a current performance video is enough. A missing legacy audio check must not reject
    # a group that has chosen the video branch.
    if current_files.filter(file_purpose=SubmissionFile.Purpose.PERFORMANCE_VIDEO).exists():
        return GroupReadiness.READY
    legacy_check = checks.filter(
        question_key="", file_purpose=SubmissionFile.Purpose.ACCOMPANIMENT
    ).first()
    if legacy_check is not None and legacy_check.status != MaterialCheck.Status.APPROVED:
        return GroupReadiness.MISSING_MATERIAL
    return GroupReadiness.READY


def group_stage_readiness(stage: GroupStage) -> dict[str, Any]:
    groups = list(stage.groups.filter(is_active=True).order_by("group_order", "pk"))
    statuses = {group.pk: group_material_readiness(group) for group in groups}
    return {
        "ready": stage.status in (GroupStage.Status.CONFIRMED, GroupStage.Status.FROZEN)
        and bool(groups)
        and all(status == GroupReadiness.READY for status in statuses.values()),
        "groups": statuses,
    }
