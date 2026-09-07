import json
from datetime import timedelta

from accounts.decorators import staff_required
from django.core.exceptions import ValidationError
from django.http import JsonResponse
from django.shortcuts import get_object_or_404
from django.views.decorators.csrf import csrf_exempt
from django.views.decorators.http import require_POST
from singer_contest.models import ContestRound

from .models import AccessGrant, EntryPoint, EphemeralSession
from .services import (
    AccessRequestMeta,
    issue_access_grant,
    redeem_access_grant,
    revoke_access_grant,
    revoke_ephemeral_session,
)


def _json_payload(request):
    try:
        payload = json.loads(request.body or "{}")
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise ValidationError("请求体不是有效 JSON。") from error
    if not isinstance(payload, dict):
        raise ValidationError("请求体必须是 JSON 对象。")
    return payload


def _invalid_request(error):
    return JsonResponse({"detail": error.messages, "reason_code": "INVALID_REQUEST"}, status=400)


def _required_json_int(payload, key):
    value = payload[key]
    if isinstance(value, bool) or not isinstance(value, int):
        raise ValueError
    return value


@staff_required
@require_POST
def issue_grant(request):
    try:
        payload = _json_payload(request)
        entry_point_id = _required_json_int(payload, "entry_point_id")
        ttl_seconds = _required_json_int(payload, "ttl_seconds")
        round_id = payload.get("round_id")
        if round_id is not None:
            if isinstance(round_id, bool) or not isinstance(round_id, int):
                raise ValueError
        entry_point = get_object_or_404(EntryPoint, pk=entry_point_id)
        selected_round = (
            get_object_or_404(ContestRound, pk=round_id) if round_id is not None else None
        )
        result = issue_access_grant(
            entry_point,
            actor=request.user,
            ttl=timedelta(seconds=ttl_seconds),
            round=selected_round,
        )
    except (KeyError, TypeError, ValueError):
        return JsonResponse(
            {
                "detail": "entry_point_id、ttl_seconds 或 round_id 无效。",
                "reason_code": "INVALID_REQUEST",
            },
            status=400,
        )
    except ValidationError as error:
        return _invalid_request(error)
    return JsonResponse(
        {
            "grant_id": result.grant.pk,
            "token": result.token,
            "kind": result.grant.kind,
            "activity_id": result.grant.activity_id,
            "round_id": result.grant.round_id,
            "expires_at": result.grant.expires_at.isoformat(),
        },
        status=201,
    )


@csrf_exempt
@require_POST
def redeem_grant(request):
    """Redeem only a body token; no cookie authentication or URL token is accepted."""
    try:
        payload = _json_payload(request)
    except ValidationError as error:
        return _invalid_request(error)
    try:
        raw_token = payload["token"]
        result = redeem_access_grant(
            raw_token,
            request_meta=AccessRequestMeta(ip_address=request.META.get("REMOTE_ADDR")),
        )
    except (KeyError, TypeError):
        return JsonResponse(
            {"detail": "请求缺少 token。", "reason_code": "INVALID_REQUEST"}, status=400
        )
    except ValidationError:
        return JsonResponse(
            {"detail": "临时访问授权无效。", "reason_code": "INVALID_GRANT"}, status=400
        )
    return JsonResponse(
        {
            "session_id": result.session.pk,
            "session_token": result.token,
            "kind": result.session.kind,
            "activity_id": result.session.activity_id,
            "round_id": result.session.round_id,
            "expires_at": result.session.expires_at.isoformat(),
        }
    )


@staff_required
@require_POST
def revoke_grant(request, grant_id):
    try:
        payload = _json_payload(request)
        grant = get_object_or_404(AccessGrant, pk=grant_id)
        revoked = revoke_access_grant(grant, actor=request.user, note=payload.get("note"))
    except ValidationError as error:
        return _invalid_request(error)
    return JsonResponse({"grant_id": revoked.pk, "revoked_at": revoked.revoked_at.isoformat()})


@staff_required
@require_POST
def revoke_session(request, session_id):
    try:
        payload = _json_payload(request)
        session = get_object_or_404(EphemeralSession, pk=session_id)
        revoked = revoke_ephemeral_session(session, actor=request.user, note=payload.get("note"))
    except ValidationError as error:
        return _invalid_request(error)
    return JsonResponse({"session_id": revoked.pk, "revoked_at": revoked.revoked_at.isoformat()})
