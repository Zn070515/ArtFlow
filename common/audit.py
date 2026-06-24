from .models import AuditLog


def client_ip(request):
    forwarded_for = request.META.get("HTTP_X_FORWARDED_FOR")
    if forwarded_for:
        return forwarded_for.split(",")[0].strip()
    return request.META.get("REMOTE_ADDR") or None


def log_action(request, action_type, target, *, old_value="", new_value="", note=""):
    return AuditLog.objects.create(
        operator=request.user if request.user.is_authenticated else None,
        action_type=action_type,
        target=target,
        old_value=old_value,
        new_value=new_value,
        ip_address=client_ip(request),
        note=note,
    )
