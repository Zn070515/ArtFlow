from common.audit import client_ip, log_action
from common.authority import ACCOUNT_AUTHORITY, authority_write
from common.models import AuditLog
from common.rate_limit import allow
from django import forms
from django.contrib.auth import login, logout, update_session_auth_hash
from django.contrib.auth.decorators import login_required
from django.contrib.auth.forms import PasswordChangeForm
from django.contrib.auth.views import redirect_to_login
from django.core.exceptions import ValidationError
from django.http import HttpRequest
from django.shortcuts import get_object_or_404, redirect, render
from django.urls import reverse
from django.utils.http import url_has_allowed_host_and_scheme
from django.views.decorators.http import require_GET, require_POST

from .forms import (
    AdminLoginForm,
    AdminPasswordResetForm,
    AdminRegisterForm,
    ParticipantLoginForm,
    ParticipantRegisterForm,
    StaffLoginForm,
    StaffRegisterForm,
)
from .models import User
from .services import (
    admin_verification_is_valid,
    mark_admin_verified,
    register_admin_account,
    register_participant_account,
    register_staff_account,
)

CREDENTIAL_LOGIN_RATE_LIMIT = 10
CREDENTIAL_LOGIN_RATE_WINDOW_SECONDS = 300
CREDENTIAL_LOGIN_IP_RATE_LIMIT = 100
# Campus and event Wi-Fi often shares one egress IP across many participants;
# keep abuse bounded without making a normal group registration burst fail.
REGISTRATION_RATE_LIMIT = 120
REGISTRATION_RATE_WINDOW_SECONDS = 600


def _allow_form_submission(
    request: HttpRequest,
    form: forms.BaseForm,
    *,
    key_prefix: str,
    limit: int,
    window_seconds: int,
    identity: str = "",
    aggregate_limit: int | None = None,
) -> bool:
    ip = client_ip(request) or "unknown"
    normalized_identity = identity.strip().casefold()
    key = (
        f"{key_prefix}:{ip}:{normalized_identity}" if normalized_identity else f"{key_prefix}:{ip}"
    )
    decision = allow(
        key,
        limit=limit,
        window_seconds=window_seconds,
    )
    if not decision.allowed:
        form.add_error(None, "尝试次数过多，请稍后再试。")
        return False
    if normalized_identity and aggregate_limit is not None:
        aggregate_decision = allow(
            f"{key_prefix}:ip:{ip}",
            limit=aggregate_limit,
            window_seconds=window_seconds,
        )
        if not aggregate_decision.allowed:
            form.add_error(None, "尝试次数过多，请稍后再试。")
            return False
    return True


def _registration_view(
    request: HttpRequest,
    *,
    form_class,
    account_service,
    role_title: str,
    role_description: str,
    login_url_name: str,
):
    if request.user.is_authenticated:
        return redirect("public_portal:home")
    if request.method == "POST":
        form = form_class(request.POST)
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
            try:
                user = account_service(
                    username=form.cleaned_data["username"],
                    password=form.cleaned_data["password1"],
                    **(
                        {"access_key": form.cleaned_data["access_key"]}
                        if "access_key" in form.cleaned_data
                        else {}
                    ),
                )
            except ValidationError as error:
                form.add_error(None, error.messages)
            else:
                login(request, user)
                if user.is_admin:
                    mark_admin_verified(request.session)
                return redirect(
                    "staff:dashboard" if user.is_staff_or_admin else "public_portal:home"
                )
    else:
        form = form_class()
    return render(
        request,
        "accounts/register.html",
        {
            "form": form,
            "role_title": role_title,
            "role_description": role_description,
            "login_url": reverse(login_url_name),
        },
    )


def participant_register_view(request):
    return _registration_view(
        request,
        form_class=ParticipantRegisterForm,
        account_service=register_participant_account,
        role_title="选手注册",
        role_description="创建账号后即可报名并管理自己的活动资料。",
        login_url_name="accounts:participant_login",
    )


def staff_register_view(request):
    return _registration_view(
        request,
        form_class=StaffRegisterForm,
        account_service=register_staff_account,
        role_title="工作人员注册",
        role_description="使用活动负责人提供的工作人员密钥创建运营账号。",
        login_url_name="accounts:staff_login",
    )


def admin_register_view(request):
    return _registration_view(
        request,
        form_class=AdminRegisterForm,
        account_service=register_admin_account,
        role_title="管理员注册",
        role_description="使用系统负责人提供的管理员密钥创建管理账号。",
        login_url_name="accounts:admin_login",
    )


def _safe_next_url(request: HttpRequest) -> str:
    candidate = request.POST.get("next", "") or request.GET.get("next", "")
    if candidate and url_has_allowed_host_and_scheme(
        candidate,
        allowed_hosts={request.get_host()},
        require_https=request.is_secure(),
    ):
        return candidate
    return ""


def _redirect_after_login(request: HttpRequest, default_url: str):
    return redirect(_safe_next_url(request) or default_url)


def _role_login_view(
    request: HttpRequest,
    *,
    form_class,
    template_name: str,
    key_prefix: str,
    limit: int,
    window_seconds: int,
    aggregate_limit: int,
    default_url: str,
):
    if request.user.is_authenticated:
        return redirect("public_portal:home")

    if request.method == "POST":
        form = form_class(request, data=request.POST)
        if (
            _allow_form_submission(
                request,
                form,
                key_prefix=key_prefix,
                limit=limit,
                window_seconds=window_seconds,
                identity=str(request.POST.get("username", "")),
                aggregate_limit=aggregate_limit,
            )
            and form.is_valid()
        ):
            user = form.get_user()
            login(request, user)
            log_action(request, AuditLog.ActionType.LOGIN, f"User:{user.pk}")
            return _redirect_after_login(request, default_url)
    else:
        form = form_class()
    return render(
        request,
        template_name,
        {"form": form, "next": _safe_next_url(request)},
    )


@require_GET
def login_view(request):
    if request.user.is_authenticated:
        return redirect("public_portal:home")
    return render(request, "accounts/login.html", {"next": _safe_next_url(request)})


def participant_login_view(request):
    return _role_login_view(
        request,
        form_class=ParticipantLoginForm,
        template_name="accounts/participant_login.html",
        key_prefix="credential-login",
        limit=CREDENTIAL_LOGIN_RATE_LIMIT,
        window_seconds=CREDENTIAL_LOGIN_RATE_WINDOW_SECONDS,
        aggregate_limit=CREDENTIAL_LOGIN_IP_RATE_LIMIT,
        default_url=reverse("public_portal:home"),
    )


def staff_login_view(request):
    return _role_login_view(
        request,
        form_class=StaffLoginForm,
        template_name="accounts/staff_login.html",
        key_prefix="credential-login",
        limit=CREDENTIAL_LOGIN_RATE_LIMIT,
        window_seconds=CREDENTIAL_LOGIN_RATE_WINDOW_SECONDS,
        aggregate_limit=CREDENTIAL_LOGIN_IP_RATE_LIMIT,
        default_url=reverse("staff:dashboard"),
    )


def admin_login_view(request):
    if request.user.is_authenticated:
        if request.user.is_admin and admin_verification_is_valid(request.session):
            return _redirect_after_login(request, reverse("staff:dashboard"))
        if not request.user.is_admin:
            return redirect("public_portal:home")

    if request.method == "POST":
        form = AdminLoginForm(request, data=request.POST)
        if (
            _allow_form_submission(
                request,
                form,
                key_prefix="credential-login",
                limit=CREDENTIAL_LOGIN_RATE_LIMIT,
                window_seconds=CREDENTIAL_LOGIN_RATE_WINDOW_SECONDS,
                identity=str(request.POST.get("username", "")),
                aggregate_limit=CREDENTIAL_LOGIN_IP_RATE_LIMIT,
            )
            and form.is_valid()
        ):
            user = form.get_user()
            login(request, user)
            mark_admin_verified(request.session)
            log_action(request, AuditLog.ActionType.LOGIN, f"User:{user.pk}", note="admin_login")
            return _redirect_after_login(request, reverse("staff:dashboard"))
    else:
        form = AdminLoginForm()
    return render(
        request,
        "accounts/admin_login.html",
        {"form": form, "next": _safe_next_url(request)},
    )


@require_POST
def logout_view(request):
    logout(request)
    return redirect("public_portal:home")


@login_required
def profile_view(request):
    return render(request, "accounts/profile.html")


@login_required
def password_change_view(request):
    form = PasswordChangeForm(request.user, request.POST or None)
    if request.method == "POST" and form.is_valid():
        user = form.save()
        update_session_auth_hash(request, user)
        log_action(
            request,
            AuditLog.ActionType.OTHER,
            f"User:{user.pk}",
            note="password_change",
        )
        return redirect("accounts:profile")
    return render(request, "accounts/password_change.html", {"form": form})


@login_required
def admin_password_reset_view(request, user_id):
    if not request.user.is_admin or not admin_verification_is_valid(request.session):
        return redirect_to_login(request.get_full_path(), reverse("accounts:admin_login"))
    actor = User.objects.filter(pk=request.user.pk, is_active=True).first()
    if actor is None or not actor.is_admin:
        return redirect_to_login(request.get_full_path(), reverse("accounts:admin_login"))
    target = get_object_or_404(User, pk=user_id)
    form = AdminPasswordResetForm(request.POST or None, user=target)
    if request.method == "POST" and form.is_valid():
        with authority_write(ACCOUNT_AUTHORITY):
            target.set_password(form.cleaned_data["new_password1"])
            target.save(update_fields=["password"])
        log_action(
            request,
            AuditLog.ActionType.OTHER,
            f"User:{target.pk}",
            note="admin_password_reset",
        )
        return redirect("accounts:profile")
    return render(
        request,
        "accounts/admin_password_reset.html",
        {"form": form, "target": target},
    )
