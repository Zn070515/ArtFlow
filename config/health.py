"""Liveness and readiness probes.

These endpoints are polled every 10-15 s by Docker, Caddy and the deploy
scripts, so they must stay cheap. Running Django's full system-check set on every
probe was wasted work: those checks belong to startup (``manage.py check``), the
``doctor`` command and the deployment gate, not to a 10 s heartbeat.

* ``/livez/``  — is this process able to answer? No database, no system checks.
* ``/readyz/`` — can this process execute a lightweight database query?
* ``/healthz/`` — readiness under its original name, kept because the deployed
  container, proxy and CI probes already point at it.

Every response stays deliberately generic: an anonymous probe must not learn why
the application is unavailable.
"""

from django.db import connections
from django.http import HttpRequest, JsonResponse
from django.views.decorators.csrf import csrf_exempt


def _unavailable_response(status: int = 503) -> JsonResponse:
    return JsonResponse({"status": "unavailable"}, status=status)


def _method_not_allowed() -> JsonResponse:
    response = _unavailable_response(status=405)
    response["Allow"] = "GET"
    return response


@csrf_exempt
def livez(request: HttpRequest) -> JsonResponse:
    """Liveness: the process answered, without touching the database."""
    if request.method != "GET":
        return _method_not_allowed()
    return JsonResponse({"status": "alive"})


@csrf_exempt
def readyz(request: HttpRequest) -> JsonResponse:
    """Readiness: a lightweight database connection check."""
    if request.method != "GET":
        return _method_not_allowed()
    try:
        with connections["default"].cursor() as cursor:
            cursor.execute("SELECT 1")
            cursor.fetchone()
    except Exception:
        return _unavailable_response()
    return JsonResponse({"status": "ok"})


@csrf_exempt
def healthz(request: HttpRequest) -> JsonResponse:
    """Readiness under the historical route name used by the deployment probes."""
    return readyz(request)
