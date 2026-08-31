"""Freeze service for a DRAFT :class:`RulesetVersion` (§8.2, §16).

A ruleset becomes authoritative only through a *freeze*: the DRAFT version is
re-compiled, refused if the compiler reports any ERROR, and only then set to
``status=FROZEN`` with a frozen_by/frozen_at stamp and its execution plan
persisted. The bindings (round_keys / stage_key / announcement_blocks) are
snapshotted onto the version, so the frozen version is self-authoritative: the
runtime never re-reads the mutable ``ContestRuleset`` binding fields. The prior
current version (which is FROZEN) is demoted so the one-current partial unique
constraint holds and never violates the queryset's immutable guard — that demotion
goes through :class:`RulesetVersion._base_manager`.

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
from .models import ContestRuleset, RulesetVersion


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


def _snapshot_binding(ruleset: ContestRuleset) -> dict:
    """Read the binding off a ruleset at freeze time (the editable input surface)."""
    return {
        "stage_key": ruleset.stage_key or "",
        "round_keys": dict(ruleset.round_keys or {}),
        "announcement_blocks": list(ruleset.announcement_blocks or []),
    }


def validate_binding(ruleset: ContestRuleset, binding: dict | None) -> dict:
    """Normalize and validate a binding snapshot against the ruleset's activity.

    Only round keys that resolve to a ``ContestRound`` owned by the same activity are
    accepted (a binding may only reference its own rounds). Returns a normalized dict
    with ``{stage_key, round_keys, announcement_blocks}``.
    """
    binding = dict(binding or {})
    raw_round_keys = binding.get("round_keys") or {}
    if not isinstance(raw_round_keys, dict):
        raise ValidationError("round_keys 必须是 {round_key: round_pk} 映射。")
    normalized_round_keys: dict[str, int] = {}
    for key, rid in raw_round_keys.items():
        try:
            normalized_round_keys[str(key)] = int(rid)
        except (TypeError, ValueError):
            raise ValidationError(f"round_keys['{key}'] 必须是比赛轮次 id，got {rid!r}。")
    announcement_blocks = binding.get("announcement_blocks") or []
    if not isinstance(announcement_blocks, list):
        raise ValidationError("announcement_blocks 必须是列表。")

    from singer_contest.models import ContestRound

    round_ids = list(normalized_round_keys.values())
    owned = {
        r.pk: r for r in ContestRound.objects.filter(pk__in=round_ids, activity=ruleset.activity_id)
    }
    missing = [rid for rid in round_ids if rid not in owned]
    if missing:
        raise ValidationError(f"赛制绑定的比赛轮次不属于该活动：{missing}")
    return {
        "stage_key": str(binding.get("stage_key") or "").strip(),
        "round_keys": normalized_round_keys,
        "announcement_blocks": announcement_blocks,
    }


@transaction.atomic
def freeze_ruleset_version(
    version: RulesetVersion, operator, *, binding: dict | None = None
) -> RulesetVersion:
    """Freeze a DRAFT ruleset version, snapshotting its binding. Returns the locked, frozen version.

    ``binding`` is optional: when omitted, the ruleset's current binding fields are
    snapshotted verbatim (the default for an existing editor flow). When provided, it is
    validated and becomes the snapshot. Raises :class:`PermissionDenied` if the operator
    is not an effective admin or the activity is locked; :class:`ValidationError` if the
    version is already frozen or the binding is invalid; :class:`RulesetInvalidError` if
    compilation reports any ERROR.
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

    freeze_binding = _snapshot_binding(locked.ruleset) if binding is None else binding
    normalized_binding = validate_binding(locked.ruleset, freeze_binding)

    old_status = "draft"
    _demote_prior_current(locked)
    locked.status = RulesetVersion.Status.FROZEN
    locked.frozen_by = current_operator
    locked.frozen_at = timezone.now()
    locked.is_current = True
    locked.execution_plan = json.dumps(plan.to_dict(), ensure_ascii=False)
    locked.binding = normalized_binding
    locked.save(
        update_fields=[
            "status",
            "frozen_by",
            "frozen_at",
            "is_current",
            "execution_plan",
            "binding",
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
                "binding": normalized_binding,
                "error_count": 0,
            },
            ensure_ascii=False,
        ),
    )
    return locked


@transaction.atomic
def supersede_ruleset_version(
    version: RulesetVersion, *, created_by, definition: str | None = None
) -> RulesetVersion:
    """Create the next DRAFT version that supersedes a FROZEN one (the editing target).

    The successor copies the frozen definition and binding, is numbered ``max(version)+1``,
    and becomes the single ``is_current`` version (the prior FROZEN current is demoted
    through the base manager so the one-current partial unique constraint holds). Freezing
    the successor later re-promotes it to current FROZEN.
    """
    locked = (
        RulesetVersion.objects.select_for_update()
        .select_related("ruleset__activity")
        .get(pk=version.pk)
    )
    if locked.status != RulesetVersion.Status.FROZEN:
        raise ValidationError("只有已冻结的赛制版本可以被继任覆盖。")
    lock_activity_for_action(locked.ruleset.activity)
    last = locked.ruleset.versions.order_by("-version").values_list("version", flat=True).first()
    next_version = (last or 0) + 1
    RulesetVersion._base_manager.filter(ruleset_id=locked.ruleset_id, is_current=True).update(
        is_current=False
    )
    return RulesetVersion.objects.create(
        ruleset=locked.ruleset,
        version=next_version,
        definition=definition if definition is not None else locked.definition,
        binding=locked.binding,
        is_current=True,
        status=RulesetVersion.Status.DRAFT,
        created_by=created_by,
    )


@transaction.atomic
def create_ruleset_version(
    ruleset: ContestRuleset, *, definition: str, created_by, binding: dict | None = None
) -> RulesetVersion:
    """Create the next version on a ruleset, preserving the one-current invariant.

    Used by ruleset creation and template clones. The new DRAFT becomes the single
    ``is_current`` version (any prior current is demoted through the base manager), and
    numbering uses ``max(version)+1`` to avoid the unique ``(ruleset, version)``
    collision when a ruleset — or an activity's ruleset — is cloned repeatedly.
    """
    locked = ContestRuleset.objects.select_for_update().get(pk=ruleset.pk)
    last = locked.versions.order_by("-version").values_list("version", flat=True).first()
    next_version = (last or 0) + 1
    RulesetVersion._base_manager.filter(ruleset_id=locked.pk, is_current=True).update(
        is_current=False
    )
    return RulesetVersion.objects.create(
        ruleset=locked,
        version=next_version,
        definition=definition,
        binding=dict(binding or {}),
        is_current=True,
        created_by=created_by,
    )
