"""Provision the built-in 2026 live challenge ruleset (§八).

The 2026 format's shape — 15 singers, 5 groups of 3, 10 seats, 5 challenge turns, the podium
keys, the two independent weight pairs — is already enforced at freeze by
:func:`ruleset.services.validate_binding` and ``_validate_2026_live_contract``. What this
module adds is *arrival*: creating a ruleset from the system built-in template also creates
the first-round physical round, binds it, and writes the platform-owned binding keys, so
staff only fill in the four operator items.

Nothing here locks anything. A built-in-derived ruleset stays an ordinary editable ruleset
whose values happen to be pre-filled.

The binding is written to :class:`~ruleset.models.ContestRuleset` and never to a
``RulesetVersion``: a version's ``binding`` is produced by ``_snapshot_binding`` at freeze
time and read from there, so anything written onto a draft version would never be read.
"""

from __future__ import annotations

import json

from accounts.services import require_current_staff
from common.authority import CONTEST_ROUND_STATE, authority_write
from common.lifecycle import runtime_is_test
from common.models import AuditLog
from core.services import lock_activity_for_action
from django.db import transaction
from django.db.models import Max

from .models import ContestRuleset, RulesetVersion
from .services import (
    LIVE_CHALLENGE_FORMAT_KEY,
    _snapshot_binding,
    create_ruleset_version,
    update_ruleset_binding,
)
from .templates import (
    LIVE_2026_BUILTIN_KEY,
    LIVE_2026_FIRST_ROUND_KEY,
    LIVE_2026_FIXED_COUNTS,
    LIVE_2026_PODIUM_KEYS,
    LIVE_2026_SEAT_COUNT,
)

LIVE_2026_FIRST_ROUND_NAME = "第一轮"


def is_live_2026_template(template) -> bool:
    """Whether a ``RulesetTemplate`` is the system built-in 2026 live format."""

    return template is not None and getattr(template, "builtin_key", "") == LIVE_2026_BUILTIN_KEY


def live_2026_binding_preset() -> dict:
    """The platform-owned binding keys: the part of the format that is not a choice.

    Deliberately excludes the four operator items — both weight pairs and both judge lists.
    The document leaves both ratios undecided and says we must not settle them for the
    operators (it names 40/60, 30/70 and 50/50 as ratios *we* may not pick), so a preset
    must never pre-fill them. Operators remain free to choose any pair that sums to 100%.
    """

    return {
        "format_key": LIVE_CHALLENGE_FORMAT_KEY,
        **LIVE_2026_FIXED_COUNTS,
        "order_policy": "official_number",
        **LIVE_2026_PODIUM_KEYS,
    }


def _first_round_for(ruleset: ContestRuleset):
    """The already-bound first round, or a freshly created one.

    Only the fields that are part of the format are set. ``judge_count``,
    ``minimum_judge_count`` and the rubric stay empty: those are the operator's, and the
    freeze contract refuses until they exist.
    """

    from singer_contest.models import ContestRound

    bound_id = (ruleset.round_keys or {}).get(LIVE_2026_FIRST_ROUND_KEY)
    if bound_id not in (None, ""):
        existing = ContestRound.objects.filter(pk=bound_id, activity_id=ruleset.activity_id).first()
        if existing is not None:
            return existing
    next_sequence = (
        ContestRound.objects.filter(activity_id=ruleset.activity_id).aggregate(
            max_sequence=Max("sequence")
        )["max_sequence"]
        or 0
    ) + 1
    with authority_write(CONTEST_ROUND_STATE):
        return ContestRound.objects.create(
            activity_id=ruleset.activity_id,
            round_type=ContestRound.RoundType.PRELIMINARY,
            sequence=next_sequence,
            name=LIVE_2026_FIRST_ROUND_NAME,
            scoring_mode=ContestRound.ScoringMode.AVERAGE,
            score_completion_mode=ContestRound.CompletionMode.MINIMUM_VALID,
            advance_count=LIVE_2026_SEAT_COUNT,
            roster_source=ContestRound.RosterSource.APPROVED,
        )


@transaction.atomic
def provision_live_2026_ruleset(activity, *, template, name, operator) -> RulesetVersion:
    """Create or reuse the activity's ruleset from the 2026 built-in, pre-filled.

    Mirrors an ordinary ruleset creation — one ``ContestRuleset`` per activity, a new DRAFT
    version from the template's definition — and adds the first round and the binding keys.
    """

    current_operator = require_current_staff(operator)
    lock_activity_for_action(activity)
    ruleset = ContestRuleset.objects.select_for_update().filter(activity=activity).first()
    if ruleset is None:
        ruleset = ContestRuleset(activity=activity, created_by=current_operator)
    ruleset.name = name or ruleset.name
    ruleset.source_template = template
    ruleset.is_test_data = runtime_is_test(activity)
    ruleset.save()

    contest_round = _first_round_for(ruleset)

    # Reuse the whole surface: ``update_ruleset_binding`` replaces every field it is given,
    # so a partial payload would clear the keys another editor already set.
    current = _snapshot_binding(ruleset)
    update_ruleset_binding(
        ruleset,
        binding={
            **current,
            "round_keys": {
                **current["round_keys"],
                LIVE_2026_FIRST_ROUND_KEY: contest_round.pk,
            },
            "live_challenge": {
                **(current.get("live_challenge") or {}),
                **live_2026_binding_preset(),
            },
        },
        operator=current_operator,
    )

    version = create_ruleset_version(
        ruleset, definition=template.definition, created_by=current_operator
    )
    # ``update_ruleset_binding`` writes no audit record of its own, so provisioning would
    # otherwise be invisible in the log.
    AuditLog.objects.create(
        operator=current_operator,
        action_type=AuditLog.ActionType.OTHER,
        target=f"ContestRuleset:{ruleset.pk}",
        new_value=json.dumps(
            {
                "template": template.builtin_key,
                "first_round": contest_round.pk,
                "live_challenge": live_2026_binding_preset(),
            },
            ensure_ascii=False,
        ),
        note="provision_live_2026_ruleset",
    )
    return version
