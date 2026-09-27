from django.db import DatabaseError
from django.http import HttpResponse

from .models import MaintenanceState


class WriteBarrierMiddleware:
    """Reject new HTTP mutations while a consistent backup is being captured."""

    def __init__(self, get_response):
        self.get_response = get_response

    def __call__(self, request):
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
