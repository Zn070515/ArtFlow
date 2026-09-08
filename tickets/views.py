from __future__ import annotations

import json
from base64 import b64encode
from io import BytesIO
from typing import Any
from urllib.parse import quote

from accounts.decorators import admin_required, staff_required
from common.audit import client_ip
from common.rate_limit import allow
from core.models import Activity
from django.conf import settings
from django.contrib import messages
from django.core.exceptions import PermissionDenied, ValidationError
from django.db.models import Count
from django.http import HttpRequest, HttpResponse, JsonResponse
from django.shortcuts import get_object_or_404, redirect, render
from django.views.decorators.http import require_GET, require_POST

from .models import Ticket
from .services import (
    TicketRequestMeta,
    check_in_ticket,
    create_ticket,
    issue_ticket,
    issue_ticket_batch,
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


def _no_store(response: HttpResponse) -> HttpResponse:
    response["Cache-Control"] = "no-store"
    response["Pragma"] = "no-cache"
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


def _required_form_int(payload, key: str) -> int:
    value = payload.get(key)
    if not isinstance(value, str) or not value.strip():
        raise ValueError
    try:
        return int(value)
    except ValueError:
        raise ValueError from None


def _qr_data_uri(request: HttpRequest, secret: str) -> str:
    import qrcode

    target = f"{request.build_absolute_uri('/tickets/scan/')}#{quote(secret, safe='')}"
    image = qrcode.make(target)
    buffer = BytesIO()
    image.save(buffer, format="PNG")
    return f"data:image/png;base64,{b64encode(buffer.getvalue()).decode('ascii')}"


def _ticket_activities():
    return Activity.objects.order_by("-created_at", "-pk")


def _ticket_state_rows(queryset):
    counts = dict(
        queryset.values("state").annotate(total=Count("pk")).values_list("state", "total")
    )
    return [
        {"value": value, "label": label, "count": counts.get(value, 0)}
        for value, label in Ticket.State.choices
    ]


@require_GET
def scan(request: HttpRequest):
    return render(request, "tickets/scan.html")


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
            "ticket_state": result.session.ticket.state,
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
    response["Pragma"] = "no-cache"
    return response


@staff_required
@require_GET
def ticket_list_page(request: HttpRequest) -> HttpResponse:
    tickets = Ticket.objects.select_related("activity")
    activity_id = request.GET.get("activity_id", "").strip()
    batch_reference = request.GET.get("batch_reference", "").strip()
    serial_number = request.GET.get("serial_number", "").strip()
    state = request.GET.get("state", "").strip()
    if activity_id.isdigit():
        tickets = tickets.filter(activity_id=int(activity_id))
    if batch_reference:
        tickets = tickets.filter(batch_reference__icontains=batch_reference)
    if serial_number:
        tickets = tickets.filter(serial_number__icontains=serial_number)
    if state in {value for value, _ in Ticket.State.choices}:
        tickets = tickets.filter(state=state)
    response = render(
        request,
        "staff_panel/ticket_list.html",
        {
            "tickets": tickets.order_by("-created_at", "-pk"),
            "activities": _ticket_activities(),
            "state_choices": Ticket.State.choices,
            "state_rows": _ticket_state_rows(tickets),
            "selected_activity_id": activity_id,
            "selected_batch_reference": batch_reference,
            "selected_serial_number": serial_number,
            "selected_state": state,
        },
    )
    return _no_store(response)


@staff_required
def issue_page(request: HttpRequest) -> HttpResponse:
    issued_tickets = []
    error = ""
    if request.method == "POST":
        try:
            activity = get_object_or_404(
                Activity, pk=_required_form_int(request.POST, "activity_id")
            )
            quantity = _required_form_int(request.POST, "quantity")
            issued_tickets = issue_ticket_batch(
                activity,
                actor=request.user,
                quantity=quantity,
                batch_reference=request.POST.get("batch_reference"),
                serial_prefix=request.POST.get("serial_prefix"),
            )
        except (KeyError, TypeError, ValueError, ValidationError) as exc:
            error = str(exc) or "签发参数无效。"
        else:
            issued_tickets = [
                {
                    "ticket": item.ticket,
                    "secret": item.secret,
                    "qr_data_uri": _qr_data_uri(request, item.secret),
                }
                for item in issued_tickets
            ]
    response = render(
        request,
        "staff_panel/ticket_issue.html",
        {"activities": _ticket_activities(), "error": error, "issued_tickets": issued_tickets},
    )
    return _no_store(response)


@staff_required
def check_in_page(request: HttpRequest) -> HttpResponse:
    error = ""
    checked_in_ticket = None
    if request.method == "POST":
        raw_secret = request.POST.get("secret", "")
        try:
            checked_in_ticket = check_in_ticket(
                raw_secret,
                actor=request.user,
                request_meta=TicketRequestMeta(ip_address=client_ip(request)),
            )
        except (TypeError, ValidationError, PermissionDenied):
            error = "票据无效或当前活动尚未进入检票阶段。"
    response = render(
        request,
        "staff_panel/ticket_check_in.html",
        {"error": error, "checked_in_ticket": checked_in_ticket},
    )
    return _no_store(response)


@staff_required
@require_GET
def detail_page(request: HttpRequest, ticket_id: int) -> HttpResponse:
    ticket = get_object_or_404(Ticket.objects.select_related("activity"), pk=ticket_id)
    response = render(request, "staff_panel/ticket_detail.html", {"ticket": ticket})
    return _no_store(response)


@admin_required
@require_POST
def action_page(request: HttpRequest, ticket_id: int):
    ticket = get_object_or_404(Ticket, pk=ticket_id)
    action = request.POST.get("action")
    try:
        if action == "void":
            void_ticket(ticket, actor=request.user)
            messages.success(request, "票据已作废。")
        elif action == "revoke":
            revoke_ticket(ticket, actor=request.user)
            messages.success(request, "票据已撤销。")
        else:
            raise ValidationError("无效的票据操作。")
    except ValidationError as error:
        messages.error(request, str(error))
    return redirect("ticket_staff:detail", ticket_id=ticket_id)


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
    return _no_store(JsonResponse({"tickets": rows}))


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
    return _no_store(
        JsonResponse(
            {
                "ticket_id": result.ticket.pk,
                "state": result.ticket.state,
                "secret": result.secret,
                "qr_url": f"{request.build_absolute_uri('/tickets/scan/')}#{result.secret}",
            },
            status=201,
        )
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
    return _no_store(JsonResponse({"ticket_id": ticket.pk, "state": ticket.state}))


@admin_required
@require_POST
def void(request: HttpRequest, ticket_id: int) -> JsonResponse:
    ticket = get_object_or_404(Ticket, pk=ticket_id)
    try:
        updated = void_ticket(ticket, actor=request.user)
    except ValidationError:
        return _invalid_response()
    return _no_store(JsonResponse({"ticket_id": updated.pk, "state": updated.state}))


@admin_required
@require_POST
def revoke(request: HttpRequest, ticket_id: int) -> JsonResponse:
    ticket = get_object_or_404(Ticket, pk=ticket_id)
    try:
        updated = revoke_ticket(ticket, actor=request.user)
    except ValidationError:
        return _invalid_response()
    return _no_store(JsonResponse({"ticket_id": updated.pk, "state": updated.state}))
