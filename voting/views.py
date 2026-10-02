from common.audit import client_ip
from common.rate_limit import allow
from core.models import Activity
from django.core.exceptions import ValidationError
from django.http import Http404
from django.shortcuts import get_object_or_404, redirect, render
from django.utils import timezone
from questionnaire.projection import generic_song_label, prime_questionnaire_answers
from tickets.services import authenticate_ticket_session

from .models import VoteBallot, VoteSession
from .services import submit_ballot


def _ticket_session_for_request(request, vote_session):
    if not vote_session.requires_ticket:
        return None
    raw_token = request.COOKIES.get("artflow_ticket_session")
    if not raw_token:
        return None
    try:
        return authenticate_ticket_session(raw_token, activity=vote_session.activity)
    except ValidationError:
        return None


def _uses_ticket_entry(vote_session: VoteSession) -> bool:
    # Legacy rows may still have a passcode and no ticket flag. New formal Singer
    # Contest rows are forced to ``requires_ticket=True`` at creation time.
    return vote_session.requires_ticket


def _get_vote_session_for_public_request(request, pk):
    """Activity-lifecycle boundary for a public vote session.

    A FORMAL session stays fully public. A TEST activity's session is only
    visible to authenticated staff/admin (rehearsal preview); everyone else gets
    a 404, never a "this activity is testing" message, so the test surface is
    indistinguishable from a missing vote. Must gate entry, cast, and done so a
    forged direct POST cannot reach submit_ballot.
    """
    vote_session = get_object_or_404(VoteSession.objects.select_related("activity"), pk=pk)
    if vote_session.activity.data_lifecycle != Activity.DataLifecycle.FORMAL and (
        not request.user.is_authenticated or not request.user.is_staff_or_admin
    ):
        raise Http404("Vote session not found.")
    return vote_session


def _vote_rate_limit_decision(request, pk):
    session_key = request.session.session_key
    if not session_key:
        request.session.create()
        session_key = request.session.session_key
    return allow(f"vote-passcode:{pk}:{session_key}", limit=10, window_seconds=300)


def _vote_ui_state(vote_session, now):
    if vote_session.activity.is_locked:
        return "activity_locked", "活动已锁定", False
    if vote_session.is_locked:
        return "locked", "投票已锁定", False
    if not vote_session.is_open:
        return "closed", "投票未开放", False
    if now < vote_session.start_time:
        return "not_started", "投票尚未开始", False
    if now > vote_session.end_time:
        return "ended", "投票已结束", False
    return "open", "投票进行中", True


def vote_entry(request, pk):
    vote_session = _get_vote_session_for_public_request(request, pk)
    now = timezone.now()
    error = None
    ticket_required = _uses_ticket_entry(vote_session)
    ticket_session = _ticket_session_for_request(request, vote_session) if ticket_required else None

    if ticket_required and ticket_session is not None:
        _, label, can_submit = _vote_ui_state(vote_session, now)
        if can_submit:
            return redirect("voting:vote_cast", pk=pk)
        error = label
    elif ticket_required:
        error = "请先到检票处核验入场票，再返回此页面。"
    elif request.method == "POST":
        passcode = request.POST.get("passcode", "").strip()
        if not _vote_rate_limit_decision(request, pk).allowed:
            error = "尝试次数过多，请稍后再试。"
        elif passcode != vote_session.passcode:
            error = "口令错误"
        elif not vote_session.is_open or vote_session.is_locked:
            error = "投票尚未开放或已锁定"
        elif now < vote_session.start_time:
            error = "投票尚未开始"
        elif now > vote_session.end_time:
            error = "投票已结束"
        else:
            request.session["vote_passcode_ok"] = str(pk)
            return redirect("voting:vote_cast", pk=pk)

    return render(
        request,
        "voting/vote_entry.html",
        {
            "vote_session": vote_session,
            "error": error,
            "now": now,
            "ticket_required": ticket_required,
        },
    )


def vote_cast(request, pk):
    vote_session = _get_vote_session_for_public_request(request, pk)
    now = timezone.now()
    session_key = request.session.session_key
    if not session_key:
        request.session.create()
        session_key = request.session.session_key

    ticket_required = _uses_ticket_entry(vote_session)
    if not ticket_required and request.session.get("vote_passcode_ok") != str(pk):
        return redirect("voting:vote_entry", pk=pk)

    vote_ui_state, vote_ui_label, can_submit = _vote_ui_state(vote_session, now)
    error = None
    ticket_session = _ticket_session_for_request(request, vote_session) if ticket_required else None
    if ticket_required and ticket_session is None:
        error = "请先核验入场票。"
        can_submit = False
    elif not can_submit:
        error = vote_ui_label
    elif (
        ticket_session is not None
        and VoteBallot.objects.filter(
            vote_session=vote_session, ticket_id=ticket_session.ticket_id
        ).exists()
    ):
        return redirect("voting:vote_done", pk=pk)
    elif (
        not vote_session.requires_ticket
        and VoteBallot.objects.filter(
            vote_session=vote_session, browser_session_key=session_key
        ).exists()
    ):
        return redirect("voting:vote_done", pk=pk)

    options = list(vote_session.options.select_related("singer"))
    singers = prime_questionnaire_answers(option.singer for option in options)
    for singer in singers:
        singer.song_label = generic_song_label(singer)
    max_sel = (
        vote_session.max_selections
        if vote_session.selection_type == VoteSession.SelectionType.MULTI
        else 1
    )

    if request.method == "POST" and not error:
        selected = request.POST.getlist("selected_option")
        ip = client_ip(request) or "0.0.0.0"
        try:
            submit_ballot(
                vote_session,
                browser_session_key=session_key,
                option_ids=selected,
                ip_address=ip,
                ticket_session=ticket_session,
            )
        except ValidationError as validation_error:
            error = "；".join(validation_error.messages)
        else:
            return redirect("voting:vote_done", pk=pk)

    return render(
        request,
        "voting/vote_cast.html",
        {
            "vote_session": vote_session,
            "options": options,
            "max_selections": max_sel,
            "is_multi": vote_session.selection_type == VoteSession.SelectionType.MULTI,
            "error": error,
            "vote_ui_state": vote_ui_state,
            "vote_ui_label": vote_ui_label,
            "can_submit": can_submit,
        },
    )


def vote_done(request, pk):
    vote_session = _get_vote_session_for_public_request(request, pk)
    return render(
        request,
        "voting/vote_done.html",
        {
            "vote_session": vote_session,
            "live_url": (
                f"/e/{vote_session.activity.public_code}/live/"
                if vote_session.activity.public_code
                else None
            ),
        },
    )
