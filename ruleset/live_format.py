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
from dataclasses import dataclass

from accounts.services import require_current_staff
from common.authority import CONTEST_ROUND_STATE, authority_write
from common.lifecycle import runtime_is_test
from common.models import AuditLog
from core.services import lock_activity_for_action
from django.core.exceptions import ValidationError
from django.db import transaction
from django.db.models import Max

from .models import ContestRuleset, RulesetVersion
from .services import (
    LIVE_CHALLENGE_FORMAT_KEY,
    _snapshot_binding,
    create_ruleset_version,
    current_frozen_version,
    update_ruleset_binding,
)
from .templates import (
    LIVE_2026_BUILTIN_KEY,
    LIVE_2026_DEFAULTS,
    LIVE_2026_FIRST_ROUND_KEY,
    LIVE_2026_GROUP_COUNT,
    LIVE_2026_GROUP_SIZE,
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
        **LIVE_2026_DEFAULTS,
        "order_policy": "official_number",
        **LIVE_2026_PODIUM_KEYS,
    }


@dataclass(frozen=True)
class LiveChallengeCounts:
    """The 2026 numbers as the runtime reads them off a frozen binding."""

    participant_count: int
    seat_count: int
    group_count: int
    group_size: int
    challenge_count: int


def live_challenge_counts_from_binding(binding) -> LiveChallengeCounts:
    """Read the live counts out of a binding snapshot.

    ``group_count``/``group_size`` are absent from every binding frozen before the counts
    became parameters. They default to the built-in 5x3 rather than being back-filled: the
    frozen binding is part of ``_authority_hash``, so rewriting one would invalidate every
    audited ``StageResult`` that already points at it.

    踢馆人数 is derived, never read from storage — a stored mirror keeps the frozen record
    self-describing, but the arithmetic is the definition.
    """

    config = (binding or {}).get("live_challenge")
    if not isinstance(config, dict) or not config:
        raise ValidationError("冻结赛制尚未配置现场踢馆人数。")
    try:
        participant_count = int(config["participant_count"])
        seat_count = int(config["seat_count"])
    except (KeyError, TypeError, ValueError):
        raise ValidationError("冻结赛制的现场踢馆人数配置不完整。") from None
    return LiveChallengeCounts(
        participant_count=participant_count,
        seat_count=seat_count,
        group_count=int(config.get("group_count") or LIVE_2026_GROUP_COUNT),
        group_size=int(config.get("group_size") or LIVE_2026_GROUP_SIZE),
        challenge_count=participant_count - seat_count,
    )


def live_challenge_counts(version) -> LiveChallengeCounts:
    """Read the live counts off a ruleset version's frozen binding."""

    return live_challenge_counts_from_binding(getattr(version, "binding", None))


def live_challenge_counts_for_round(contest_round, *, require: bool = False):
    """Resolve the counts for whichever version binds this physical round.

    A frozen version wins; before the freeze the editable ``ContestRuleset`` surface already
    carries the counts, which is the same fallback ``_live_group_stage_for_round`` uses.
    """

    for binding in RulesetVersion._base_manager.filter(
        ruleset__activity_id=contest_round.activity_id,
        status=RulesetVersion.Status.FROZEN,
    ).values_list("binding", flat=True):
        config = (binding or {}).get("live_challenge") or {}
        if not isinstance(config, dict) or not config:
            continue
        first_round_key = str(config.get("podium_first_round_key") or LIVE_2026_FIRST_ROUND_KEY)
        bound = ((binding or {}).get("round_keys") or {}).get(first_round_key)
        if bound not in (None, "") and str(bound) == str(contest_round.pk):
            return live_challenge_counts_from_binding(binding)
    ruleset = ContestRuleset.objects.filter(activity_id=contest_round.activity_id).first()
    if ruleset is not None:
        binding = _snapshot_binding(ruleset)
        pre_freeze = _bound_first_round(ruleset)
        if pre_freeze is not None and pre_freeze.pk == contest_round.pk:
            return live_challenge_counts_from_binding(binding)
    if require:
        raise ValidationError("该轮次没有绑定任何已冻结的 2026 现场赛制。")
    return None


def live_challenge_counts_for_activity(activity, *, require: bool = False):
    """The counts governing an activity's live format, frozen version first."""

    version = current_frozen_version(activity)
    if version is not None:
        config = (version.binding or {}).get("live_challenge") or {}
        if isinstance(config, dict) and config:
            return live_challenge_counts_from_binding(version.binding)
    ruleset = ContestRuleset.objects.filter(activity=activity).first()
    if ruleset is not None and ruleset.live_challenge:
        return live_challenge_counts_from_binding(_snapshot_binding(ruleset))
    if require:
        raise ValidationError("该活动没有配置 2026 现场踢馆赛制。")
    return None


def _bound_first_round(ruleset: ContestRuleset, *, lock: bool = False):
    """The physical ContestRound the binding's first-round key points at, if any."""

    from singer_contest.models import ContestRound

    config = ruleset.live_challenge or {}
    if str(config.get("format_key") or "") != LIVE_CHALLENGE_FORMAT_KEY:
        return None
    first_round_key = str(config.get("podium_first_round_key") or LIVE_2026_FIRST_ROUND_KEY)
    round_id = (ruleset.round_keys or {}).get(first_round_key)
    if round_id in (None, ""):
        return None
    queryset = ContestRound.objects.select_for_update() if lock else ContestRound.objects
    return queryset.filter(pk=round_id, activity_id=ruleset.activity_id).first()


@transaction.atomic
def apply_live_2026_counts(ruleset: ContestRuleset, *, operator):
    """Keep the bound first round's ``advance_count`` equal to the binding's seat count.

    ``ScoreSummary.is_advanced`` is written from ``advance_count``, and the challenge service
    reads that flag to build the seats and the challenger queue. Editing the seat count
    without moving this value would make the configuration page lie in a new way.
    """

    from singer_contest.models import ContestRound

    current_operator = require_current_staff(operator)
    lock_activity_for_action(ruleset.activity)
    locked = ContestRuleset.objects.select_for_update().get(pk=ruleset.pk)
    contest_round = _bound_first_round(locked, lock=True)
    if contest_round is None:
        return None
    seat_count = live_challenge_counts_from_binding(_snapshot_binding(locked)).seat_count
    if contest_round.advance_count == seat_count:
        return contest_round
    if contest_round.status != ContestRound.Status.DRAFT or contest_round.is_locked:
        raise ValidationError("第一轮已准备或已锁定，不能修改晋级人数；请先回到草稿状态。")
    with authority_write(CONTEST_ROUND_STATE):
        contest_round.advance_count = seat_count
        contest_round.save(update_fields=["advance_count"])
    AuditLog.objects.create(
        operator=current_operator,
        action_type=AuditLog.ActionType.OTHER,
        target=f"ContestRound:{contest_round.pk}",
        new_value=json.dumps({"advance_count": seat_count}, ensure_ascii=False),
        note="apply_live_2026_counts",
    )
    return contest_round


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
