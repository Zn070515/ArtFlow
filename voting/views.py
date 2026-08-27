from common.audit import client_ip
from django.core.exceptions import ValidationError
from django.shortcuts import get_object_or_404, redirect, render
from django.utils import timezone

from .models import VoteBallot, VoteSession
from .services import submit_ballot


def vote_entry(request, pk):
    vote_session = get_object_or_404(VoteSession, pk=pk)
    now = timezone.now()
    error = None

    if request.method == "POST":
        passcode = request.POST.get("passcode", "").strip()
        if passcode != vote_session.passcode:
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
        },
    )


def vote_cast(request, pk):
    vote_session = get_object_or_404(VoteSession, pk=pk)
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
    vote_session = get_object_or_404(VoteSession, pk=pk)
    return render(request, "voting/vote_done.html", {"vote_session": vote_session})
