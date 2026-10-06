from __future__ import annotations

from datetime import timedelta
from decimal import ROUND_HALF_UP, Decimal

from accounts.services import require_current_admin, require_current_staff
from common.authority import VOTE_SCORING_RULE, VOTE_SESSION_STATE, authority_write
from common.models import AuditLog
from common.test_data import lock_activity_for_runtime_data
from core.policies import ActivityAction, ensure_activity_action_allowed
from core.services import lock_activity_for_action
from django.core.exceptions import PermissionDenied, ValidationError
from django.db import IntegrityError, transaction
from django.utils import timezone
from ruleset.services import require_runtime_readiness
from tickets.models import Ticket, TicketAccessSession

from .models import (
    VoteBallot,
    VoteOption,
    VoteRecord,
    VoteScoringRule,
    VoteSession,
    _ensure_scoring_rule_session_mutable,
)

# Support-rate quantization: four decimal places, ROUND_HALF_UP. The rule is explicit so a
# replay is byte-identical instead of inheriting whatever the ambient Decimal context says
# (0.0001 is far finer than the two decimals staff ever display).
SUPPORT_RATE_QUANTUM = Decimal("0.0001")


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
    normalized_ids: list[str] = []
    for option_id in option_ids:
        try:
            normalized_ids.append(str(int(option_id)))
        except (TypeError, ValueError):
            # The cast view renders the browser form, but a POST is not bound by that.
            # Passing a non-numeric value straight into `pk__in` raised a bare
            # ValueError, which the view does not catch, so a crafted option id came
            # back as a 500 instead of the ordinary rejection below.
            raise ValidationError("候选项不属于当前投票。") from None
    unique_ids = list(dict.fromkeys(normalized_ids))
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


def configure_vote_scoring_rule(
    vote_session, operator, *, mode: str | None = None
) -> VoteScoringRule:
    """Configure the conversion of a SCORE_COMPONENT vote session (§5.2 / §5.3).

    The conversion is meaning, not weight: the aggregate weight lives in the frozen
    ``RulesetVersion.definition``, so nothing here multiplies by an importance factor.
    Only a session declared as ``SCORE_COMPONENT`` with ticket checking enabled may carry a
    rule, and the rule freezes with the session — once it opens, locks, or is consumed by a
    frozen ruleset version, a different conversion requires a new rule and a new freeze
    rather than an in-place edit of historical authority.
    """
    current_operator = require_current_staff(operator)
    selected_mode = mode or VoteScoringRule.Mode.BALLOT_SHARE_PERCENT
    if selected_mode not in VoteScoringRule.Mode.values:
        raise ValidationError("无效的成绩换算方式。")
    with transaction.atomic():
        _locked_runtime_activity(vote_session.activity)
        locked = _locked_vote_session(vote_session)
        if locked.purpose != VoteSession.Purpose.SCORE_COMPONENT:
            raise ValidationError("只有「成绩组成」投票可以配置成绩换算规则。")
        if not locked.requires_ticket:
            raise ValidationError("正式成绩投票必须启用入场票校验。")
        _ensure_scoring_rule_session_mutable(locked.pk)
        rule = VoteScoringRule.objects.filter(vote_session_id=locked.pk).first()
        if rule is None:
            rule = VoteScoringRule(vote_session_id=locked.pk)
        rule.mode = selected_mode
        rule.output_scale = "hundred"
        rule.configured_by = current_operator
        with authority_write(VOTE_SCORING_RULE):
            rule.save()
        _audit_vote_state(
            locked,
            current_operator,
            AuditLog.ActionType.VOTE_MANAGE,
            "scoring_rule=<none>",
            f"scoring_rule={rule.pk}:{rule.mode}:{rule.output_scale}",
        )
        return rule


def ballot_share_percentages(
    vote_session: VoteSession, *, test_flag: bool
) -> dict[str, Decimal] | None:
    """The §5.4 conversion truth: ``candidate_valid_votes / valid_ballot_count * 100``.

    The denominator is the number of valid ballots in this session — never the number of
    vote records, never the sum of all candidates' votes, and never the number of allowed
    selections. A multi-select session therefore legitimately produces shares summing above
    100%. Candidates with no ballot are a real 0; a session with **no** valid ballot returns
    ``None`` (0/0 is not a zero score, so the caller holds instead of publishing).
    """
    valid_ballots = VoteBallot.objects.filter(
        vote_session=vote_session, is_test_data=test_flag
    ).count()
    if valid_ballots == 0:
        return None
    counts: dict[int, int] = {
        singer_id: 0
        for singer_id in VoteOption.objects.filter(vote_session=vote_session).values_list(
            "singer_id", flat=True
        )
    }
    records = VoteRecord.objects.filter(
        vote_session=vote_session, is_test_data=test_flag
    ).values_list("vote_option__singer_id", flat=True)
    for singer_id in records:
        counts[singer_id] = counts.get(singer_id, 0) + 1
    divisor = Decimal(valid_ballots)
    return {
        str(singer_id): (Decimal(n) / divisor * 100).quantize(
            SUPPORT_RATE_QUANTUM, rounding=ROUND_HALF_UP
        )
        for singer_id, n in counts.items()
    }


def vote_session_configuration_facts(vote_session: VoteSession, *, test_flag: bool) -> dict:
    """Read-only conversion facts for the staff verification panel (§9).

    Deliberately the same numbers the loader will publish: valid ballot count, per-candidate
    votes, support rate, conversion mode, session state and ticket requirement. Staff have to
    be able to reconcile the screen against the raw ballots by hand.
    """
    valid_ballots = VoteBallot.objects.filter(
        vote_session=vote_session, is_test_data=test_flag
    ).count()
    percentages = ballot_share_percentages(vote_session, test_flag=test_flag) or {}
    counts: dict[int, int] = {
        singer_id: 0
        for singer_id in VoteOption.objects.filter(vote_session=vote_session).values_list(
            "singer_id", flat=True
        )
    }
    for singer_id in VoteRecord.objects.filter(
        vote_session=vote_session, is_test_data=test_flag
    ).values_list("vote_option__singer_id", flat=True):
        counts[singer_id] = counts.get(singer_id, 0) + 1
    rule = VoteScoringRule.objects.filter(vote_session_id=vote_session.pk).first()
    return {
        "valid_ballots": valid_ballots,
        "candidate_votes": counts,
        "support_rate": percentages,
        "conversion_mode": rule.mode if rule else None,
        "requires_ticket": vote_session.requires_ticket,
        "is_open": vote_session.is_open,
        "is_locked": vote_session.is_locked,
    }


def open_vote_session(vote_session, operator):
    current_operator = require_current_staff(operator)
    with transaction.atomic():
        _locked_runtime_activity(vote_session.activity)
        locked = _locked_vote_session(vote_session)
        if locked.is_locked:
            raise PermissionDenied("投票已锁定，无法开放。")
        if locked.is_open:
            return locked
        if VoteSession.objects.filter(activity_id=locked.activity_id, is_open=True).exists():
            raise ValidationError("同一活动同时只能开放一个投票场次。")
        # P0-B runtime boundary: a score-component vote's candidate roster is a deferred
        # roster fact — it is proven here, before ballots can be cast against it.
        require_runtime_readiness(locked.activity)
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
