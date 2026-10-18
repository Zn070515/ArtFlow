from functools import wraps

from django.contrib import messages
from django.contrib.auth.views import redirect_to_login
from django.urls import reverse
from django.utils.http import url_has_allowed_host_and_scheme

from .services import admin_verification_is_valid, require_current_admin, require_current_staff


def _reauthentication_next_url(request) -> str:
    """Where to land after an admin re-verifies, for this request's method.

    Returning to the action URL only works for a GET. A POST-only view answers 405 to
    the GET a fresh login produces, which is exactly what an operator saw after their
    15-minute verification expired and they clicked "冻结赛制": login, then a bare
    ``HTTP 405``. For a POST, return to the page that rendered the form (same-host
    referer) so the button can be pressed again; fall back to the staff dashboard rather
    than to a URL that cannot answer GET.
    """

    if request.method != "POST":
        return request.get_full_path()
    referer = request.META.get("HTTP_REFERER", "")
    if referer and url_has_allowed_host_and_scheme(
        referer,
        allowed_hosts={request.get_host()},
        require_https=request.is_secure(),
    ):
        return referer
    return reverse("staff:dashboard")


def staff_required(view_func):
    @wraps(view_func)
    def wrapped(request, *args, **kwargs):
        if not request.user.is_authenticated:
            return redirect_to_login(request.get_full_path(), reverse("accounts:staff_login"))
        request.user = require_current_staff(request.user)
        return view_func(request, *args, **kwargs)

    return wrapped


def admin_required(view_func):
    @wraps(view_func)
    def wrapped(request, *args, **kwargs):
        if not request.user.is_authenticated:
            return redirect_to_login(request.get_full_path(), reverse("accounts:admin_login"))
        request.user = require_current_admin(request.user)
        if not admin_verification_is_valid(request.session):
            messages.info(
                request,
                "管理员验证已刷新，请回到刚才的页面重新点击该操作。",
            )
            return redirect_to_login(
                _reauthentication_next_url(request), reverse("accounts:admin_login")
            )
        return view_func(request, *args, **kwargs)

    return wrapped
