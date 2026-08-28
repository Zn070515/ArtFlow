from functools import wraps

from django.contrib.auth.views import redirect_to_login
from django.core.exceptions import PermissionDenied
from django.urls import reverse


def staff_required(view_func):
    @wraps(view_func)
    def wrapped(request, *args, **kwargs):
        if not request.user.is_authenticated:
            return redirect_to_login(request.get_full_path(), reverse("accounts:login"))
        if not request.user.is_staff_or_admin:
            raise PermissionDenied
        return view_func(request, *args, **kwargs)

    return wrapped


def admin_required(view_func):
    @wraps(view_func)
    def wrapped(request, *args, **kwargs):
        if not request.user.is_authenticated:
            return redirect_to_login(request.get_full_path(), reverse("accounts:login"))
        if not request.user.is_admin:
            raise PermissionDenied
        if not request.session.get("artflow_admin_verified"):
            return redirect_to_login(request.get_full_path(), reverse("accounts:admin_login"))
        return view_func(request, *args, **kwargs)

    return wrapped
