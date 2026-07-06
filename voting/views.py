from datetime import timedelta

from django.shortcuts import get_object_or_404, redirect, render
from django.utils import timezone
from django.views.decorators.http import require_POST

from common.audit import client_ip

from .models import VoteOption, VoteRecord, VoteSession


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

    return render(request, "voting/vote_entry.html", {
        "vote_session": vote_session,
        "error": error,
        "now": now,
    })


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
    elif VoteRecord.objects.filter(
        vote_session=vote_session,
        browser_session_key=session_key,
    ).exists():
        return redirect("voting:vote_done", pk=pk)

    options = vote_session.options.select_related("singer")
    max_sel = vote_session.max_selections if vote_session.selection_type == VoteSession.SelectionType.MULTI else 1

    if request.method == "POST" and not error:
        selected = request.POST.getlist("selected_option")
        ip = client_ip(request) or "0.0.0.0"
        if VoteRecord.objects.filter(
            vote_session=vote_session,
            ip_address=ip,
            created_at__gte=now - timedelta(seconds=10),
        ).exists():
            error = "投票过于频繁，请稍后再试"
        if not selected:
            error = "请选择至少一个候选项"
        if not error:
            for opt_pk in selected[:max_sel]:
                if VoteOption.objects.filter(pk=opt_pk, vote_session=vote_session).exists():
                    VoteRecord.objects.create(
                        vote_session=vote_session,
                        vote_option_id=opt_pk,
                        browser_session_key=session_key,
                        ip_address=ip,
                    )
            return redirect("voting:vote_done", pk=pk)

    return render(request, "voting/vote_cast.html", {
        "vote_session": vote_session,
        "options": options,
        "max_selections": max_sel,
        "is_multi": vote_session.selection_type == VoteSession.SelectionType.MULTI,
        "error": error,
    })


def vote_done(request, pk):
    vote_session = get_object_or_404(VoteSession, pk=pk)
    return render(request, "voting/vote_done.html", {"vote_session": vote_session})
