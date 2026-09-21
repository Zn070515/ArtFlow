import json
from typing import Any

from common.audit import client_ip
from common.rate_limit import allow
from django.core.exceptions import ValidationError
from django.http import JsonResponse
from django.views.decorators.csrf import csrf_exempt
from django.views.decorators.http import require_POST

from .models import EphemeralSession
from .services import (
    AccessRequestMeta,
    redeem_access_grant,
)

REDEEM_BODY_MAX_BYTES = 4096
REDEEM_RATE_LIMIT = 30
REDEEM_RATE_WINDOW_SECONDS = 60


class RequestBodyTooLarge(Exception):
    """Raised when a route-specific request body cap is exceeded."""


def _no_store(response):
    response["Cache-Control"] = "no-store"
    response["Pragma"] = "no-cache"
    return response


def _json_payload(request, *, body_limit: int | None = None) -> dict[str, Any]:
    if body_limit is not None:
        content_length = request.META.get("CONTENT_LENGTH")
        try:
            declared_length = int(content_length) if content_length else 0
        except (TypeError, ValueError):
            declared_length = 0
        if declared_length > body_limit:
            raise RequestBodyTooLarge
    body = request.body or b""
    if body_limit is not None and len(body) > body_limit:
        raise RequestBodyTooLarge
    try:
        payload = json.loads(body or "{}")
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise ValidationError("请求体不是有效 JSON。") from error
    if not isinstance(payload, dict):
        raise ValidationError("请求体必须是 JSON 对象。")
    return payload


def _invalid_request(error):
    return _no_store(
        JsonResponse({"detail": error.messages, "reason_code": "INVALID_REQUEST"}, status=400)
    )


def _request_too_large_response():
    return _no_store(
        JsonResponse({"detail": "请求体过大。", "reason_code": "REQUEST_TOO_LARGE"}, status=413)
    )


def _rate_limited_response(retry_after_seconds: int):
    response = JsonResponse(
        {"detail": "请求过于频繁，请稍后再试。", "reason_code": "RATE_LIMITED"},
        status=429,
    )
    response["Retry-After"] = str(max(1, retry_after_seconds))
    return _no_store(response)


@csrf_exempt
@require_POST
def redeem_grant(request):
    """Redeem only a body token; no cookie authentication or URL token is accepted."""
    ip_address = client_ip(request) or "unknown"
    decision = allow(
        f"entry-access-redeem:{ip_address}",
        limit=REDEEM_RATE_LIMIT,
        window_seconds=REDEEM_RATE_WINDOW_SECONDS,
    )
    if not decision.allowed:
        return _rate_limited_response(decision.retry_after_seconds)
    try:
        payload = _json_payload(request, body_limit=REDEEM_BODY_MAX_BYTES)
    except RequestBodyTooLarge:
        return _request_too_large_response()
    except ValidationError as error:
        return _invalid_request(error)
    try:
        raw_token = payload["token"]
        result = redeem_access_grant(
            raw_token,
            request_meta=AccessRequestMeta(ip_address=ip_address),
        )
    except (KeyError, TypeError):
        return _no_store(
            JsonResponse(
                {"detail": "请求缺少 token。", "reason_code": "INVALID_REQUEST"}, status=400
            )
        )
    except ValidationError:
        return _no_store(
            JsonResponse(
                {"detail": "临时访问授权无效。", "reason_code": "INVALID_GRANT"}, status=400
            )
        )
    return _no_store(
        JsonResponse(
            {
                "session_id": result.session.pk,
                "session_token": result.token,
                "kind": result.session.kind,
                "activity_id": getattr(result.session, "activity_id", None),
                "round_id": getattr(result.session, "round_id", None),
                "expires_at": result.session.expires_at.isoformat(),
            }
        )
    )