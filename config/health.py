from django.core.checks import ERROR, run_checks
from django.db import connections
from django.http import HttpRequest, JsonResponse
from django.views.decorators.csrf import csrf_exempt


@csrf_exempt
def healthz(request: HttpRequest) -> JsonResponse:
    if request.method != "GET":
        response = _unavailable_response(status=405)
        response["Allow"] = "GET"
        return response

    try:
        if any(check.level >= ERROR for check in run_checks()):
            return _unavailable_response()
        connections["default"].ensure_connection()
    except Exception:
        return _unavailable_response()

    return JsonResponse({"status": "ok"})


def _unavailable_response(status: int = 503) -> JsonResponse:
    return JsonResponse({"status": "unavailable"}, status=status)
