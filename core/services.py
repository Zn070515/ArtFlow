from __future__ import annotations

from typing import Any

from common.authority import ACTIVITY_STATE, authority_write
from common.business_rules import ensure_activity_unlocked
from common.models import AuditLog
from django.core.exceptions import PermissionDenied, ValidationError
from django.db import transaction

from core.policies import ActivityAction, ensure_activity_action_allowed

from .models import Activity

# Explicit generic-transition edge set. This is a literal state machine: every
# edge below is an approved forward step, and nothing is derived positionally.
# ARCHIVED is deliberately absent from every successor set, so the generic
# service (and the create/edit forms that feed it) can never manufacture an
# archived activity — only _enter_archived_phase_locked(), used by the formal
# archive flow, may reach ARCHIVED. DRAFT may not skip ahead to the results
# phases; it starts with TESTING or opens registration directly.
PHASE_EDGES: dict[str, frozenset[str]] = {
    Activity.Phase.DRAFT: frozenset(
        {
            Activity.Phase.TESTING,
            Activity.Phase.REGISTRATION_OPEN,
        }
    ),
    Activity.Phase.TESTING: frozenset({Activity.Phase.REGISTRATION_OPEN}),
    Activity.Phase.REGISTRATION_OPEN: frozenset({Activity.Phase.REGISTRATION_CLOSED}),
    Activity.Phase.REGISTRATION_CLOSED: frozenset({Activity.Phase.REVIEWING}),
    Activity.Phase.REVIEWING: frozenset({Activity.Phase.REHEARSAL}),
    Activity.Phase.REHEARSAL: frozenset({Activity.Phase.LIVE}),
    Activity.Phase.LIVE: frozenset({Activity.Phase.RESULTS_PENDING}),
    Activity.Phase.RESULTS_PENDING: frozenset({Activity.Phase.RESULTS_PUBLISHED}),
    Activity.Phase.RESULTS_PUBLISHED: frozenset(),
    Activity.Phase.ARCHIVED: frozenset(),
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
    ensure_activity_unlocked(locked_activity)
    if locked_activity.phase == target_phase:
        return locked_activity

    if target_phase not in PHASE_EDGES.get(locked_activity.phase, frozenset()):
        raise PermissionDenied(
            f"Cannot move activity from '{locked_activity.phase}' to '{target_phase}'."
        )

    old_phase = locked_activity.phase
    locked_activity.phase = target_phase
    with authority_write(ACTIVITY_STATE):
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
def _enter_archived_phase_locked(
    activity: Activity, *, actor: Any = None, note: str = ""
) -> Activity:
    """Move an activity into the terminal ARCHIVED phase.

    Private archive-authority path (belongs to the internal archive flow): generic
    phase transitions must never target ARCHIVED, so only archive_activity may
    reach this state. Locks the Activity row and audits the transition.
    """
    locked_activity = Activity.objects.select_for_update().get(pk=activity.pk)
    if locked_activity.phase == Activity.Phase.ARCHIVED:
        return locked_activity
    old_phase = locked_activity.phase
    locked_activity.phase = Activity.Phase.ARCHIVED
    with authority_write(ACTIVITY_STATE):
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


@transaction.atomic
def unarchive_activity(activity: Activity, *, actor: Any = None, note: str = "") -> Activity:
    """Move an archived activity back to a defined, non-archived phase.

    The single unarchive authority: an admin unlocks the archived activity,
    restores it to RESULTS_PUBLISHED (never LIVE), and demotes the current
    archive package, then audits the change. Ordinary results-unlock and generic
    phase transitions can never reach ARCHIVED, so this is the only back door.
    """
    if actor is None or not actor.is_admin:
        raise PermissionDenied("只有管理员才能解归档。")
    locked_activity = Activity.objects.select_for_update().get(pk=activity.pk)
    if locked_activity.phase != Activity.Phase.ARCHIVED:
        raise PermissionDenied("只有已归档活动才能解归档。")
    from archive.models import ArchivePackage

    ArchivePackage.objects.filter(activity=locked_activity, is_current=True).update(
        is_current=False
    )
    old_phase = locked_activity.phase
    locked_activity.phase = Activity.Phase.RESULTS_PUBLISHED
    locked_activity.is_locked = False
    locked_activity.locked_at = None
    locked_activity.locked_by = None
    with authority_write(ACTIVITY_STATE):
        locked_activity.save(
            update_fields=["phase", "is_locked", "locked_at", "locked_by"],
        )
    AuditLog.objects.create(
        operator=actor,
        action_type=AuditLog.ActionType.UNARCHIVE_ACTIVITY,
        target=f"Activity:{locked_activity.pk}",
        old_value=old_phase,
        new_value=Activity.Phase.RESULTS_PUBLISHED,
        note=note,
    )
    return locked_activity
