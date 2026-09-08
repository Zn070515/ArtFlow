import hashlib
import json
from dataclasses import asdict
from urllib.parse import urlsplit

from common.audit import client_ip
from common.rate_limit import allow
from django.core.exceptions import PermissionDenied, ValidationError
from django.http import HttpRequest, JsonResponse
from django.shortcuts import render
from django.views.decorators.csrf import csrf_exempt
from django.views.decorators.http import require_http_methods

from .judge_authority import (
    JudgeIdempotencyConflict,
    get_judge_context,
    submit_judge_score,
)

BODY_MAX_BYTES = 16 * 1024
_JUDGE_CONTEXT_SESSION_LIMIT = 45
_JUDGE_CONTEXT_ANONYMOUS_IP_LIMIT = 30
_JUDGE_CONTEXT_IP_LIMIT = 600
_JUDGE_SCORE_SESSION_LIMIT = 30
_JUDGE_SCORE_ANONYMOUS_IP_LIMIT = 30
_JUDGE_SCORE_IP_LIMIT = 120
_KNOWN_REASON_CODES = {
    "DUPLICATE_SCORE_FACT",
    "IDEMPOTENCY_CONFLICT",
    "PANEL_CHANGED_MID_ROUND",
    "PERFORMANCE_NOT_SCORABLE",
    "ROUND_ON_HOLD",
    "RUBRIC_CONFIGURATION_INVALID",
    "RUBRIC_PAYLOAD_INVALID",
    "SCORE_WINDOW_CLOSED",
    "STALE_CONTEXT",
}


def _no_store(response: JsonResponse) -> JsonResponse:
    response["Cache-Control"] = "no-store"
    response["Pragma"] = "no-cache"
    return response


def _error(reason_code: str, status: int) -> JsonResponse:
    return _no_store(
        JsonResponse({"detail": "评委请求未被接受。", "reason_code": reason_code}, status=status)
    )


def _rate_limit_identity(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def _rate_limit(
    request: HttpRequest,
    operation: str,
    *,
    session_limit: int,
    anonymous_ip_limit: int,
    ip_limit: int,
) -> JsonResponse | None:
    source = _rate_limit_identity(client_ip(request) or "unknown")
    token = _bearer_token(request)
    if token is None:
        decision = allow(
            f"judge:{operation}:anonymous-ip:{source}",
            limit=anonymous_ip_limit,
            window_seconds=60,
        )
    else:
        decision = allow(
            f"judge:{operation}:ip:{source}",
            limit=ip_limit,
            window_seconds=60,
        )
        if decision.allowed:
            token_identity = _rate_limit_identity(token)
            decision = allow(
                f"judge:{operation}:session:{token_identity}",
                limit=session_limit,
                window_seconds=60,
            )
    if decision.allowed:
        return None
    response = _error("RATE_LIMITED", 429)
    response["Retry-After"] = str(max(1, decision.retry_after_seconds))
    return response


def _same_origin(request: HttpRequest) -> bool:
    origin = request.headers.get("Origin")
    if not origin:
        return True
    parsed = urlsplit(origin)
    return parsed.scheme in {"http", "https"} and origin.rstrip("/") == (
        f"{request.scheme}://{request.get_host()}"
    )


def _bearer_token(request: HttpRequest) -> str | None:
    authorization = request.headers.get("Authorization", "")
    scheme, separator, token = authorization.partition(" ")
    if separator != " " or scheme != "Bearer" or not token or " " in token:
        return None
    return token


def _body_payload(request: HttpRequest) -> dict[str, object] | None:
    declared_length = request.headers.get("Content-Length")
    if declared_length:
        try:
            if int(declared_length) > BODY_MAX_BYTES:
                return None
        except ValueError:
            return None
    body = request.body or b""
    if len(body) > BODY_MAX_BYTES:
        return None
    try:
        payload = json.loads(body or b"{}")
    except (TypeError, ValueError, json.JSONDecodeError):
        return None
    return payload if isinstance(payload, dict) else None


def _reason_from_messages(error: ValidationError) -> str:
    for message in error.messages:
        if message in _KNOWN_REASON_CODES:
            return message
    return "INVALID_REQUEST"


@require_http_methods(["GET"])
def judge_terminal(request: HttpRequest):
    return render(request, "singer_contest/judge_terminal.html")


@require_http_methods(["GET"])
def judge_context(request: HttpRequest) -> JsonResponse:
    limited = _rate_limit(
        request,
        "context",
        session_limit=_JUDGE_CONTEXT_SESSION_LIMIT,
        anonymous_ip_limit=_JUDGE_CONTEXT_ANONYMOUS_IP_LIMIT,
        ip_limit=_JUDGE_CONTEXT_IP_LIMIT,
    )
    if limited is not None:
        return limited
    if not _same_origin(request):
        return _error("ORIGIN_REJECTED", 403)
    token = _bearer_token(request)
    if token is None:
        return _error("INVALID_JUDGE_SESSION", 401)
    try:
        context = get_judge_context(token)
    except (ValidationError, PermissionDenied):
        return _error("INVALID_JUDGE_SESSION", 401)
    return _no_store(JsonResponse({"context": asdict(context)}))


@csrf_exempt
@require_http_methods(["POST"])
def judge_score(request: HttpRequest) -> JsonResponse:
    limited = _rate_limit(
        request,
        "score",
        session_limit=_JUDGE_SCORE_SESSION_LIMIT,
        anonymous_ip_limit=_JUDGE_SCORE_ANONYMOUS_IP_LIMIT,
        ip_limit=_JUDGE_SCORE_IP_LIMIT,
    )
    if limited is not None:
        return limited
    if not _same_origin(request):
        return _error("ORIGIN_REJECTED", 403)
    token = _bearer_token(request)
    if token is None:
        return _error("INVALID_JUDGE_SESSION", 401)
    payload = _body_payload(request)
    if payload is None:
        declared_length = request.headers.get("Content-Length")
        if declared_length and declared_length.isdigit() and int(declared_length) > BODY_MAX_BYTES:
            return _error("REQUEST_TOO_LARGE", 413)
        return _error("INVALID_REQUEST", 400)
    if set(payload) != {
        "command_id",
        "expected_context_version",
        "expected_performance_id",
        "score_payload",
    }:
        return _error("INVALID_REQUEST", 400)
    try:
        result = submit_judge_score(
            token,
            command_id=payload["command_id"],
            expected_context_version=payload["expected_context_version"],
            expected_performance_id=payload["expected_performance_id"],
            score_payload=payload["score_payload"],
        )
    except JudgeIdempotencyConflict:
        return _error("IDEMPOTENCY_CONFLICT", 409)
    except PermissionDenied as error:
        reason = str(error)
        return _error(reason if reason in _KNOWN_REASON_CODES else "SCORE_WINDOW_CLOSED", 403)
    except ValidationError as error:
        reason = _reason_from_messages(error)
        if reason == "INVALID_REQUEST" and any(
            message == "评委访问会话无效。" for message in error.messages
        ):
            return _error("INVALID_JUDGE_SESSION", 401)
        return _error(reason, 400)
    return _no_store(JsonResponse({"receipt": asdict(result)}, status=201))
