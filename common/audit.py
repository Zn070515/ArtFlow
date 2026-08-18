from django.http import HttpRequest

from .models import AuditLog


def client_ip(request: HttpRequest) -> str | None:
    forwarded_for = request.META.get("HTTP_X_FORWARDED_FOR")
    if isinstance(forwarded_for, str) and forwarded_for:
        return forwarded_for.split(",")[0].strip()
    remote_addr = request.META.get("REMOTE_ADDR")
    return remote_addr if isinstance(remote_addr, str) else None


def log_action(
    request: HttpRequest,
    action_type: str,
    target: str,
    *,
    old_value: str = "",
    new_value: str = "",
    note: str = "",
) -> AuditLog:
    return AuditLog.objects.create(
        operator=request.user if request.user.is_authenticated else None,
        action_type=action_type,
        target=target,
        old_value=old_value,
        new_value=new_value,
        ip_address=client_ip(request),
        note=note,
    )
