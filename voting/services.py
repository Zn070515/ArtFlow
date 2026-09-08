from __future__ import annotations

from datetime import timedelta

from accounts.services import require_current_admin, require_current_staff
from common.authority import VOTE_SESSION_STATE, authority_write
from common.models import AuditLog
from common.test_data import lock_activity_for_runtime_data
from core.policies import ActivityAction, ensure_activity_action_allowed
from core.services import lock_activity_for_action
from django.core.exceptions import PermissionDenied, ValidationError
from django.db import IntegrityError, transaction
from django.utils import timezone
from tickets.models import Ticket, TicketAccessSession

from .models import VoteBallot, VoteOption, VoteRecord, VoteSession


def _locked_ticket_for_vote(
    vote_session: VoteSession,
    ticket_session: TicketAccessSession | None,
) -> Ticket | None:
    if not vote_session.requires_ticket:
        return None
    if ticket_session is None:
        raise ValidationError("请先核验入场票。")
    access_session = (
        TicketAccessSession.objects.select_for_update()
        .select_related("ticket")
        .filter(pk=ticket_session.pk)
        .first()
    )
    now = timezone.now()
    if (
        access_session is None
        or access_session.revoked_at is not None
        or access_session.expires_at <= now
    ):
        raise ValidationError("票据会话无效。")
    ticket = Ticket.objects.select_for_update().filter(pk=access_session.ticket_id).first()
    if (
        ticket is None
        or ticket.activity_id != vote_session.activity_id
        or ticket.state != Ticket.State.CHECKED_IN
    ):
        raise ValidationError("票据无效。")
    return ticket


def submit_ballot(
    vote_session: VoteSession,
    *,
    browser_session_key: str,
    option_ids,
    ip_address: str,
    ticket_session: TicketAccessSession | None = None,
):
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
        locked_activity = lock_activity_for_runtime_data(vote_session.activity)
        ensure_activity_action_allowed(locked_activity, ActivityAction.CAST_VOTE)
        if locked_activity.is_locked:
            raise ValidationError("投票尚未开放或已锁定。")
        locked_session = VoteSession.objects.select_for_update().get(pk=vote_session.pk)
        now = timezone.now()
        if not locked_session.is_open or locked_session.is_locked:
            raise ValidationError("投票尚未开放或已锁定。")
        if now < locked_session.start_time or now > locked_session.end_time:
            raise ValidationError("当前不在投票时间内。")
        ticket = _locked_ticket_for_vote(locked_session, ticket_session)
        ticket_ballot = (
            VoteBallot.objects.filter(vote_session=locked_session, ticket=ticket).first()
            if ticket is not None
            else None
        )
        if ticket_ballot:
            return ticket_ballot
        ballot = VoteBallot.objects.filter(
            vote_session=locked_session, browser_session_key=browser_session_key
        ).first()
        if ballot:
            if ticket is not None and ballot.ticket_id != ticket.pk:
                raise ValidationError("该浏览器会话已使用其他入场票投票。")
            return ballot
        try:
            with transaction.atomic():
                ballot = VoteBallot.objects.create(
                    vote_session=locked_session,
                    ticket=ticket,
                    browser_session_key=browser_session_key,
                    ip_address=ip_address,
                    is_test_data=locked_activity.is_test_mode,
                )
        except IntegrityError:
            if ticket is not None:
                ticket_ballot = VoteBallot.objects.filter(
                    vote_session=locked_session, ticket=ticket
                ).first()
                if ticket_ballot:
                    return ticket_ballot
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
    return lock_activity_for_action(activity, ActivityAction.MANAGE_VOTE)


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
    current_operator = require_current_staff(operator)
    with transaction.atomic():
        _locked_runtime_activity(vote_session.activity)
        locked = _locked_vote_session(vote_session)
        if locked.is_locked:
            raise PermissionDenied("投票已锁定，无法开放。")
        if locked.is_open:
            return locked
        locked.is_open = True
        with authority_write(VOTE_SESSION_STATE):
            locked.save(update_fields=["is_open"])
        _audit_vote_state(
            locked,
            current_operator,
            AuditLog.ActionType.VOTE_MANAGE,
            "is_open=false",
            "is_open=true",
        )
        return locked


def close_vote_session(vote_session, operator):
    current_operator = require_current_staff(operator)
    with transaction.atomic():
        _locked_runtime_activity(vote_session.activity)
        locked = _locked_vote_session(vote_session)
        if not locked.is_open:
            return locked
        locked.is_open = False
        with authority_write(VOTE_SESSION_STATE):
            locked.save(update_fields=["is_open"])
        _audit_vote_state(
            locked,
            current_operator,
            AuditLog.ActionType.VOTE_MANAGE,
            "is_open=true",
            "is_open=false",
        )
        return locked


def lock_vote_session(vote_session, operator):
    current_operator = require_current_staff(operator)
    with transaction.atomic():
        _locked_runtime_activity(vote_session.activity)
        locked = _locked_vote_session(vote_session)
        if locked.is_locked:
            return locked
        locked.is_locked = True
        locked.is_open = False
        with authority_write(VOTE_SESSION_STATE):
            locked.save(update_fields=["is_locked", "is_open"])
        _audit_vote_state(
            locked,
            current_operator,
            AuditLog.ActionType.RELOCK_RESULT,
            "is_locked=false",
            "is_locked=true",
        )
        return locked


def unlock_vote_session(vote_session, operator, *, note: str = ""):
    current_operator = require_current_admin(operator)
    with transaction.atomic():
        _locked_runtime_activity(vote_session.activity)
        locked = _locked_vote_session(vote_session)
        if not locked.is_locked:
            return locked
        from singer_contest.services import ensure_vote_not_consumed_by_confirmed_stage

        ensure_vote_not_consumed_by_confirmed_stage(locked)
        locked.is_locked = False
        with authority_write(VOTE_SESSION_STATE):
            locked.save(update_fields=["is_locked"])
        _audit_vote_state(
            locked,
            current_operator,
            AuditLog.ActionType.UNLOCK_RESULT,
            "is_locked=true",
            "is_locked=false",
            note=note,
        )
        return locked
