from __future__ import annotations

import json
from typing import Any

from django.conf import settings
from django.http import HttpRequest

from .models import AuditLog


def client_ip(request: HttpRequest) -> str | None:
    # X-Forwarded-For is spoofable if clients can reach the app directly. Only
    # trust it when a known reverse proxy that overwrites the client-supplied
    # header is deployed (TRUST_X_FORWARDED_FOR=true); otherwise use REMOTE_ADDR.
    if getattr(settings, "TRUST_X_FORWARDED_FOR", False):
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


def audit_export(
    request: HttpRequest,
    activity: Any | None,
    export_type: str,
    *,
    row_count: int | None = None,
) -> AuditLog:
    """Record a uniform EXPORT audit for any data export.

    `export_type` is a stable machine-readable label (e.g. "registration_list");
    the audit note carries the activity scope and row count so a later question
    like "who exported these phone numbers?" can be answered in one query.
    """
    details = {
        "export_type": export_type,
        "activity_id": activity.pk if activity else None,
        "row_count": row_count,
    }
    target = f"{export_type}: {activity.title}" if activity else export_type
    return AuditLog.objects.create(
        operator=request.user if request.user.is_authenticated else None,
        action_type=AuditLog.ActionType.EXPORT,
        target=target,
        note=json.dumps(details, ensure_ascii=False),
        ip_address=client_ip(request),
    )
