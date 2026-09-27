from collections.abc import Callable

from django.db import DatabaseError
from django.http import HttpRequest, HttpResponse, HttpResponseBase

from .models import MaintenanceState


class WriteBarrierMiddleware:
    """Reject new HTTP mutations while a consistent backup is being captured."""

    def __init__(self, get_response: Callable[[HttpRequest], HttpResponseBase]) -> None:
        self.get_response = get_response

    def __call__(self, request: HttpRequest) -> HttpResponseBase:
        if request.method in {"POST", "PUT", "PATCH", "DELETE"}:
            try:
                blocked = MaintenanceState.objects.filter(
                    pk=MaintenanceState.SINGLETON_PK, enabled=True
                ).exists()
            except DatabaseError:
                return HttpResponse("Service temporarily unavailable.", status=503)
            if blocked:
                return HttpResponse("Service temporarily unavailable.", status=503)
        return self.get_response(request)
