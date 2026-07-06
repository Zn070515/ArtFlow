from django.contrib.auth import login, logout
from django.contrib.auth.decorators import login_required
from django.shortcuts import redirect, render
from django.utils.http import url_has_allowed_host_and_scheme
from django.views.decorators.http import require_POST

from common.audit import log_action
from common.models import AuditLog

from .forms import AdminLoginForm, ParticipantLoginForm, RegisterForm


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
            if next_url and url_has_allowed_host_and_scheme(next_url, allowed_hosts={request.get_host()}):
                return redirect(next_url)
            return redirect("staff:dashboard" if user.is_staff_or_admin else "public_portal:home")
    else:
        form = ParticipantLoginForm()
    return render(request, "accounts/login.html", {"form": form})


def admin_login_view(request):
    if request.user.is_authenticated:
        return redirect("staff:dashboard" if request.user.is_staff_or_admin else "public_portal:home")

    next_url = request.GET.get("next", "")
    if request.method == "POST":
        form = AdminLoginForm(request, data=request.POST)
        if form.is_valid():
            user = form.get_user()
            login(request, user)
            log_action(request, AuditLog.ActionType.LOGIN, f"User:{user.pk}", note="admin_login")
            if next_url and url_has_allowed_host_and_scheme(next_url, allowed_hosts={request.get_host()}):
                return redirect(next_url)
            return redirect("staff:dashboard")
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
