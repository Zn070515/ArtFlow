from __future__ import annotations

import json
from base64 import b64encode
from hashlib import sha256
from io import BytesIO
from typing import Any, TypeVar
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
from django.utils import timezone
from django.views.decorators.http import require_GET, require_POST

from .models import Ticket, TicketAccessSession
from .services import (
    TicketRequestMeta,
    check_in_ticket_outcome,
    create_ticket,
    issue_ticket,
    issue_ticket_batch,
    redeem_ticket,
    revoke_ticket,
    revoke_ticket_session,
    rotate_ticket_credential,
    ticket_credential,
    void_ticket,
)

BODY_MAX_BYTES = 4096
REDEEM_RATE_LIMIT = 30
REDEEM_RATE_WINDOW_SECONDS = 60
# A credential bucket is the strict replay/guessing boundary. The address bucket is
# deliberately broad: a school Wi-Fi or event Caddy commonly represents hundreds of
# legitimate phones with one source address.
REDEEM_IP_RATE_LIMIT = 600


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


_ResponseT = TypeVar("_ResponseT", bound=HttpResponse)


def _no_store(response: _ResponseT) -> _ResponseT:
    """Stamp no-cache headers while preserving the response's concrete type."""
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


def _credential_from_payload(payload: dict[str, Any]) -> str:
    value = payload.get("credential", payload.get("secret"))
    if not isinstance(value, str) or not value.strip():
        raise ValueError
    return value.strip()


def _required_form_int(payload, key: str) -> int:
    value = payload.get(key)
    if not isinstance(value, str) or not value.strip():
        raise ValueError
    try:
        return int(value)
    except ValueError:
        raise ValueError from None


def _qr_data_uri(request: HttpRequest, credential: str) -> str:
    import qrcode

    target = f"{request.build_absolute_uri('/tickets/scan/')}#{quote(credential, safe='')}"
    image = qrcode.make(target)
    buffer = BytesIO()
    image.save(buffer)
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
    source_ip = client_ip(request) or "unknown"
    ip_decision = allow(
        f"ticket-redeem-ip:{source_ip}",
        limit=REDEEM_IP_RATE_LIMIT,
        window_seconds=REDEEM_RATE_WINDOW_SECONDS,
    )
    if not ip_decision.allowed:
        return _rate_limited_response(ip_decision.retry_after_seconds)
    try:
        payload = _json_payload(request)
        raw_secret = _credential_from_payload(payload)
        credential_decision = allow(
            f"ticket-redeem-credential:{sha256(raw_secret.encode('utf-8')).hexdigest()}",
            limit=REDEEM_RATE_LIMIT,
            window_seconds=REDEEM_RATE_WINDOW_SECONDS,
        )
        if not credential_decision.allowed:
            return _rate_limited_response(credential_decision.retry_after_seconds)
        result = redeem_ticket(
            raw_secret,
            request_meta=TicketRequestMeta(ip_address=source_ip),
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
    issued_rows: list[dict[str, Any]] = []
    error = ""
    if request.method == "POST":
        try:
            activity = get_object_or_404(
                Activity, pk=_required_form_int(request.POST, "activity_id")
            )
            quantity = _required_form_int(request.POST, "quantity")
            issued = issue_ticket_batch(
                activity,
                actor=request.user,
                quantity=quantity,
                batch_reference=request.POST.get("batch_reference"),
                serial_prefix=request.POST.get("serial_prefix"),
            )
        except (KeyError, TypeError, ValueError, ValidationError) as exc:
            error = str(exc) or "签发参数无效。"
        else:
            issued_rows = [
                {
                    "ticket": item.ticket,
                    "secret": item.secret,
                    "credential": ticket_credential(item.ticket),
                    "qr_data_uri": _qr_data_uri(request, ticket_credential(item.ticket)),
                }
                for item in issued
            ]
    response = render(
        request,
        "staff_panel/ticket_issue.html",
        {"activities": _ticket_activities(), "error": error, "issued_tickets": issued_rows},
    )
    return _no_store(response)


@staff_required
def check_in_page(request: HttpRequest) -> HttpResponse:
    error = ""
    checked_in_ticket = None
    already_checked_in = False
    if request.method == "POST":
        raw_secret = request.POST.get("secret", "")
        try:
            outcome = check_in_ticket_outcome(
                raw_secret,
                actor=request.user,
                request_meta=TicketRequestMeta(ip_address=client_ip(request)),
            )
        except (TypeError, ValidationError, PermissionDenied):
            error = "票据无效或当前活动尚未进入检票阶段。"
        else:
            checked_in_ticket = outcome.ticket
            already_checked_in = outcome.already_checked_in
    response = render(
        request,
        "staff_panel/ticket_check_in.html",
        {
            "error": error,
            "checked_in_ticket": checked_in_ticket,
            "already_checked_in": already_checked_in,
        },
    )
    return _no_store(response)


@staff_required
@require_GET
def detail_page(request: HttpRequest, ticket_id: int) -> HttpResponse:
    ticket = get_object_or_404(Ticket.objects.select_related("activity"), pk=ticket_id)
    now = timezone.now()
    response = render(
        request,
        "staff_panel/ticket_detail.html",
        {
            "ticket": ticket,
            "credential": ticket_credential(ticket) if ticket.public_code else None,
            "qr_data_uri": (
                _qr_data_uri(request, ticket_credential(ticket)) if ticket.public_code else None
            ),
            # GOAL §10.2/§12.6: rotating the credential revokes every session the leaked QR
            # produced, but a *single* lost phone is its own incident. `revoke_ticket_session`
            # has existed as a service without any way to reach it from the door.
            "access_sessions": [
                {
                    "session": session,
                    "is_live": session.revoked_at is None and session.expires_at > now,
                }
                for session in TicketAccessSession.objects.filter(ticket=ticket).order_by(
                    "-created_at", "-pk"
                )[:20]
            ],
            "now": now,
        },
    )
    return _no_store(response)


@staff_required
@require_POST
def revoke_session_page(request: HttpRequest, session_id: int):
    session = get_object_or_404(TicketAccessSession.objects.select_related("ticket"), pk=session_id)
    try:
        revoke_ticket_session(session, actor=request.user, note=request.POST.get("note", ""))
    except ValidationError as error:
        messages.error(request, str(error))
    else:
        messages.success(request, "该浏览器会话已吊销，设备需要重新扫码才能继续。")
    return redirect("ticket_staff:detail", ticket_id=session.ticket_id)


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
@require_POST
def reset_credential_page(request: HttpRequest, ticket_id: int):
    ticket = get_object_or_404(Ticket, pk=ticket_id)
    try:
        rotate_ticket_credential(ticket, actor=request.user)
        messages.success(request, "票据凭证已重置，旧二维码已失效。")
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
    credential = ticket_credential(result.ticket)
    return _no_store(
        JsonResponse(
            {
                "ticket_id": result.ticket.pk,
                "state": result.ticket.state,
                "secret": result.secret,
                "credential": credential,
                "qr_url": (
                    f"{request.build_absolute_uri('/tickets/scan/')}#{quote(credential, safe='')}"
                ),
            },
            status=201,
        )
    )


@staff_required
@require_POST
def check_in(request: HttpRequest) -> JsonResponse:
    try:
        payload = _json_payload(request)
        outcome = check_in_ticket_outcome(
            _credential_from_payload(payload),
            actor=request.user,
            request_meta=TicketRequestMeta(ip_address=client_ip(request)),
        )
    except (KeyError, TypeError, ValueError, RequestBodyTooLarge, ValidationError):
        return _invalid_response()
    ticket = outcome.ticket
    # GOAL §10.3: the door shows three states, so the scanner has to be told which of the
    # two successes this was. `checked_in_at` is what lets it answer "already went in at
    # 19:04" rather than repeating a bare "success" for a second person.
    return _no_store(
        JsonResponse(
            {
                "ticket_id": ticket.pk,
                "state": ticket.state,
                "already_checked_in": outcome.already_checked_in,
                "checked_in_at": ticket.checked_in_at.isoformat() if ticket.checked_in_at else None,
            }
        )
    )


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
