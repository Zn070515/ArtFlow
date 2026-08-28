from __future__ import annotations

from typing import Any

from common.business_rules import ensure_activity_unlocked
from common.models import AuditLog
from django.core.exceptions import PermissionDenied, ValidationError
from django.db import transaction

from core.policies import ActivityAction, ensure_activity_action_allowed

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

# Explicit generic-transition edge set. A phase may move to any later lifecycle
# phase, but ARCHIVED is deliberately absent from every successor set: the
# generic service (and the create/edit forms that feed it) can never manufacture
# an archived activity. Only enter_archived_phase(), used by the formal archive
# flow, may move an activity into ARCHIVED.
_PHASE_EDGES: dict[str, frozenset[str]] = {
    phase: frozenset(
        later for later in _PHASE_ORDER[phase_index + 1 :] if later != Activity.Phase.ARCHIVED
    )
    for phase_index, phase in enumerate(_PHASE_ORDER)
}


def lock_activity_for_action(activity: Activity, action: ActivityAction | None = None) -> Activity:
    """Acquire the authoritative Activity row lock and re-validate a mutation.

    Only call inside ``transaction.atomic``. Locks the Activity row, then
    re-reads and re-checks the global lock; if ``action`` is given it also
    re-checks the phase action policy. Any check outside this call (in a view,
    before entering the transaction) is only a UX guard and carries no authority
    — the state can change between that check and the transaction, so the
    mutation must re-validate here.
    """
    locked_activity = Activity.objects.select_for_update().get(pk=activity.pk)
    ensure_activity_unlocked(locked_activity)
    if action is not None:
        ensure_activity_action_allowed(locked_activity, action)
    return locked_activity


@transaction.atomic
def transition_activity_phase(
    activity: Activity,
    target_phase: str,
    *,
    actor: Any = None,
    note: str = "",
) -> Activity:
    """Advance an activity to a later phase, auditing the change.

    Any generic path may move the activity forward in its lifecycle, but never
    backwards and never into ARCHIVED (that requires the formal archive flow).
    """
    if target_phase not in Activity.Phase.values:
        raise ValidationError(f"Unknown phase: {target_phase}")

    locked_activity = Activity.objects.select_for_update().get(pk=activity.pk)
    if locked_activity.phase == target_phase:
        return locked_activity

    if target_phase not in _PHASE_EDGES.get(locked_activity.phase, frozenset()):
        raise PermissionDenied(
            f"Cannot move activity from '{locked_activity.phase}' to '{target_phase}'."
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


@transaction.atomic
def enter_archived_phase(activity: Activity, *, actor: Any = None, note: str = "") -> Activity:
    """Move an activity into the terminal ARCHIVED phase.

    This is the single archive-authority path: generic phase transitions must
    never target ARCHIVED, so only the formal archive flow (archive_activity)
    may reach this state. Audits the transition like any other phase change.
    """
    locked_activity = Activity.objects.select_for_update().get(pk=activity.pk)
    if locked_activity.phase == Activity.Phase.ARCHIVED:
        return locked_activity
    old_phase = locked_activity.phase
    locked_activity.phase = Activity.Phase.ARCHIVED
    locked_activity.save(update_fields=["phase"])
    AuditLog.objects.create(
        operator=actor,
        action_type=AuditLog.ActionType.PHASE_TRANSITION,
        target=f"Activity:{locked_activity.pk}",
        old_value=old_phase,
        new_value=Activity.Phase.ARCHIVED,
        note=note,
    )
    return locked_activity
