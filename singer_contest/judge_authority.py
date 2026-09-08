from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass
from datetime import timedelta

from accounts.models import User
from accounts.services import require_current_staff
from common.authority import (
    JUDGE_PANEL_STATE,
    JUDGE_SESSION_STATE,
    ROUND_PERFORMANCE_STATE,
    authority_write,
)
from common.models import AuditLog
from core.models import Activity
from core.policies import ActivityAction
from core.services import lock_activity_for_action
from django.core.exceptions import PermissionDenied, ValidationError
from django.db import transaction
from django.utils import timezone
from entry_access.models import EntryPoint, EphemeralSession
from entry_access.services import (
    IssuedAccessGrant,
    authenticate_ephemeral_session,
    create_entry_point,
    issue_access_grant,
)

from .models import (
    ContestRound,
    Judge,
    JudgeSeat,
    JudgeSeatGrant,
    JudgeSession,
    Performance,
    PerformanceRunState,
    RoundJudge,
    RoundPanelSnapshot,
    RoundPanelSnapshotMember,
)


@dataclass(frozen=True)
class LockedJudgeRound:
    activity: Activity
    contest_round: ContestRound
    operator: User


def _lock_judge_round(round_id: int, operator) -> LockedJudgeRound:
    current_operator = require_current_staff(operator)
    initial_round = ContestRound.objects.select_related("activity").get(pk=round_id)
    locked_activity = lock_activity_for_action(initial_round.activity, ActivityAction.SCORE)
    locked_round = (
        ContestRound.objects.select_for_update().select_related("activity").get(pk=round_id)
    )
    if locked_round.activity_id != locked_activity.pk:
        raise ValidationError("评委轮次活动上下文不一致。")
    return LockedJudgeRound(
        activity=locked_activity,
        contest_round=locked_round,
        operator=current_operator,
    )


def _active_panel_snapshot(contest_round: ContestRound) -> RoundPanelSnapshot | None:
    return (
        RoundPanelSnapshot.objects.filter(
            round=contest_round,
            state=RoundPanelSnapshot.State.ACTIVE,
        )
        .order_by("-version")
        .first()
    )


def _panel_roster_digest(judges: list[Judge]) -> str:
    roster = [
        {"judge_id": judge.pk, "seat_key": f"seat-{index}"}
        for index, judge in enumerate(judges, start=1)
    ]
    canonical = json.dumps(roster, ensure_ascii=True, separators=(",", ":"), sort_keys=True)
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


def _minimum_judges(contest_round: ContestRound) -> int:
    if contest_round.scoring_mode == ContestRound.ScoringMode.DROP_HIGH_LOW:
        return 3
    return 1


def _audit(
    *,
    operator,
    action_type: str,
    target: str,
    old_value: str = "",
    new_value: str = "",
    note: str = "",
) -> None:
    AuditLog.objects.create(
        operator=operator,
        action_type=action_type,
        target=target,
        old_value=old_value,
        new_value=new_value,
        note=note,
    )


@transaction.atomic
def prepare_judge_panel(round_id: int, *, operator) -> RoundPanelSnapshot:
    locked = _lock_judge_round(round_id, operator)
    contest_round = locked.contest_round
    if contest_round.status == ContestRound.Status.DRAFT:
        raise ValidationError("比赛轮次必须先完成准备，才能建立评委组快照。")
    if contest_round.status == ContestRound.Status.LOCKED or contest_round.is_locked:
        raise PermissionDenied("已锁定轮次不能建立评委组快照。")

    existing = _active_panel_snapshot(contest_round)
    if existing is not None:
        return existing

    judges = list(Judge.objects.filter(activity=locked.activity, is_active=True).order_by("pk"))
    minimum_judges = _minimum_judges(contest_round)
    if len(judges) < minimum_judges:
        raise ValidationError("当前评分方式没有足够的活跃评委。")
    if contest_round.round_judges.count() != len(judges):
        raise ValidationError("准备后的评委名单与当前活跃评委不一致。")

    with authority_write(JUDGE_PANEL_STATE):
        snapshot = RoundPanelSnapshot.objects.create(
            round=contest_round,
            activity=locked.activity,
            version=1,
            change_policy=RoundPanelSnapshot.ChangePolicy.HOLD_ONLY,
            state=RoundPanelSnapshot.State.ACTIVE,
            expected_judge_count=len(judges),
            minimum_judge_count=minimum_judges,
            scoring_method=contest_round.scoring_mode,
            roster_digest=_panel_roster_digest(judges),
            captured_by=locked.operator,
            is_test_data=locked.activity.is_test_mode,
        )
        round_judges = list(
            RoundJudge.objects.filter(round=contest_round).select_related("judge").order_by("pk")
        )
        members = RoundPanelSnapshotMember.objects.bulk_create(
            [
                RoundPanelSnapshotMember(
                    panel_snapshot=snapshot,
                    judge=round_judge.judge,
                    source_round_judge=round_judge,
                    seat_key=f"seat-{index}",
                    is_active=True,
                )
                for index, round_judge in enumerate(round_judges, start=1)
            ]
        )
        JudgeSeat.objects.bulk_create(
            [
                JudgeSeat(
                    panel_member=member,
                    state=JudgeSeat.State.ASSIGNED,
                    assigned_by=locked.operator,
                    is_test_data=locked.activity.is_test_mode,
                )
                for member in members
            ]
        )

    with authority_write(ROUND_PERFORMANCE_STATE):
        PerformanceRunState.objects.create(
            round=contest_round,
            state=PerformanceRunState.State.IDLE,
            context_version=0,
            is_test_data=locked.activity.is_test_mode,
        )

    _audit(
        operator=locked.operator,
        action_type=AuditLog.ActionType.JUDGE_PANEL_PREPARE,
        target=f"RoundPanelSnapshot:{snapshot.pk}",
        new_value=json.dumps(
            {
                "round_id": contest_round.pk,
                "version": snapshot.version,
                "judge_count": len(judges),
                "roster_digest": snapshot.roster_digest,
            },
            ensure_ascii=True,
            sort_keys=True,
        ),
    )
    return snapshot


@transaction.atomic
def hold_judge_panel(round_id: int, *, operator, reason: str) -> RoundPanelSnapshot:
    reason = reason.strip()
    if not reason or len(reason) > 240:
        raise ValidationError("暂停评委组必须填写不超过 240 字的原因。")
    locked = _lock_judge_round(round_id, operator)
    snapshot = _active_panel_snapshot(locked.contest_round)
    if snapshot is None:
        raise ValidationError("当前轮次没有活动中的评委组快照。")

    now = timezone.now()
    with authority_write(JUDGE_PANEL_STATE):
        snapshot.state = RoundPanelSnapshot.State.HOLD
        snapshot.save(update_fields=["state"])
    run_state = PerformanceRunState.objects.select_for_update().get(round=locked.contest_round)
    with authority_write(ROUND_PERFORMANCE_STATE):
        run_state.state = PerformanceRunState.State.HOLD
        run_state.hold_reason = reason
        run_state.changed_by = locked.operator
        run_state.save(update_fields=["state", "hold_reason", "changed_by", "updated_at"])
    with authority_write(JUDGE_SESSION_STATE):
        JudgeSession.objects.filter(
            seat__panel_member__panel_snapshot=snapshot,
            state=JudgeSession.State.ACTIVE,
        ).update(
            state=JudgeSession.State.REVOKED,
            revoked_at=now,
            revocation_reason=reason,
        )
    _audit(
        operator=locked.operator,
        action_type=AuditLog.ActionType.JUDGE_PANEL_HOLD,
        target=f"RoundPanelSnapshot:{snapshot.pk}",
        old_value=RoundPanelSnapshot.State.ACTIVE,
        new_value=RoundPanelSnapshot.State.HOLD,
        note=reason,
    )
    return snapshot


@transaction.atomic
def resume_judge_panel(round_id: int, *, operator) -> RoundPanelSnapshot:
    locked = _lock_judge_round(round_id, operator)
    snapshot = (
        RoundPanelSnapshot.objects.select_for_update()
        .filter(round=locked.contest_round)
        .order_by("-version")
        .first()
    )
    if snapshot is None or snapshot.state != RoundPanelSnapshot.State.HOLD:
        raise ValidationError("当前轮次没有处于暂停状态的评委组。")

    with authority_write(JUDGE_PANEL_STATE):
        snapshot.state = RoundPanelSnapshot.State.ACTIVE
        snapshot.save(update_fields=["state"])
    run_state = PerformanceRunState.objects.select_for_update().get(round=locked.contest_round)
    next_state = (
        PerformanceRunState.State.PERFORMING
        if run_state.current_performance_id
        else PerformanceRunState.State.IDLE
    )
    with authority_write(ROUND_PERFORMANCE_STATE):
        run_state.state = next_state
        run_state.hold_reason = ""
        run_state.changed_by = locked.operator
        run_state.save(update_fields=["state", "hold_reason", "changed_by", "updated_at"])
    _audit(
        operator=locked.operator,
        action_type=AuditLog.ActionType.JUDGE_PANEL_CHANGE,
        target=f"RoundPanelSnapshot:{snapshot.pk}",
        old_value=RoundPanelSnapshot.State.HOLD,
        new_value=RoundPanelSnapshot.State.ACTIVE,
        note="resume_judge_panel",
    )
    return snapshot


@transaction.atomic
def advance_performance(round_id: int, performance_id: int, *, operator) -> PerformanceRunState:
    locked = _lock_judge_round(round_id, operator)
    if locked.contest_round.status == ContestRound.Status.LOCKED:
        raise PermissionDenied("已锁定轮次不能推进表演。")
    snapshot = _active_panel_snapshot(locked.contest_round)
    if snapshot is None or snapshot.state != RoundPanelSnapshot.State.ACTIVE:
        raise PermissionDenied("评委组未处于可评分状态。")
    performance = Performance._base_manager.filter(
        pk=performance_id,
        round=locked.contest_round,
        activity=locked.activity,
    ).first()
    if performance is None:
        raise ValidationError("当前表演不属于该评委轮次。")
    run_state = PerformanceRunState.objects.select_for_update().get(round=locked.contest_round)
    next_version = run_state.context_version
    if run_state.current_performance_id != performance.pk:
        next_version += 1
    with authority_write(ROUND_PERFORMANCE_STATE):
        run_state.current_performance = performance
        run_state.state = PerformanceRunState.State.PERFORMING
        run_state.context_version = next_version
        run_state.hold_reason = ""
        run_state.changed_by = locked.operator
        run_state.save(
            update_fields=[
                "current_performance",
                "state",
                "context_version",
                "hold_reason",
                "changed_by",
                "updated_at",
            ]
        )
    _audit(
        operator=locked.operator,
        action_type=AuditLog.ActionType.JUDGE_PERF_ADVANCE,
        target=f"PerformanceRunState:{run_state.pk}",
        new_value=json.dumps(
            {
                "performance_id": performance.pk,
                "context_version": next_version,
            },
            ensure_ascii=True,
            sort_keys=True,
        ),
    )
    return run_state


@transaction.atomic
def hold_performance(round_id: int, *, operator, reason: str) -> PerformanceRunState:
    reason = reason.strip()
    if not reason or len(reason) > 240:
        raise ValidationError("暂停表演必须填写不超过 240 字的原因。")
    locked = _lock_judge_round(round_id, operator)
    run_state = PerformanceRunState.objects.select_for_update().get(round=locked.contest_round)
    with authority_write(ROUND_PERFORMANCE_STATE):
        run_state.state = PerformanceRunState.State.HOLD
        run_state.hold_reason = reason
        run_state.changed_by = locked.operator
        run_state.save(update_fields=["state", "hold_reason", "changed_by", "updated_at"])
    _audit(
        operator=locked.operator,
        action_type=AuditLog.ActionType.JUDGE_PERF_HOLD,
        target=f"PerformanceRunState:{run_state.pk}",
        note=reason,
    )
    return run_state


@transaction.atomic
def resume_performance(round_id: int, *, operator) -> PerformanceRunState:
    locked = _lock_judge_round(round_id, operator)
    snapshot = _active_panel_snapshot(locked.contest_round)
    if snapshot is None or snapshot.state != RoundPanelSnapshot.State.ACTIVE:
        raise PermissionDenied("评委组仍处于暂停状态。")
    run_state = PerformanceRunState.objects.select_for_update().get(round=locked.contest_round)
    if run_state.state != PerformanceRunState.State.HOLD:
        raise ValidationError("当前表演上下文不处于暂停状态。")
    next_state = (
        PerformanceRunState.State.PERFORMING
        if run_state.current_performance_id
        else PerformanceRunState.State.IDLE
    )
    with authority_write(ROUND_PERFORMANCE_STATE):
        run_state.state = next_state
        run_state.hold_reason = ""
        run_state.changed_by = locked.operator
        run_state.save(update_fields=["state", "hold_reason", "changed_by", "updated_at"])
    return run_state


@transaction.atomic
def issue_judge_grant(seat_id: int, *, operator, ttl_seconds: int) -> IssuedAccessGrant:
    if isinstance(ttl_seconds, bool) or not isinstance(ttl_seconds, int):
        raise ValidationError("评委授权有效期必须是整数秒。")
    if ttl_seconds <= 0 or ttl_seconds > 30 * 60:
        raise ValidationError("评委授权有效期必须大于 0 且不超过 30 分钟。")

    seat_context = (
        JudgeSeat.objects.select_related("panel_member__panel_snapshot__round__activity")
        .filter(pk=seat_id)
        .first()
    )
    if seat_context is None:
        raise ValidationError("评委席位不存在。")
    locked = _lock_judge_round(seat_context.panel_member.panel_snapshot.round_id, operator)
    seat = (
        JudgeSeat.objects.select_for_update()
        .select_related("panel_member__panel_snapshot__round__activity")
        .get(pk=seat_id)
    )
    snapshot = RoundPanelSnapshot.objects.select_for_update().get(
        pk=seat.panel_member.panel_snapshot_id
    )
    if seat.panel_member.panel_snapshot.round_id != locked.contest_round.pk:
        raise ValidationError("评委席位不属于当前轮次。")
    if seat.state != JudgeSeat.State.ASSIGNED:
        raise PermissionDenied("当前评委席位不可签发授权。")
    if snapshot.state != RoundPanelSnapshot.State.ACTIVE:
        raise PermissionDenied("评委组未处于可签发授权状态。")
    if JudgeSeatGrant.objects.filter(
        seat=seat,
        access_grant__redeemed_at__isnull=True,
        access_grant__revoked_at__isnull=True,
        access_grant__expires_at__gt=timezone.now(),
    ).exists():
        raise ValidationError("当前评委席位已有未兑换授权。")

    entry_point = (
        EntryPoint.objects.filter(
            activity=locked.activity,
            kind=EntryPoint.Kind.JUDGE,
            is_active=True,
        )
        .order_by("pk")
        .first()
    )
    if entry_point is None:
        entry_point = create_entry_point(
            locked.activity,
            kind=EntryPoint.Kind.JUDGE,
            label=f"Judge terminal {locked.contest_round.pk}",
            actor=locked.operator,
        )
    issued = issue_access_grant(
        entry_point,
        actor=locked.operator,
        ttl=timedelta(seconds=ttl_seconds),
        round=locked.contest_round,
    )
    with authority_write(JUDGE_SESSION_STATE):
        JudgeSeatGrant.objects.create(
            access_grant=issued.grant,
            seat=seat,
            panel_snapshot=snapshot,
        )
    _audit(
        operator=locked.operator,
        action_type=AuditLog.ActionType.JUDGE_SESSION_ISSUE,
        target=f"JudgeSeat:{seat.pk}",
        new_value=json.dumps(
            {
                "grant_id": issued.grant.pk,
                "panel_snapshot_id": snapshot.pk,
                "expires_at": issued.grant.expires_at.isoformat(),
            },
            ensure_ascii=True,
            sort_keys=True,
        ),
    )
    return issued


def _ephemeral_token_digest(raw_token: str) -> str:
    if not isinstance(raw_token, str):
        raise ValidationError("评委访问会话无效。")
    try:
        return hashlib.sha256(raw_token.encode("ascii")).hexdigest()
    except UnicodeEncodeError:
        raise ValidationError("评委访问会话无效。") from None


@transaction.atomic
def authenticate_judge_session(raw_ephemeral_token: str) -> JudgeSession:
    digest = _ephemeral_token_digest(raw_ephemeral_token)
    transport = (
        EphemeralSession._base_manager.select_related("activity", "round", "grant")
        .filter(token_digest=digest)
        .first()
    )
    if transport is None:
        raise ValidationError("评委访问会话无效。")
    transport = authenticate_ephemeral_session(
        raw_ephemeral_token,
        expected_kind=EntryPoint.Kind.JUDGE,
        activity=transport.activity,
        round=transport.round,
    )
    binding = (
        JudgeSeatGrant.objects.select_for_update()
        .select_related(
            "access_grant",
            "seat__panel_member__panel_snapshot__round__activity",
            "panel_snapshot",
        )
        .filter(access_grant_id=transport.grant_id)
        .first()
    )
    if binding is None:
        raise ValidationError("评委访问会话无效。")
    seat = binding.seat
    snapshot = binding.panel_snapshot
    if (
        binding.access_grant.revoked_at is not None
        or seat.state != JudgeSeat.State.ASSIGNED
        or snapshot.state != RoundPanelSnapshot.State.ACTIVE
        or snapshot.round.status == ContestRound.Status.LOCKED
    ):
        raise ValidationError("评委访问会话无效。")

    now = timezone.now()
    existing = (
        JudgeSession.objects.select_for_update().filter(ephemeral_session_id=transport.pk).first()
    )
    if existing is not None:
        if existing.state != JudgeSession.State.ACTIVE or existing.expires_at <= now:
            raise ValidationError("评委访问会话无效。")
        with authority_write(JUDGE_SESSION_STATE):
            existing.last_seen_at = now
            existing.save(update_fields=["last_seen_at"])
        return existing

    with authority_write(JUDGE_SESSION_STATE):
        return JudgeSession.objects.create(
            ephemeral_session=transport,
            seat=seat,
            panel_snapshot=snapshot,
            state=JudgeSession.State.ACTIVE,
            expires_at=transport.expires_at,
            is_test_data=snapshot.is_test_data,
            last_seen_at=now,
        )
