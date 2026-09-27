from __future__ import annotations

from contextlib import contextmanager
from typing import Iterator

from django.db import transaction
from django.utils import timezone

from .models import MaintenanceState


class WriteBarrierBusy(RuntimeError):
    """Raised when a second maintenance owner tries to acquire the barrier."""


@contextmanager
def write_barrier(reason: str) -> Iterator[MaintenanceState]:
    with transaction.atomic():
        state, _created = MaintenanceState.objects.get_or_create(
            pk=MaintenanceState.SINGLETON_PK,
            defaults={"enabled": False},
        )
        state = MaintenanceState.objects.select_for_update().get(pk=state.pk)
        if state.enabled:
            raise WriteBarrierBusy("The application write barrier is already active.")
        state.enabled = True
        state.reason = reason.strip()[:120]
        state.started_at = timezone.now()
        state.save(update_fields=["enabled", "reason", "started_at"])
    try:
        yield state
    finally:
        with transaction.atomic():
            MaintenanceState.objects.filter(pk=MaintenanceState.SINGLETON_PK).update(
                enabled=False,
                reason="",
                started_at=None,
            )
