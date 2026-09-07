from common.audit import client_ip
from common.rate_limit import allow
from core.models import Activity
from django.core.exceptions import ValidationError
from django.http import Http404
from django.shortcuts import get_object_or_404, redirect, render
from django.utils import timezone

from .models import VoteBallot, VoteSession
from .services import submit_ballot


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


def vote_entry(request, pk):
    vote_session = _get_vote_session_for_public_request(request, pk)
    now = timezone.now()
    error = None

    if request.method == "POST":
        passcode = request.POST.get("passcode", "").strip()
        if passcode != vote_session.passcode:
            error = "口令错误"
            if not _vote_rate_limit_decision(request, pk).allowed:
                error = "尝试次数过多，请稍后再试。"
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
        },
    )


def vote_cast(request, pk):
    vote_session = _get_vote_session_for_public_request(request, pk)
    now = timezone.now()
    session_key = request.session.session_key
    if not session_key:
        request.session.create()
        session_key = request.session.session_key

    if request.session.get("vote_passcode_ok") != str(pk):
        return redirect("voting:vote_entry", pk=pk)

    error = None
    if not vote_session.is_open or vote_session.is_locked:
        error = "投票尚未开放或已锁定"
    elif now < vote_session.start_time:
        error = "投票尚未开始"
    elif now > vote_session.end_time:
        error = "投票已结束"
    elif VoteBallot.objects.filter(
        vote_session=vote_session,
        browser_session_key=session_key,
    ).exists():
        return redirect("voting:vote_done", pk=pk)

    options = vote_session.options.select_related("singer")
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
        },
    )


def vote_done(request, pk):
    vote_session = _get_vote_session_for_public_request(request, pk)
    return render(request, "voting/vote_done.html", {"vote_session": vote_session})
