from common.audit import client_ip, log_action
from common.models import AuditLog
from common.rate_limit import RateLimitExceeded, hit_rate_limit
from django.contrib.auth import login, logout
from django.contrib.auth.decorators import login_required
from django.shortcuts import redirect, render
from django.utils.http import url_has_allowed_host_and_scheme
from django.views.decorators.http import require_POST

from .forms import AdminLoginForm, ParticipantLoginForm, RegisterForm
from .services import admin_verification_is_valid, mark_admin_verified


def register_view(request):
    if request.user.is_authenticated:
        return redirect("public_portal:home")
    if request.method == "POST":
        form = RegisterForm(request.POST)
        if form.is_valid():
            user = form.save()
            login(request, user)
            return redirect("public_portal:home")
    else:
        form = RegisterForm()
    return render(request, "accounts/register.html", {"form": form})


def login_view(request):
    if request.user.is_authenticated:
        return redirect("public_portal:home")

    next_url = request.GET.get("next", "")
    if request.method == "POST":
        form = ParticipantLoginForm(request, data=request.POST)
        if form.is_valid():
            user = form.get_user()
            login(request, user)
            log_action(request, AuditLog.ActionType.LOGIN, f"User:{user.pk}")
            if next_url and url_has_allowed_host_and_scheme(
                next_url, allowed_hosts={request.get_host()}
            ):
                return redirect(next_url)
            return redirect("staff:dashboard" if user.is_staff_or_admin else "public_portal:home")
    else:
        form = ParticipantLoginForm()
    return render(request, "accounts/login.html", {"form": form})


def admin_login_view(request):
    if request.user.is_authenticated:
        if request.user.is_admin and admin_verification_is_valid(request.session):
            return redirect("staff:dashboard")
        if not request.user.is_admin:
            return redirect("public_portal:home")

    next_url = request.GET.get("next", "")
    if request.method == "POST":
        form = AdminLoginForm(request, data=request.POST)
        if form.is_valid():
            user = form.get_user()
            login(request, user)
            mark_admin_verified(request.session)
            log_action(request, AuditLog.ActionType.LOGIN, f"User:{user.pk}", note="admin_login")
            if next_url and url_has_allowed_host_and_scheme(
                next_url, allowed_hosts={request.get_host()}
            ):
                return redirect(next_url)
            return redirect("staff:dashboard")
        else:
            try:
                hit_rate_limit(
                    f"admin-login:{client_ip(request) or 'unknown'}",
                    limit=10,
                    window_seconds=300,
                )
            except RateLimitExceeded:
                form.add_error(None, "尝试次数过多，请稍后再试。")
    else:
        form = AdminLoginForm()
    return render(request, "accounts/admin_login.html", {"form": form})


@require_POST
def logout_view(request):
    logout(request)
    return redirect("public_portal:home")


@login_required
def profile_view(request):
    return render(request, "accounts/profile.html")
