from __future__ import annotations

import hashlib
import json
from collections.abc import Iterable, Mapping
from contextlib import contextmanager
from dataclasses import dataclass
from datetime import timedelta
from decimal import Decimal

from accounts.models import User
from accounts.services import require_current_staff
from common.authority import (
    JUDGE_PANEL_STATE,
    JUDGE_SCORE_SUBMISSION,
    JUDGE_SESSION_STATE,
    ROUND_PERFORMANCE_STATE,
    SCORE_FACT_WRITE,
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
    CriterionScore,
    Judge,
    JudgeScoreReceipt,
    JudgeSeat,
    JudgeSeatGrant,
    JudgeSession,
    Performance,
    PerformanceRunState,
    RoundJudge,
    RoundPanelSnapshot,
    RoundPanelSnapshotMember,
    RubricCriterion,
    ScoreRecord,
    ScoreSource,
    _authorize_raw_fact_write,
    _raw_fact_write_authorized,
)
from .services import validate_score


@dataclass(frozen=True)
class LockedJudgeRound:
    activity: Activity
    contest_round: ContestRound
    operator: User


@dataclass(frozen=True)
class JudgeContext:
    activity_id: int
    round_id: int
    round_name: str
    seat_id: int
    panel_snapshot_id: int
    panel_version: int
    context_version: int
    performance_id: int | None
    performance_label: str | None
    singer_name: str | None
    song_title: str | None
    performance_state: str
    rubric_payload: dict[str, object]


@dataclass(frozen=True)
class JudgeScoreSubmission:
    receipt_id: int
    score_record_id: int
    reason_code: str
    status: str


@dataclass(frozen=True)
class NormalizedJudgeScore:
    score: Decimal
    notes: str
    criteria: tuple[tuple[RubricCriterion, Decimal], ...]
    canonical_payload: dict[str, object]


class JudgeIdempotencyConflict(ValidationError):
    reason_code = "IDEMPOTENCY_CONFLICT"


@dataclass(frozen=True)
class LockedJudgeTransport:
    activity: Activity
    contest_round: ContestRound


def _locked_judge_transport(raw_ephemeral_token: str) -> LockedJudgeTransport:
    digest = _ephemeral_token_digest(raw_ephemeral_token)
    transport = (
        EphemeralSession._base_manager.select_related("activity", "round")
        .filter(token_digest=digest)
        .first()
    )
    if transport is None or transport.kind != EntryPoint.Kind.JUDGE or transport.round_id is None:
        raise ValidationError("评委访问会话无效。")
    locked_activity = lock_activity_for_action(transport.activity, ActivityAction.SCORE)
    locked_round = (
        ContestRound.objects.select_for_update()
        .select_related("activity")
        .get(pk=transport.round_id)
    )
    if locked_round.activity_id != locked_activity.pk:
        raise ValidationError("评委访问会话无效。")
    return LockedJudgeTransport(activity=locked_activity, contest_round=locked_round)


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


def _minimum_judges(contest_round: ContestRound, expected_judge_count: int) -> int:
    configured = contest_round.minimum_judge_count
    minimum = configured if configured is not None else expected_judge_count
    if minimum < 1 or minimum > expected_judge_count:
        raise ValidationError("最低有效评委人数必须在预备名单人数范围内。")
    if contest_round.scoring_mode == ContestRound.ScoringMode.DROP_HIGH_LOW and minimum <= 2:
        raise ValidationError("去最高最低计分方式的最低有效评委人数必须大于 2。")
    return minimum


def _attending_round_judges(
    round_judges: list[RoundJudge], attending_judge_ids: Iterable[int] | None
) -> list[RoundJudge]:
    expected_ids = {round_judge.judge_id for round_judge in round_judges}
    if attending_judge_ids is None:
        attending_ids = expected_ids
    else:
        if isinstance(attending_judge_ids, (str, bytes)):
            raise ValidationError("到场评委必须使用评委 ID 列表。")
        try:
            raw_ids = list(attending_judge_ids)
        except TypeError:
            raise ValidationError("到场评委必须使用评委 ID 列表。") from None
        if any(isinstance(judge_id, bool) or not isinstance(judge_id, int) for judge_id in raw_ids):
            raise ValidationError("到场评委 ID 必须是整数。")
        if len(raw_ids) != len(set(raw_ids)):
            raise ValidationError("到场评委 ID 不能重复。")
        attending_ids = set(raw_ids)
        if not attending_ids.issubset(expected_ids):
            raise ValidationError("到场评委必须来自本轮次预备名单。")
    return [round_judge for round_judge in round_judges if round_judge.judge_id in attending_ids]


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
def prepare_judge_panel(
    round_id: int,
    *,
    operator,
    attending_judge_ids: Iterable[int] | None = None,
) -> RoundPanelSnapshot:
    locked = _lock_judge_round(round_id, operator)
    contest_round = locked.contest_round
    if contest_round.status == ContestRound.Status.DRAFT:
        raise ValidationError("比赛轮次必须先完成准备，才能建立评委组快照。")
    if contest_round.status == ContestRound.Status.LOCKED or contest_round.is_locked:
        raise PermissionDenied("已锁定轮次不能建立评委组快照。")

    existing = _active_panel_snapshot(contest_round)
    if existing is not None:
        return existing

    round_judges = list(
        RoundJudge.objects.filter(round=contest_round).select_related("judge").order_by("pk")
    )
    expected_judge_count = len(round_judges)
    if expected_judge_count < 1:
        raise ValidationError("本轮次没有预备评委名单。")
    minimum_judges = _minimum_judges(contest_round, expected_judge_count)
    attending_round_judges = _attending_round_judges(round_judges, attending_judge_ids)
    if len(attending_round_judges) < minimum_judges:
        raise ValidationError(
            f"INSUFFICIENT_JUDGES: 实到评委 {len(attending_round_judges)} 人，"
            f"最低需要 {minimum_judges} 人。"
        )
    judges = [round_judge.judge for round_judge in attending_round_judges]

    with authority_write(JUDGE_PANEL_STATE):
        snapshot = RoundPanelSnapshot.objects.create(
            round=contest_round,
            activity=locked.activity,
            version=1,
            change_policy=RoundPanelSnapshot.ChangePolicy.HOLD_ONLY,
            state=RoundPanelSnapshot.State.ACTIVE,
            expected_judge_count=expected_judge_count,
            minimum_judge_count=minimum_judges,
            scoring_method=contest_round.scoring_mode,
            roster_digest=_panel_roster_digest(judges),
            captured_by=locked.operator,
            is_test_data=locked.activity.is_test_mode,
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
                for index, round_judge in enumerate(attending_round_judges, start=1)
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
                "expected_judge_count": expected_judge_count,
                "actual_judge_count": len(judges),
                "minimum_judge_count": minimum_judges,
                "attending_judge_ids": [judge.pk for judge in judges],
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
    run_state = PerformanceRunState.objects.select_for_update().get(round=locked.contest_round)

    now = timezone.now()
    with authority_write(JUDGE_PANEL_STATE):
        snapshot.state = RoundPanelSnapshot.State.HOLD
        snapshot.save(update_fields=["state"])
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

    run_state = PerformanceRunState.objects.select_for_update().get(round=locked.contest_round)
    with authority_write(JUDGE_PANEL_STATE):
        snapshot.state = RoundPanelSnapshot.State.ACTIVE
        snapshot.save(update_fields=["state"])
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
    if run_state.state == PerformanceRunState.State.HOLD:
        raise PermissionDenied("ROUND_ON_HOLD")
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
def hold_performance(
    round_id: int,
    *,
    operator,
    reason: str,
    expected_performance_id: int | None = None,
) -> PerformanceRunState:
    reason = reason.strip()
    if not reason or len(reason) > 240:
        raise ValidationError("暂停表演必须填写不超过 240 字的原因。")
    locked = _lock_judge_round(round_id, operator)
    snapshot = _active_panel_snapshot(locked.contest_round)
    if snapshot is None or snapshot.state != RoundPanelSnapshot.State.ACTIVE:
        raise PermissionDenied("评委组未处于可暂停状态。")
    run_state = PerformanceRunState.objects.select_for_update().get(round=locked.contest_round)
    if (
        expected_performance_id is not None
        and run_state.current_performance_id != expected_performance_id
    ):
        raise ValidationError("STALE_CONTEXT")
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


def _authenticate_judge_session_locked(
    raw_ephemeral_token: str,
    locked: LockedJudgeTransport,
) -> JudgeSession:
    transport = authenticate_ephemeral_session(
        raw_ephemeral_token,
        expected_kind=EntryPoint.Kind.JUDGE,
        activity=locked.activity,
        round=locked.contest_round,
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
    snapshot = RoundPanelSnapshot.objects.select_for_update().get(pk=binding.panel_snapshot_id)
    if (
        binding.access_grant.revoked_at is not None
        or seat.state != JudgeSeat.State.ASSIGNED
        or snapshot.state != RoundPanelSnapshot.State.ACTIVE
        or snapshot.round_id != locked.contest_round.pk
        or snapshot.activity_id != locked.activity.pk
        or locked.contest_round.status == ContestRound.Status.LOCKED
        or locked.contest_round.is_locked
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


@transaction.atomic
def authenticate_judge_session(raw_ephemeral_token: str) -> JudgeSession:
    locked = _locked_judge_transport(raw_ephemeral_token)
    return _authenticate_judge_session_locked(raw_ephemeral_token, locked)


@contextmanager
def _authorized_score_fact_write():
    previous = _raw_fact_write_authorized()
    _authorize_raw_fact_write(True)
    try:
        with authority_write(SCORE_FACT_WRITE):
            yield
    finally:
        _authorize_raw_fact_write(previous)


def _normalize_judge_score_payload(
    score_payload: object, *, contest_round: ContestRound
) -> NormalizedJudgeScore:
    if not isinstance(score_payload, Mapping):
        raise ValidationError("评分内容必须是对象。")
    notes = score_payload.get("notes", "")
    if not isinstance(notes, str) or len(notes) > 200:
        raise ValidationError("评分备注必须是不超过 200 个字符的文本。")
    normalized_notes = notes.strip()
    rubric = contest_round.rubric
    if rubric is None:
        if set(score_payload) - {"score", "notes"} or "score" not in score_payload:
            raise ValidationError("评分内容字段无效。")
        score = validate_score(score_payload["score"])
        return NormalizedJudgeScore(
            score=score,
            notes=normalized_notes,
            criteria=(),
            canonical_payload={"score": str(score), "notes": normalized_notes},
        )

    if set(score_payload) - {"criteria", "notes"} or "criteria" not in score_payload:
        raise ValidationError("RUBRIC_PAYLOAD_INVALID")
    rubric_criteria = list(rubric.criteria.all().order_by("sequence", "pk"))
    rubric_max_total = sum((criterion.max_score for criterion in rubric_criteria), Decimal())
    if not rubric_criteria or rubric_max_total != Decimal("100"):
        raise ValidationError("RUBRIC_CONFIGURATION_INVALID")
    criteria_payload = score_payload["criteria"]
    if not isinstance(criteria_payload, list) or not criteria_payload:
        raise ValidationError("RUBRIC_PAYLOAD_INVALID")
    criterion_by_id = {criterion.pk: criterion for criterion in rubric_criteria}
    normalized_criteria: list[tuple[RubricCriterion, Decimal]] = []
    seen_ids: set[int] = set()
    for item in criteria_payload:
        if not isinstance(item, Mapping) or set(item) != {"criterion_id", "value"}:
            raise ValidationError("RUBRIC_PAYLOAD_INVALID")
        criterion_id = item["criterion_id"]
        if isinstance(criterion_id, bool) or not isinstance(criterion_id, int) or criterion_id <= 0:
            raise ValidationError("RUBRIC_PAYLOAD_INVALID")
        criterion = criterion_by_id.get(criterion_id)
        if criterion is None or criterion_id in seen_ids:
            raise ValidationError("RUBRIC_PAYLOAD_INVALID")
        value = validate_score(item["value"])
        if value > criterion.max_score:
            raise ValidationError("RUBRIC_PAYLOAD_INVALID")
        seen_ids.add(criterion_id)
        normalized_criteria.append((criterion, value))
    if seen_ids != set(criterion_by_id):
        raise ValidationError("RUBRIC_PAYLOAD_INVALID")
    values_by_id = {criterion.pk: value for criterion, value in normalized_criteria}
    ordered_criteria = tuple(
        (criterion, values_by_id[criterion.pk]) for criterion in rubric_criteria
    )
    score = sum((value for _, value in ordered_criteria), Decimal())
    return NormalizedJudgeScore(
        score=score,
        notes=normalized_notes,
        criteria=ordered_criteria,
        canonical_payload={
            "score": str(score),
            "criteria": [
                {"criterion_id": criterion.pk, "value": str(value)}
                for criterion, value in ordered_criteria
            ],
            "notes": normalized_notes,
        },
    )


def _judge_payload_hash(
    *,
    locked: LockedJudgeRound | LockedJudgeTransport,
    snapshot: RoundPanelSnapshot,
    seat: JudgeSeat,
    performance: Performance,
    context_version: int,
    payload: Mapping[str, object],
    source: str,
) -> str:
    canonical = json.dumps(
        {
            "activity_id": locked.activity.pk,
            "round_id": locked.contest_round.pk,
            "panel_snapshot_id": snapshot.pk,
            "panel_version": snapshot.version,
            "seat_id": seat.pk,
            "judge_id": seat.panel_member.judge_id,
            "performance_id": performance.pk,
            "context_version": context_version,
            "source": source,
            "payload": dict(payload),
        },
        ensure_ascii=True,
        separators=(",", ":"),
        sort_keys=True,
    )
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


def _materialize_score_facts(
    *,
    contest_round: ContestRound,
    performance: Performance,
    judge: Judge,
    snapshot: RoundPanelSnapshot,
    seat: JudgeSeat,
    command_id: str,
    normalized_payload: NormalizedJudgeScore,
    source: str,
    is_test_data: bool,
    source_reference: str = "",
) -> ScoreRecord:
    with _authorized_score_fact_write():
        score_record = ScoreRecord.objects.create(
            round=contest_round,
            singer=performance.singer,
            judge=judge,
            score=normalized_payload.score,
            notes=normalized_payload.notes,
            source=source,
            panel_snapshot=snapshot,
            judge_seat=seat,
            source_command_id=command_id,
            source_reference=source_reference,
            is_test_data=is_test_data,
        )
        if normalized_payload.criteria:
            CriterionScore.objects.bulk_create(
                [
                    CriterionScore(
                        score_record=score_record,
                        criterion=criterion,
                        value=value,
                        is_test_data=is_test_data,
                    )
                    for criterion, value in normalized_payload.criteria
                ]
            )
    return score_record


def _validate_command_id(command_id: object) -> str:
    if not isinstance(command_id, str) or not command_id.strip() or len(command_id) > 64:
        raise ValidationError("评分命令标识无效。")
    return command_id.strip()


def _validate_expected_context(value: object, *, field: str) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value < 0:
        raise ValidationError(f"{field} 无效。")
    return value


@transaction.atomic
def submit_judge_score(
    raw_ephemeral_token: str,
    *,
    command_id: object,
    expected_context_version: object,
    expected_performance_id: object,
    score_payload: object,
) -> JudgeScoreSubmission:
    locked = _locked_judge_transport(raw_ephemeral_token)
    context_version = _validate_expected_context(
        expected_context_version, field="expected_context_version"
    )
    performance_id = _validate_expected_context(
        expected_performance_id, field="expected_performance_id"
    )
    normalized_command_id = _validate_command_id(command_id)
    normalized_payload = _normalize_judge_score_payload(
        score_payload, contest_round=locked.contest_round
    )

    run_state = PerformanceRunState.objects.select_for_update().get(round=locked.contest_round)
    session = _authenticate_judge_session_locked(raw_ephemeral_token, locked)
    snapshot = RoundPanelSnapshot.objects.select_for_update().get(pk=session.panel_snapshot_id)
    seat = (
        JudgeSeat.objects.select_for_update()
        .select_related("panel_member__panel_snapshot")
        .get(pk=session.seat_id)
    )
    if snapshot.state != RoundPanelSnapshot.State.ACTIVE or seat.state != JudgeSeat.State.ASSIGNED:
        raise PermissionDenied("PANEL_CHANGED_MID_ROUND")
    if run_state.state == PerformanceRunState.State.HOLD:
        raise PermissionDenied("ROUND_ON_HOLD")
    if run_state.state not in {
        PerformanceRunState.State.PERFORMING,
        PerformanceRunState.State.ACCEPTING_SCORE,
    }:
        raise PermissionDenied("PERFORMANCE_NOT_SCORABLE")
    if (
        run_state.context_version != context_version
        or run_state.current_performance_id != performance_id
    ):
        raise ValidationError("STALE_CONTEXT")
    performance = (
        Performance._base_manager.select_related("singer")
        .filter(
            pk=performance_id,
            round=locked.contest_round,
            activity=locked.activity,
        )
        .first()
    )
    if performance is None or performance.pk != run_state.current_performance_id:
        raise ValidationError("PERFORMANCE_NOT_SCORABLE")

    payload_hash = _judge_payload_hash(
        locked=locked,
        snapshot=snapshot,
        seat=seat,
        performance=performance,
        context_version=context_version,
        payload=normalized_payload.canonical_payload,
        source=ScoreSource.DIRECT_JUDGE,
    )
    receipt = (
        JudgeScoreReceipt.objects.select_for_update()
        .filter(command_id=normalized_command_id)
        .first()
    )
    if receipt is not None:
        if (
            receipt.payload_hash != payload_hash
            or receipt.source != ScoreSource.DIRECT_JUDGE
            or receipt.panel_snapshot_id != snapshot.pk
            or receipt.seat_id != seat.pk
            or receipt.performance_id != performance.pk
        ):
            raise JudgeIdempotencyConflict("评分命令已绑定其他内容。")
        if receipt.status == JudgeScoreReceipt.Status.SUCCEEDED and receipt.score_record_id:
            return JudgeScoreSubmission(
                receipt_id=receipt.pk,
                score_record_id=receipt.score_record_id,
                reason_code=receipt.result_code or "ACCEPTED",
                status=receipt.status,
            )
    existing = (
        ScoreRecord._base_manager.select_for_update()
        .filter(
            round=locked.contest_round,
            singer_id=performance.singer_id,
            judge_id=seat.panel_member.judge_id,
        )
        .first()
    )
    if existing is not None:
        raise ValidationError("DUPLICATE_SCORE_FACT")

    if receipt is None:
        with authority_write(JUDGE_SCORE_SUBMISSION):
            receipt = JudgeScoreReceipt.objects.create(
                command_id=normalized_command_id,
                operation="judge_score.submit",
                source=ScoreSource.DIRECT_JUDGE,
                payload_hash=payload_hash,
                panel_snapshot=snapshot,
                seat=seat,
                performance=performance,
                session=session,
                status=JudgeScoreReceipt.Status.PENDING,
            )

    score_record = _materialize_score_facts(
        contest_round=locked.contest_round,
        performance=performance,
        judge=seat.panel_member.judge,
        snapshot=snapshot,
        seat=seat,
        command_id=normalized_command_id,
        normalized_payload=normalized_payload,
        source=ScoreSource.DIRECT_JUDGE,
        is_test_data=locked.activity.is_test_mode,
    )
    now = timezone.now()
    with authority_write(JUDGE_SCORE_SUBMISSION):
        receipt.score_record = score_record
        receipt.status = JudgeScoreReceipt.Status.SUCCEEDED
        receipt.result_code = "ACCEPTED"
        receipt.completed_at = now
        receipt.save(update_fields=["score_record", "status", "result_code", "completed_at"])
    _audit(
        operator=None,
        action_type=AuditLog.ActionType.JUDGE_SCORE_SUBMIT,
        target=f"JudgeScoreReceipt:{receipt.pk}",
        new_value=json.dumps(
            {
                "score_record_id": score_record.pk,
                "performance_id": performance.pk,
                "context_version": context_version,
                "payload_hash": payload_hash,
            },
            ensure_ascii=True,
            sort_keys=True,
        ),
    )
    return JudgeScoreSubmission(
        receipt_id=receipt.pk,
        score_record_id=score_record.pk,
        reason_code="ACCEPTED",
        status=receipt.status,
    )


def _submit_staff_bound_score(
    round_id: int,
    performance_id: object,
    seat_id: object,
    *,
    operator,
    command_id: object,
    expected_context_version: object,
    score_payload: object,
    source: str,
    source_reference: str,
    reason: str,
    audit_action: str,
) -> JudgeScoreSubmission:
    if source not in {ScoreSource.STAFF_PROXY, ScoreSource.PAPER_DR}:
        raise ValidationError("工作人员评分来源无效。")
    if (
        not isinstance(source_reference, str)
        or not source_reference.strip()
        or len(source_reference) > 120
    ):
        raise ValidationError("代录或纸面评分必须提供有效来源参考。")
    if not isinstance(reason, str) or not reason.strip() or len(reason) > 240:
        raise ValidationError("代录或纸面评分必须填写不超过 240 字的原因。")
    normalized_command_id = _validate_command_id(command_id)
    context_version = _validate_expected_context(
        expected_context_version, field="expected_context_version"
    )
    normalized_performance_id = _validate_expected_context(performance_id, field="performance_id")
    normalized_seat_id = _validate_expected_context(seat_id, field="seat_id")
    locked = _lock_judge_round(round_id, operator)
    normalized_payload = _normalize_judge_score_payload(
        score_payload, contest_round=locked.contest_round
    )
    snapshot = _active_panel_snapshot(locked.contest_round)
    if snapshot is None:
        raise PermissionDenied("PANEL_CHANGED_MID_ROUND")
    run_state = PerformanceRunState.objects.select_for_update().get(round=locked.contest_round)
    if run_state.state == PerformanceRunState.State.HOLD:
        raise PermissionDenied("ROUND_ON_HOLD")
    if run_state.state not in {
        PerformanceRunState.State.PERFORMING,
        PerformanceRunState.State.ACCEPTING_SCORE,
    }:
        raise PermissionDenied("PERFORMANCE_NOT_SCORABLE")
    if (
        run_state.context_version != context_version
        or run_state.current_performance_id != normalized_performance_id
    ):
        raise ValidationError("STALE_CONTEXT")
    performance = (
        Performance._base_manager.select_related("singer")
        .filter(
            pk=normalized_performance_id,
            round=locked.contest_round,
            activity=locked.activity,
        )
        .first()
    )
    seat = (
        JudgeSeat.objects.select_for_update()
        .select_related("panel_member__panel_snapshot__round")
        .filter(pk=normalized_seat_id)
        .first()
    )
    if performance is None:
        raise ValidationError("PERFORMANCE_NOT_SCORABLE")
    if seat is None or seat.panel_member.panel_snapshot_id != snapshot.pk:
        raise PermissionDenied("PANEL_CHANGED_MID_ROUND")
    if seat.state != JudgeSeat.State.ASSIGNED:
        raise PermissionDenied("PANEL_CHANGED_MID_ROUND")

    payload_hash = _judge_payload_hash(
        locked=locked,
        snapshot=snapshot,
        seat=seat,
        performance=performance,
        context_version=context_version,
        payload=normalized_payload.canonical_payload,
        source=source,
    )
    receipt = (
        JudgeScoreReceipt.objects.select_for_update()
        .filter(command_id=normalized_command_id)
        .first()
    )
    if receipt is not None:
        if (
            receipt.payload_hash != payload_hash
            or receipt.source != source
            or receipt.panel_snapshot_id != snapshot.pk
            or receipt.seat_id != seat.pk
            or receipt.performance_id != performance.pk
        ):
            raise JudgeIdempotencyConflict("评分命令已绑定其他内容。")
        if receipt.status == JudgeScoreReceipt.Status.SUCCEEDED and receipt.score_record_id:
            return JudgeScoreSubmission(
                receipt_id=receipt.pk,
                score_record_id=receipt.score_record_id,
                reason_code=receipt.result_code or "ACCEPTED",
                status=receipt.status,
            )
    if ScoreRecord._base_manager.filter(
        round=locked.contest_round,
        singer_id=performance.singer_id,
        judge_id=seat.panel_member.judge_id,
    ).exists():
        raise ValidationError("DUPLICATE_SCORE_FACT")
    current_operator = locked.operator
    if receipt is None:
        with authority_write(JUDGE_SCORE_SUBMISSION):
            receipt = JudgeScoreReceipt.objects.create(
                command_id=normalized_command_id,
                operation=f"{source}.submit",
                source=source,
                payload_hash=payload_hash,
                panel_snapshot=snapshot,
                seat=seat,
                performance=performance,
                operator=current_operator,
                status=JudgeScoreReceipt.Status.PENDING,
            )
    score_record = _materialize_score_facts(
        contest_round=locked.contest_round,
        performance=performance,
        judge=seat.panel_member.judge,
        snapshot=snapshot,
        seat=seat,
        command_id=normalized_command_id,
        normalized_payload=normalized_payload,
        source=source,
        source_reference=source_reference.strip(),
        is_test_data=locked.activity.is_test_mode,
    )
    with authority_write(JUDGE_SCORE_SUBMISSION):
        receipt.score_record = score_record
        receipt.status = JudgeScoreReceipt.Status.SUCCEEDED
        receipt.result_code = "ACCEPTED"
        receipt.completed_at = timezone.now()
        receipt.save(update_fields=["score_record", "status", "result_code", "completed_at"])
    _audit(
        operator=current_operator,
        action_type=audit_action,
        target=f"JudgeScoreReceipt:{receipt.pk}",
        new_value=json.dumps(
            {
                "score_record_id": score_record.pk,
                "source": source,
                "source_reference": source_reference.strip(),
                "payload_hash": payload_hash,
            },
            ensure_ascii=True,
            sort_keys=True,
        ),
        note=reason.strip(),
    )
    return JudgeScoreSubmission(
        receipt_id=receipt.pk,
        score_record_id=score_record.pk,
        reason_code="ACCEPTED",
        status=receipt.status,
    )


@transaction.atomic
def submit_staff_proxy_score(
    round_id: int,
    performance_id: object,
    seat_id: object,
    *,
    operator,
    command_id: object,
    expected_context_version: object,
    score_payload: object,
    source_reference: str,
    reason: str,
) -> JudgeScoreSubmission:
    return _submit_staff_bound_score(
        round_id,
        performance_id,
        seat_id,
        operator=operator,
        command_id=command_id,
        expected_context_version=expected_context_version,
        score_payload=score_payload,
        source=ScoreSource.STAFF_PROXY,
        source_reference=source_reference,
        reason=reason,
        audit_action=AuditLog.ActionType.JUDGE_SCORE_PROXY,
    )


@transaction.atomic
def submit_paper_score(
    round_id: int,
    performance_id: object,
    seat_id: object,
    *,
    operator,
    command_id: object,
    expected_context_version: object,
    score_payload: object,
    paper_reference: str,
    reason: str,
) -> JudgeScoreSubmission:
    return _submit_staff_bound_score(
        round_id,
        performance_id,
        seat_id,
        operator=operator,
        command_id=command_id,
        expected_context_version=expected_context_version,
        score_payload=score_payload,
        source=ScoreSource.PAPER_DR,
        source_reference=paper_reference,
        reason=reason,
        audit_action=AuditLog.ActionType.JUDGE_SCORE_PAPER,
    )


@transaction.atomic
def get_judge_context(raw_ephemeral_token: str) -> JudgeContext:
    locked = _locked_judge_transport(raw_ephemeral_token)
    session = _authenticate_judge_session_locked(raw_ephemeral_token, locked)
    run_state = (
        PerformanceRunState.objects.select_for_update()
        .filter(round_id=session.panel_snapshot.round_id)
        .first()
    )
    if run_state is None:
        raise ValidationError("评委现场上下文尚未建立。")

    contest_round = session.panel_snapshot.round
    performance = None
    if run_state.current_performance_id is not None:
        performance = (
            Performance._base_manager.select_related("singer")
            .filter(
                pk=run_state.current_performance_id,
                round_id=session.panel_snapshot.round_id,
                activity_id=session.panel_snapshot.activity_id,
            )
            .first()
        )
        if performance is None:
            raise ValidationError("评委现场上下文尚未建立。")

    rubric_payload: dict[str, object] = {}
    rubric = contest_round.rubric
    if rubric is not None:
        rubric_payload = {
            "name": rubric.name,
            "criteria": [
                {
                    "criterion_id": criterion.pk,
                    "name": criterion.name,
                    "description": criterion.description,
                    "max_score": str(criterion.max_score),
                    "sequence": criterion.sequence,
                }
                for criterion in rubric.criteria.all().order_by("sequence", "pk")
            ],
        }
    return JudgeContext(
        activity_id=session.panel_snapshot.activity_id,
        round_id=session.panel_snapshot.round_id,
        round_name=contest_round.name or contest_round.get_round_type_display(),
        seat_id=session.seat_id,
        panel_snapshot_id=session.panel_snapshot_id,
        panel_version=session.panel_snapshot.version,
        context_version=run_state.context_version,
        performance_id=run_state.current_performance_id,
        performance_label=(f"第 {performance.sequence} 个节目" if performance else None),
        singer_name=(performance.singer.name if performance else None),
        song_title=(performance.song_title if performance else None),
        performance_state=run_state.state,
        rubric_payload=rubric_payload,
    )
