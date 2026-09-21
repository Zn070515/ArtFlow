from __future__ import annotations

import json
from typing import Any

from accounts.services import require_current_admin, require_current_staff
from common.models import AuditLog
from core.models import Activity
from core.policies import ActivityAction
from core.services import lock_activity_for_action
from django.core.exceptions import ValidationError
from django.db import transaction
from django.db.models import Q
from django.utils import timezone
from ruleset.models import RulesetVersion
from singer_contest.models import StageResult
from singer_contest.services import build_result_closure

from .models import PublicPost, ResultRelease


def _require_note(note: str) -> str:
    cleaned = str(note or "").strip()
    if not cleaned:
        raise ValidationError("结果发布状态变更必须填写原因。")
    return cleaned


def _audit_release_transition(
    *,
    operator,
    action_type: str,
    target: str,
    old_value: str = "",
    new_value: str = "",
    note: str,
) -> None:
    AuditLog.objects.create(
        operator=operator,
        action_type=action_type,
        target=target,
        old_value=old_value,
        new_value=new_value,
        note=note,
    )


def _release_payload(release: ResultRelease) -> str:
    return json.dumps(
        {
            "post_id": release.post_id,
            "stage_result_id": release.stage_result_id,
            "post_version": release.post_version,
            "result_version": release.result_version,
            "ruleset_version_id": release.ruleset_version_id,
        },
        ensure_ascii=False,
        sort_keys=True,
    )


def _locked_activity_for_stage(stage_result_id: int, action: ActivityAction) -> Activity:
    activity_id = StageResult.objects.only("activity_id").get(pk=stage_result_id).activity_id
    return lock_activity_for_action(Activity.objects.get(pk=activity_id), action)


def _validate_release_target(
    *,
    activity: Activity,
    stage_result: StageResult,
    post: PublicPost,
    closure_required: bool,
) -> RulesetVersion:
    if activity.data_lifecycle != Activity.DataLifecycle.FORMAL or activity.is_test_mode:
        raise ValidationError("测试活动不能发布结果。")
    if post.related_activity_id != activity.pk:
        raise ValidationError("结果公示与赛段结果不属于同一活动。")
    if post.post_type != PublicPost.PostType.RESULT_PUBLICATION:
        raise ValidationError("只有结果公示文章可以发布赛段结果。")
    if post.status != PublicPost.Status.PUBLISHED:
        raise ValidationError("结果公示文章必须先处于已发布状态。")
    if stage_result.status != StageResult.Status.CONFIRMED:
        raise ValidationError("只有已核定的赛段结果可以发布。")

    version = RulesetVersion.objects.select_for_update().get(pk=stage_result.ruleset_version_id)
    if (
        version.status != RulesetVersion.Status.FROZEN
        or not version.is_current
        or version.ruleset.activity_id != activity.pk
    ):
        raise ValidationError("只能发布基于当前冻结赛制版本的结果。")
    if stage_result.ruleset_hash != version.authority_hash:
        raise ValidationError("赛段结果的赛制指纹与当前冻结版本不一致。")

    latest = (
        StageResult.objects.filter(activity_id=activity.pk, stage_key=stage_result.stage_key)
        .order_by("-result_version", "-pk")
        .first()
    )
    if latest is None or latest.pk != stage_result.pk:
        raise ValidationError("只能发布该赛段当前最新的结果。")

    if closure_required:
        closure = build_result_closure(activity, stage_key=stage_result.stage_key)
        if not closure.closeable:
            raise ValidationError("结果闭场检查未通过，暂不能发布。")
    return version


def _active_release_line(stage_result: StageResult):
    return ResultRelease.objects.filter(
        status=ResultRelease.Status.ACTIVE,
        stage_result__activity_id=stage_result.activity_id,
        stage_result__stage_key=stage_result.stage_key,
    )


def _supersede_locked_release_line(*, stage_result: StageResult, operator, note: str) -> int:
    """Supersede the active public authority for one activity/stage line.

    The caller already holds the Activity and StageResult locks. This helper then
    locks posts before release rows, preserving Activity → StageResult → PublicPost
    → ResultRelease ordering for both explicit unlocks and automatic invalidation.
    """
    candidates = list(
        _active_release_line(stage_result).order_by("pk").values_list("pk", "post_id")
    )
    if not candidates:
        return 0

    post_ids = sorted({post_id for _, post_id in candidates})
    list(PublicPost.objects.select_for_update().filter(pk__in=post_ids).order_by("pk"))
    releases = list(
        ResultRelease.objects.select_for_update()
        .filter(pk__in=[release_id for release_id, _ in candidates])
        .order_by("pk")
    )
    transition_at = timezone.now()
    for release in releases:
        release.status = ResultRelease.Status.SUPERSEDED
        release.transition_by = operator
        release.transition_at = transition_at
        release.note = note
        release.save(update_fields=["status", "transition_by", "transition_at", "note"])
        _audit_release_transition(
            operator=operator,
            action_type=AuditLog.ActionType.SUPERSEDE_RESULT_RELEASE,
            target=f"ResultRelease:{release.pk}",
            old_value=ResultRelease.Status.ACTIVE,
            new_value=ResultRelease.Status.SUPERSEDED,
            note=note,
        )
    return len(releases)


@transaction.atomic
def release_result_post(
    post: PublicPost,
    stage_result: StageResult,
    operator: Any,
    *,
    note: str,
) -> ResultRelease:
    """Explicitly release one current, closed stage result to one public post."""
    note = _require_note(note)
    locked_activity = _locked_activity_for_stage(stage_result.pk, ActivityAction.PUBLISH_RESULT)
    current_operator = require_current_admin(operator)
    locked_stage = (
        StageResult.objects.select_for_update()
        .select_related("ruleset_version__ruleset")
        .get(pk=stage_result.pk)
    )
    locked_post = PublicPost.objects.select_for_update().get(pk=post.pk)
    active_releases = list(
        ResultRelease.objects.select_for_update()
        .filter(
            Q(post_id=locked_post.pk) | Q(stage_result_id=locked_stage.pk),
            status=ResultRelease.Status.ACTIVE,
        )
        .order_by("pk")
    )
    version = _validate_release_target(
        activity=locked_activity,
        stage_result=locked_stage,
        post=locked_post,
        closure_required=True,
    )

    for release in active_releases:
        if release.post_id == locked_post.pk and release.stage_result_id == locked_stage.pk:
            if (
                release.post_version == locked_post.version
                and release.result_version == locked_stage.result_version
                and release.ruleset_version_id == version.pk
                and release.authority_hash == version.authority_hash
                and release.input_fingerprint == locked_stage.input_fingerprint
            ):
                return release
            raise ValidationError("该结果公示已有不一致的生效发布记录。")
        raise ValidationError("该文章或赛段已有其他生效的结果发布记录。")

    release = ResultRelease.objects.create(
        post=locked_post,
        stage_result=locked_stage,
        post_version=locked_post.version,
        result_version=locked_stage.result_version,
        ruleset_version=version,
        authority_hash=version.authority_hash,
        input_fingerprint=locked_stage.input_fingerprint,
        released_by=current_operator,
        note=note,
    )
    _audit_release_transition(
        operator=current_operator,
        action_type=AuditLog.ActionType.RELEASE_RESULT,
        target=f"PublicPost:{locked_post.pk}",
        new_value=_release_payload(release),
        note=note,
    )
    return release


@transaction.atomic
def revoke_result_release(
    post: PublicPost,
    operator: Any,
    *,
    note: str,
) -> ResultRelease:
    """Revoke the active release for a public result post without deleting history."""
    note = _require_note(note)
    post_ref = PublicPost.objects.only("related_activity_id").get(pk=post.pk)
    if post_ref.related_activity_id is None:
        raise ValidationError("结果公示必须关联活动。")
    locked_activity = lock_activity_for_action(
        Activity.objects.get(pk=post_ref.related_activity_id), ActivityAction.PUBLISH_RESULT
    )
    current_operator = require_current_admin(operator)
    active_refs = list(
        ResultRelease.objects.filter(post_id=post.pk, status=ResultRelease.Status.ACTIVE)
        .order_by("pk")
        .values_list("pk", "stage_result_id")
    )
    stage_ids = sorted({stage_id for _, stage_id in active_refs if stage_id is not None})
    list(StageResult.objects.select_for_update().filter(pk__in=stage_ids).order_by("pk"))
    locked_post = PublicPost.objects.select_for_update().get(pk=post.pk)
    active_releases = list(
        ResultRelease.objects.select_for_update()
        .filter(post_id=locked_post.pk, status=ResultRelease.Status.ACTIVE)
        .order_by("pk")
    )
    if not active_releases:
        raise ValidationError("该结果公示没有生效中的发布记录。")
    if len(active_releases) != 1:
        raise ValidationError("该结果公示存在多个生效发布记录，已拒绝继续操作。")
    release = active_releases[0]
    if release.stage_result.activity_id != locked_activity.pk:
        raise ValidationError("结果发布记录与文章活动不一致。")

    release.status = ResultRelease.Status.REVOKED
    release.transition_by = current_operator
    release.transition_at = timezone.now()
    release.note = note
    release.save(update_fields=["status", "transition_by", "transition_at", "note"])
    _audit_release_transition(
        operator=current_operator,
        action_type=AuditLog.ActionType.REVOKE_RESULT,
        target=f"PublicPost:{locked_post.pk}",
        old_value=ResultRelease.Status.ACTIVE,
        new_value=ResultRelease.Status.REVOKED,
        note=note,
    )
    return release


@transaction.atomic
def supersede_releases_for_stage_result(
    stage_result: StageResult,
    operator: Any,
    *,
    note: str,
) -> int:
    """Supersede every active release on a stage line as an audited command."""
    note = _require_note(note)
    locked_activity = _locked_activity_for_stage(stage_result.pk, ActivityAction.PUBLISH_RESULT)
    current_operator = require_current_admin(operator)
    locked_stage = StageResult.objects.select_for_update().get(pk=stage_result.pk)
    if locked_stage.activity_id != locked_activity.pk:
        raise ValidationError("赛段结果不属于当前活动。")
    return _supersede_locked_release_line(
        stage_result=locked_stage,
        operator=current_operator,
        note=note,
    )


@transaction.atomic
def _supersede_releases_for_new_result(stage_result: StageResult, operator: Any) -> int:
    """Invalidate older public releases after formal result persistence.

    This is an internal recompute hook, not an HTTP authority surface. Formal
    result persistence already authenticates a current staff operator; it uses
    that operator for the automatic audit rather than requiring a second admin
    re-authentication for a system-generated invalidation.
    """
    if not _active_release_line(stage_result).exists():
        return 0
    locked_activity = _locked_activity_for_stage(stage_result.pk, ActivityAction.PUBLISH_RESULT)
    current_operator = require_current_staff(operator)
    locked_stage = StageResult.objects.select_for_update().get(pk=stage_result.pk)
    if locked_stage.activity_id != locked_activity.pk:
        raise ValidationError("赛段结果不属于当前活动。")
    return _supersede_locked_release_line(
        stage_result=locked_stage,
        operator=current_operator,
        note="新结果版本已生成，旧结果公示自动失效。",
    )
