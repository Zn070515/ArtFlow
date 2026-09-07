from functools import wraps

from django.contrib.auth.views import redirect_to_login
from django.urls import reverse

from .services import admin_verification_is_valid, require_current_admin, require_current_staff


def staff_required(view_func):
    @wraps(view_func)
    def wrapped(request, *args, **kwargs):
        if not request.user.is_authenticated:
            return redirect_to_login(request.get_full_path(), reverse("accounts:login"))
        request.user = require_current_staff(request.user)
        return view_func(request, *args, **kwargs)

    return wrapped


def admin_required(view_func):
    @wraps(view_func)
    def wrapped(request, *args, **kwargs):
        if not request.user.is_authenticated:
            return redirect_to_login(request.get_full_path(), reverse("accounts:login"))
        request.user = require_current_admin(request.user)
        if not admin_verification_is_valid(request.session):
            return redirect_to_login(request.get_full_path(), reverse("accounts:admin_login"))
        return view_func(request, *args, **kwargs)

    return wrapped
