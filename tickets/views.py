from __future__ import annotations

import json
from typing import Any

from accounts.decorators import admin_required, staff_required
from common.audit import client_ip
from common.rate_limit import allow
from core.models import Activity
from django.conf import settings
from django.core.exceptions import PermissionDenied, ValidationError
from django.http import HttpRequest, JsonResponse
from django.shortcuts import get_object_or_404, render
from django.views.decorators.csrf import csrf_exempt
from django.views.decorators.http import require_GET, require_POST

from .models import Ticket
from .services import (
    TicketRequestMeta,
    check_in_ticket,
    create_ticket,
    issue_ticket,
    redeem_ticket,
    revoke_ticket,
    void_ticket,
)

BODY_MAX_BYTES = 4096
REDEEM_RATE_LIMIT = 30
REDEEM_RATE_WINDOW_SECONDS = 60


class RequestBodyTooLarge(Exception):
    pass


def _json_payload(request: HttpRequest) -> dict[str, Any]:
    content_length = request.META.get("CONTENT_LENGTH")
    try:
        declared_length = int(content_length) if content_length else 0
    except (TypeError, ValueError):
        declared_length = 0
    if declared_length > BODY_MAX_BYTES or len(request.body or b"") > BODY_MAX_BYTES:
        raise RequestBodyTooLarge
    try:
        payload = json.loads(request.body or b"{}")
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise ValidationError("请求体不是有效 JSON。") from error
    if not isinstance(payload, dict):
        raise ValidationError("请求体必须是 JSON 对象。")
    return payload


def _invalid_response() -> JsonResponse:
    return _no_store(
        JsonResponse({"detail": "票据操作无效。", "reason_code": "INVALID_TICKET"}, status=400)
    )


def _too_large_response() -> JsonResponse:
    return _no_store(
        JsonResponse({"detail": "请求体过大。", "reason_code": "REQUEST_TOO_LARGE"}, status=413)
    )


def _rate_limited_response(retry_after_seconds: int) -> JsonResponse:
    response = JsonResponse(
        {"detail": "请求过于频繁，请稍后再试。", "reason_code": "RATE_LIMITED"},
        status=429,
    )
    response["Retry-After"] = str(max(1, retry_after_seconds))
    return _no_store(response)


def _no_store(response: JsonResponse) -> JsonResponse:
    response["Cache-Control"] = "no-store"
    return response


def _required_int(payload: dict[str, Any], key: str) -> int:
    value = payload[key]
    if isinstance(value, bool) or not isinstance(value, int):
        raise ValueError
    return value


def _required_text(payload: dict[str, Any], key: str) -> str:
    value = payload[key]
    if not isinstance(value, str) or not value:
        raise ValueError
    return value


@require_GET
def scan(request: HttpRequest):
    return render(request, "tickets/scan.html")


@csrf_exempt
@require_POST
def redeem(request: HttpRequest) -> JsonResponse:
    decision = allow(
        f"ticket-redeem:{client_ip(request) or 'unknown'}",
        limit=REDEEM_RATE_LIMIT,
        window_seconds=REDEEM_RATE_WINDOW_SECONDS,
    )
    if not decision.allowed:
        return _rate_limited_response(decision.retry_after_seconds)
    try:
        payload = _json_payload(request)
        raw_secret = _required_text(payload, "secret")
        result = redeem_ticket(
            raw_secret,
            request_meta=TicketRequestMeta(ip_address=client_ip(request)),
        )
    except RequestBodyTooLarge:
        return _too_large_response()
    except (KeyError, TypeError, ValueError, ValidationError):
        return _invalid_response()
    response = JsonResponse(
        {
            "activity_id": result.session.ticket.activity_id,
            "expires_at": result.session.expires_at.isoformat(),
        }
    )
    response.set_cookie(
        "artflow_ticket_session",
        result.token,
        max_age=max(
            1, int((result.session.expires_at - result.session.created_at).total_seconds())
        ),
        httponly=True,
        secure=getattr(settings, "APP_ENV", "development") == "production",
        samesite="Lax",
    )
    response["Cache-Control"] = "no-store"
    return response


@staff_required
@require_GET
def ticket_list(request: HttpRequest) -> JsonResponse:
    activity_id = request.GET.get("activity_id")
    tickets = Ticket.objects.all()
    if activity_id:
        tickets = tickets.filter(activity_id=activity_id)
    rows = [
        {
            "ticket_id": ticket.pk,
            "activity_id": ticket.activity_id,
            "batch_reference": ticket.batch_reference,
            "serial_number": ticket.serial_number,
            "state": ticket.state,
            "issued_at": ticket.issued_at.isoformat() if ticket.issued_at else None,
            "checked_in_at": ticket.checked_in_at.isoformat() if ticket.checked_in_at else None,
        }
        for ticket in tickets.order_by("pk")
    ]
    return JsonResponse({"tickets": rows})


@staff_required
@require_POST
def issue(request: HttpRequest) -> JsonResponse:
    try:
        payload = _json_payload(request)
        activity = get_object_or_404(Activity, pk=_required_int(payload, "activity_id"))
        ticket = create_ticket(
            activity,
            actor=request.user,
            batch_reference=payload.get("batch_reference"),
            serial_number=payload.get("serial_number"),
        )
        result = issue_ticket(ticket, actor=request.user)
    except (KeyError, TypeError, ValueError, RequestBodyTooLarge, ValidationError):
        return _invalid_response()
    except PermissionDenied:
        raise
    return JsonResponse(
        {
            "ticket_id": result.ticket.pk,
            "state": result.ticket.state,
            "secret": result.secret,
            "qr_url": f"{request.build_absolute_uri('/tickets/scan/')}#{result.secret}",
        },
        status=201,
    )


@staff_required
@require_POST
def check_in(request: HttpRequest) -> JsonResponse:
    try:
        payload = _json_payload(request)
        ticket = check_in_ticket(
            _required_text(payload, "secret"),
            actor=request.user,
            request_meta=TicketRequestMeta(ip_address=client_ip(request)),
        )
    except (KeyError, TypeError, ValueError, RequestBodyTooLarge, ValidationError):
        return _invalid_response()
    return JsonResponse({"ticket_id": ticket.pk, "state": ticket.state})


@admin_required
@require_POST
def void(request: HttpRequest, ticket_id: int) -> JsonResponse:
    ticket = get_object_or_404(Ticket, pk=ticket_id)
    try:
        updated = void_ticket(ticket, actor=request.user)
    except ValidationError:
        return _invalid_response()
    return JsonResponse({"ticket_id": updated.pk, "state": updated.state})


@admin_required
@require_POST
def revoke(request: HttpRequest, ticket_id: int) -> JsonResponse:
    ticket = get_object_or_404(Ticket, pk=ticket_id)
    try:
        updated = revoke_ticket(ticket, actor=request.user)
    except ValidationError:
        return _invalid_response()
    return JsonResponse({"ticket_id": updated.pk, "state": updated.state})
