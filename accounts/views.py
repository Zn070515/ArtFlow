from common.audit import client_ip, log_action
from common.models import AuditLog
from common.rate_limit import allow
from django import forms
from django.contrib.auth import login, logout
from django.contrib.auth.decorators import login_required
from django.core.exceptions import ValidationError
from django.http import Http404, HttpRequest
from django.shortcuts import redirect, render
from django.utils.http import url_has_allowed_host_and_scheme
from django.views.decorators.http import require_POST

from .forms import AdminLoginForm, FirstAdminSetupForm, ParticipantLoginForm, RegisterForm
from .services import (
    admin_verification_is_valid,
    installation_provisioning_status,
    mark_admin_verified,
    provision_first_admin,
)

PARTICIPANT_LOGIN_RATE_LIMIT = 10
PARTICIPANT_LOGIN_RATE_WINDOW_SECONDS = 300
REGISTRATION_RATE_LIMIT = 10
REGISTRATION_RATE_WINDOW_SECONDS = 600
ADMIN_LOGIN_RATE_LIMIT = 10
ADMIN_LOGIN_RATE_WINDOW_SECONDS = 300
FIRST_ADMIN_SETUP_RATE_LIMIT = 10
FIRST_ADMIN_SETUP_RATE_WINDOW_SECONDS = 300


def _allow_form_submission(
    request: HttpRequest,
    form: forms.BaseForm,
    *,
    key_prefix: str,
    limit: int,
    window_seconds: int,
) -> bool:
    decision = allow(
        f"{key_prefix}:{client_ip(request) or 'unknown'}",
        limit=limit,
        window_seconds=window_seconds,
    )
    if not decision.allowed:
        form.add_error(None, "尝试次数过多，请稍后再试。")
        return False
    return True


def register_view(request):
    if request.user.is_authenticated:
        return redirect("public_portal:home")
    if request.method == "POST":
        form = RegisterForm(request.POST)
        if (
            _allow_form_submission(
                request,
                form,
                key_prefix="register",
                limit=REGISTRATION_RATE_LIMIT,
                window_seconds=REGISTRATION_RATE_WINDOW_SECONDS,
            )
            and form.is_valid()
        ):
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
        if (
            _allow_form_submission(
                request,
                form,
                key_prefix="participant-login",
                limit=PARTICIPANT_LOGIN_RATE_LIMIT,
                window_seconds=PARTICIPANT_LOGIN_RATE_WINDOW_SECONDS,
            )
            and form.is_valid()
        ):
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
        if (
            _allow_form_submission(
                request,
                form,
                key_prefix="admin-login",
                limit=ADMIN_LOGIN_RATE_LIMIT,
                window_seconds=ADMIN_LOGIN_RATE_WINDOW_SECONDS,
            )
            and form.is_valid()
        ):
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
        form = AdminLoginForm()
    return render(request, "accounts/admin_login.html", {"form": form})


def first_admin_setup_view(request):
    if installation_provisioning_status() != "required":
        raise Http404

    if request.method == "POST":
        form = FirstAdminSetupForm(request.POST)
        if (
            _allow_form_submission(
                request,
                form,
                key_prefix="first-admin-setup",
                limit=FIRST_ADMIN_SETUP_RATE_LIMIT,
                window_seconds=FIRST_ADMIN_SETUP_RATE_WINDOW_SECONDS,
            )
            and form.is_valid()
        ):
            try:
                user = provision_first_admin(
                    username=form.cleaned_data["username"],
                    password=form.cleaned_data["password"],
                )
            except ValidationError as error:
                form.add_error(None, error.messages)
            else:
                login(request, user)
                mark_admin_verified(request.session)
                return redirect("staff:dashboard")
    else:
        form = FirstAdminSetupForm()
    return render(request, "accounts/first_admin_setup.html", {"form": form})


@require_POST
def logout_view(request):
    logout(request)
    return redirect("public_portal:home")


@login_required
def profile_view(request):
    return render(request, "accounts/profile.html")
