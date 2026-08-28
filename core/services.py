from __future__ import annotations

from typing import Any

from common.models import AuditLog
from django.core.exceptions import PermissionDenied, ValidationError
from django.db import transaction

from .models import Activity

# Canonical forward order. An activity may advance through the lifecycle but may
# not regress; ARCHIVED is terminal (reopen requires an explicit, separate path).
_PHASE_ORDER: list[str] = [
    Activity.Phase.DRAFT,
    Activity.Phase.TESTING,
    Activity.Phase.REGISTRATION_OPEN,
    Activity.Phase.REGISTRATION_CLOSED,
    Activity.Phase.REVIEWING,
    Activity.Phase.REHEARSAL,
    Activity.Phase.LIVE,
    Activity.Phase.RESULTS_PENDING,
    Activity.Phase.RESULTS_PUBLISHED,
    Activity.Phase.ARCHIVED,
]


@transaction.atomic
def transition_activity_phase(
    activity: Activity,
    target_phase: str,
    *,
    actor: Any = None,
    note: str = "",
) -> Activity:
    """Advance an activity to a later phase, auditing the change.

    Rejects regression (e.g. ARCHIVED -> LIVE) and arbitrary phase strings.
    """
    if target_phase not in Activity.Phase.values:
        raise ValidationError(f"Unknown phase: {target_phase}")

    locked_activity = Activity.objects.select_for_update().get(pk=activity.pk)
    if locked_activity.phase == target_phase:
        return locked_activity

    current_index = _PHASE_ORDER.index(locked_activity.phase)
    target_index = _PHASE_ORDER.index(target_phase)
    if target_index < current_index:
        raise PermissionDenied(
            f"Cannot move activity backwards from '{locked_activity.phase}' to '{target_phase}'."
        )

    old_phase = locked_activity.phase
    locked_activity.phase = target_phase
    locked_activity.save(update_fields=["phase"])
    AuditLog.objects.create(
        operator=actor,
        action_type=AuditLog.ActionType.PHASE_TRANSITION,
        target=f"Activity:{locked_activity.pk}",
        old_value=old_phase,
        new_value=target_phase,
        note=note,
    )
    return locked_activity
