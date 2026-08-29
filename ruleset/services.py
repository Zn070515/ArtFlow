"""Freeze service for a DRAFT :class:`RulesetVersion` (§8.2, §16).

A ruleset becomes authoritative only through a *freeze*: the DRAFT version is
re-compiled, refused if the compiler reports any ERROR, and only then set to
``status=FROZEN`` with a frozen_by/frozen_at stamp and its execution plan
persisted. The prior current version (which is FROZEN) is demoted so the
one-current partial unique constraint holds and never violates the queryset's
immutable guard — that demotion goes through :class:`RulesetVersion._base_manager`.

The transaction is the only authority: admin does not require phase-gating (ruleset
config is set pre-contest), but requires the activity to be unlocked and the operator
to be an effective admin. Every freeze writes a :class:`~common.models.AuditLog`.
"""

from __future__ import annotations

import json

from common.models import AuditLog
from core.services import lock_activity_for_action
from django.contrib.auth import get_user_model
from django.core.exceptions import PermissionDenied, ValidationError
from django.db import transaction
from django.utils import timezone

from .compiler import ExecutionPlan, ValidationReport, compile_version
from .models import RulesetVersion


class RulesetInvalidError(Exception):
    """The definition failed compilation; freezing must abort."""

    def __init__(self, report: ValidationReport, plan: ExecutionPlan | None):
        super().__init__("Ruleset definition is invalid; freeze aborted.")
        self.report = report
        self.plan = plan


def _demote_prior_current(version: RulesetVersion) -> None:
    """Drop the current flag from the previously-current FROZEN version.

    Uses the *base* manager (not the guarded ``objects`` manager) so the demotion
    does not trip the frozen-immutability guard — the demotion changes ``is_current``
    (which the immutable_fields list includes), so the queryset guard would otherwise
    raise. Only valid inside the freeze transaction.
    """
    RulesetVersion._base_manager.filter(ruleset_id=version.ruleset_id).exclude(
        pk=version.pk
    ).filter(is_current=True).update(is_current=False)


@transaction.atomic
def freeze_ruleset_version(version: RulesetVersion, operator) -> RulesetVersion:
    """Freeze a DRAFT ruleset version. Returns the locked, frozen version.

    Raises :class:`PermissionDenied` if the operator is not an effective admin or the
    activity is locked; :class:`ValidationError` if the version is already frozen;
    :class:`RulesetInvalidError` if compilation reports any ERROR.
    """
    locked = (
        RulesetVersion.objects.select_for_update()
        .select_related("ruleset__activity")
        .get(pk=version.pk)
    )
    current_operator = get_user_model().objects.get(pk=operator.pk)
    if not current_operator.is_active or not current_operator.is_admin:
        raise PermissionDenied("只有管理员可以核定冻结赛制。")
    if locked.status == RulesetVersion.Status.FROZEN:
        raise ValidationError("该赛制版本已冻结。")

    lock_activity_for_action(locked.ruleset.activity)
    report, plan = compile_version(locked)
    if not report.passes():
        raise RulesetInvalidError(report, plan)

    old_status = "draft"
    _demote_prior_current(locked)
    locked.status = RulesetVersion.Status.FROZEN
    locked.frozen_by = current_operator
    locked.frozen_at = timezone.now()
    locked.is_current = True
    locked.execution_plan = json.dumps(plan.to_dict(), ensure_ascii=False)
    locked.save(
        update_fields=[
            "status",
            "frozen_by",
            "frozen_at",
            "is_current",
            "execution_plan",
        ]
    )
    AuditLog.objects.create(
        operator=current_operator,
        action_type=AuditLog.ActionType.FINALIZE_RULESET,
        target=f"RulesetVersion:{locked.pk}",
        old_value=json.dumps({"status": old_status}, ensure_ascii=False),
        new_value=json.dumps(
            {
                "status": RulesetVersion.Status.FROZEN,
                "content_hash": locked.content_hash,
                "error_count": 0,
            },
            ensure_ascii=False,
        ),
    )
    return locked
