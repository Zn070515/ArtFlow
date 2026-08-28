from datetime import timedelta

from common.business_rules import ensure_activity_unlocked
from common.models import AuditLog
from common.test_data import lock_activity_for_runtime_data
from django.core.exceptions import PermissionDenied, ValidationError
from django.db import IntegrityError, transaction
from django.utils import timezone

from .models import VoteBallot, VoteOption, VoteRecord, VoteSession


def submit_ballot(vote_session, *, browser_session_key, option_ids, ip_address):
    if not browser_session_key:
        raise ValidationError("浏览器会话无效。")
    unique_ids = list(dict.fromkeys(str(option_id) for option_id in option_ids))
    if not unique_ids:
        raise ValidationError("请选择至少一个候选项。")
    if vote_session.selection_type == VoteSession.SelectionType.SINGLE and len(unique_ids) != 1:
        raise ValidationError("单选投票只能选择一个候选项。")
    if (
        vote_session.selection_type == VoteSession.SelectionType.MULTI
        and len(unique_ids) > vote_session.max_selections
    ):
        raise ValidationError(f"最多只能选择 {vote_session.max_selections} 项。")
    now = timezone.now()
    if not vote_session.is_open or vote_session.is_locked:
        raise ValidationError("投票尚未开放或已锁定。")
    if now < vote_session.start_time or now > vote_session.end_time:
        raise ValidationError("当前不在投票时间内。")

    options = list(
        VoteOption.objects.filter(vote_session=vote_session, pk__in=unique_ids).select_related(
            "singer"
        )
    )
    if len(options) != len(unique_ids):
        raise ValidationError("候选项不属于当前投票。")
    by_id = {str(option.pk): option for option in options}
    if any(option_id not in by_id for option_id in unique_ids):
        raise ValidationError("候选项不属于当前投票。")

    with transaction.atomic():
        locked_session = VoteSession.objects.select_for_update().get(pk=vote_session.pk)
        now = timezone.now()
        if not locked_session.is_open or locked_session.is_locked:
            raise ValidationError("投票尚未开放或已锁定。")
        if now < locked_session.start_time or now > locked_session.end_time:
            raise ValidationError("当前不在投票时间内。")
        locked_activity = lock_activity_for_runtime_data(locked_session.activity)
        ballot = VoteBallot.objects.filter(
            vote_session=locked_session, browser_session_key=browser_session_key
        ).first()
        if ballot:
            return ballot
        try:
            with transaction.atomic():
                ballot = VoteBallot.objects.create(
                    vote_session=locked_session,
                    browser_session_key=browser_session_key,
                    ip_address=ip_address,
                    is_test_data=locked_activity.is_test_mode,
                )
        except IntegrityError:
            return VoteBallot.objects.get(
                vote_session=locked_session, browser_session_key=browser_session_key
            )
        for option_id in unique_ids:
            option = by_id[option_id]
            VoteRecord.objects.create(
                ballot=ballot,
                vote_session=locked_session,
                vote_option=option,
                browser_session_key=browser_session_key,
                ip_address=ip_address,
                is_test_data=locked_activity.is_test_mode,
            )
        return ballot


def recent_ballot_from_ip(vote_session, ip_address):
    return VoteBallot.objects.filter(
        vote_session=vote_session,
        ip_address=ip_address,
        submitted_at__gte=timezone.now() - timedelta(seconds=10),
    ).count()


def _locked_vote_session(vote_session):
    return (
        VoteSession.objects.select_for_update().select_related("activity").get(pk=vote_session.pk)
    )


def _locked_runtime_activity(activity):
    locked_activity = lock_activity_for_runtime_data(activity)
    ensure_activity_unlocked(locked_activity)
    return locked_activity


def _audit_vote_state(vote_session, operator, action_type, old_value, new_value, *, note=""):
    return AuditLog.objects.create(
        operator=operator,
        action_type=action_type,
        target=f"VoteSession:{vote_session.pk}",
        old_value=old_value,
        new_value=new_value,
        note=note,
    )


def open_vote_session(vote_session, operator):
    with transaction.atomic():
        locked = _locked_vote_session(vote_session)
        _locked_runtime_activity(locked.activity)
        if locked.is_locked:
            raise PermissionDenied("投票已锁定，无法开放。")
        if locked.is_open:
            return locked
        locked.is_open = True
        locked.save(update_fields=["is_open"])
        _audit_vote_state(
            locked, operator, AuditLog.ActionType.VOTE_MANAGE, "is_open=false", "is_open=true"
        )
        return locked


def close_vote_session(vote_session, operator):
    with transaction.atomic():
        locked = _locked_vote_session(vote_session)
        _locked_runtime_activity(locked.activity)
        if not locked.is_open:
            return locked
        locked.is_open = False
        locked.save(update_fields=["is_open"])
        _audit_vote_state(
            locked, operator, AuditLog.ActionType.VOTE_MANAGE, "is_open=true", "is_open=false"
        )
        return locked


def lock_vote_session(vote_session, operator):
    with transaction.atomic():
        locked = _locked_vote_session(vote_session)
        _locked_runtime_activity(locked.activity)
        if locked.is_locked:
            return locked
        locked.is_locked = True
        locked.is_open = False
        locked.save(update_fields=["is_locked", "is_open"])
        _audit_vote_state(
            locked, operator, AuditLog.ActionType.RELOCK_RESULT, "is_locked=false", "is_locked=true"
        )
        return locked


def unlock_vote_session(vote_session, operator, *, note: str = ""):
    with transaction.atomic():
        locked = _locked_vote_session(vote_session)
        _locked_runtime_activity(locked.activity)
        if not locked.is_locked:
            return locked
        locked.is_locked = False
        locked.save(update_fields=["is_locked"])
        _audit_vote_state(
            locked,
            operator,
            AuditLog.ActionType.UNLOCK_RESULT,
            "is_locked=true",
            "is_locked=false",
            note=note,
        )
        return locked
