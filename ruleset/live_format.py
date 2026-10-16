"""Provision the built-in 2026 live challenge ruleset (§八).

The format is a *starting draft*, not a rule type. What is fixed is the algorithm — one
challenge turn per singer who missed an initial seat, seat inheritance, a weighted podium
that ignores the challenge scores — while the numbers beside it (participants, seats, groups,
both weight pairs, the judge lists) are the operators'. ``ruleset.services.validate_binding``
and ``_validate_2026_live_contract`` enforce that those numbers relate coherently; nothing
requires them to equal the built-in's pre-fill.

What this module adds is *arrival*: creating a ruleset from the system built-in template also
creates the first-round physical round, binds it, and writes the platform-owned binding keys,
so staff only fill in the four operator items. Nothing here locks anything — a
built-in-derived ruleset stays an ordinary editable ruleset whose values happen to be
pre-filled.

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
    FREEZE_GATE_LABELS,
    LIVE_CHALLENGE_FORMAT_KEY,
    RulesetInvalidError,
    _compile_frozen_definition,
    _live_first_round,
    _live_first_round_groups,
    _live_first_round_judges,
    _live_first_round_rubric,
    _live_first_round_seats,
    _normalize_live_challenge_weights,
    _normalize_live_counts,
    _normalize_live_judges,
    _normalize_live_podium,
    _prior_current_frozen,
    _snapshot_binding,
    _validate_2026_live_contract,
    _validate_frozen_questionnaire,
    _validate_successor_questionnaire,
    create_ruleset_version,
    current_frozen_round_ids,
    current_frozen_version,
    evaluate_freeze_gate,
    frozen_round_configuration_message,
    supersede_ruleset_version,
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
class ReadinessItem:
    """One line of the "准备清单".

    ``state`` is one of ``ready`` / ``blocked`` / ``unknown``: a row whose own precondition
    has not been met yet is genuinely unknown, and saying "missing" about it would be a second
    lie of the same kind as saying "ready" about it.
    """

    key: str
    label: str
    state: str
    message: str = ""

    @property
    def ready(self) -> bool:
        return self.state == "ready"

    @property
    def unknown(self) -> bool:
        return self.state == "unknown"


#: The 准备清单's rows, in the order an operator works through them. Each row names the
#: concern; the validator behind it is the freeze's own, never a second opinion beside it.
#: The keys the freeze gate also names come from there, so the two readings of one check
#: cannot end up calling it different things.
READINESS_LABELS: dict[str, str] = {
    "counts": "第一轮参赛人数、晋级人数与分组数自洽",
    "weights": "踢馆成绩权重（第一轮 + 踢馆）合计 100%",
    "podium": "冠亚季军成绩权重（第一轮 + 第三轮）合计 100%",
    "judges": "踢馆评委与第三轮评委齐备（含最低有效评委数）",
    "round_seats": "第一轮的晋级名额与分组都和配置一致",
    "round_judges": "第一轮按最低有效评委数评分并配好评委人数",
    "rubric": "第一轮配置统一评分标准",
    "round_contract": "现场赛制不依赖观众投票，且第一轮绑定了物理评分轮",
    **FREEZE_GATE_LABELS,
}

#: The rows the coarse ``round_contract`` row is the catch-all for.
_ROUND_ROW_KEYS = frozenset({"round_seats", "round_judges", "rubric"})


def freeze_blocker(version, *, binding: dict | None = None):
    """The first check the freeze would refuse on, or ``None`` when it would pass.

    This is the page's "正式冻结检查": it returns what
    :func:`~ruleset.services.evaluate_freeze_gate` reports, and that gate *is* the walk
    :func:`~ruleset.services.freeze_ruleset_version` performs. The checklist below may be
    more granular, but this line is by construction the answer the freeze button gives.
    """

    return evaluate_freeze_gate(version, binding=binding).blocker


def live_2026_readiness(version) -> list[ReadinessItem]:
    """Every 准备清单 row with its own verdict — no short-circuiting.

    The freeze asks "may I stop?" and the first refusal is the answer. This asks "what is
    still missing?" and has to answer all of it at once: a fresh built-in draft is missing
    the ratios, the judge panels, the rubric, the chorus grouping and usually the
    questionnaire, and a page that reports only the first of those is not a checklist.

    Every probe is the validator the freeze itself runs. Two rows are deliberately coarse —
    ``binding`` and ``round_contract`` — and appear only when their granular siblings all
    passed and the coarse validator still refuses, so a failure no granular row covers is
    reported rather than hidden behind "全部就绪".
    """

    ruleset = version.ruleset
    binding = _snapshot_binding(ruleset)
    live_config = binding.get("live_challenge") or {}
    if not live_config:
        return [_blocked_item("counts", "当前赛制尚未声明 2026 现场踢馆赛制。")]

    root = _definition_root(version)
    round_keys = binding.get("round_keys") or {}
    live_format_key = str(live_config.get("format_key") or "")
    items = [
        _readiness_item("counts", lambda: _normalize_live_counts(live_config)),
        _readiness_item(
            "weights",
            lambda: _normalize_live_challenge_weights(
                live_config, strict=True, live_format_key=live_format_key
            ),
        ),
        _readiness_item(
            "podium",
            lambda: _normalize_live_podium(
                live_config,
                strict=True,
                live_format_key=live_format_key,
                round_keys=round_keys,
            ),
        ),
        _readiness_item("judges", lambda: _normalize_live_judges(live_config, strict=True)),
    ]

    # The gate is the freeze's own walk. Its normalized binding is what the definition row
    # compiles against, and its verdict is what the page prints as the first blocker.
    evaluation = evaluate_freeze_gate(version)
    normalized = evaluation.normalized_binding
    if normalized is None and all(item.ready for item in items):
        items.append(
            _blocked_item(
                "binding",
                evaluation.blocker.message if evaluation.blocker else "赛制绑定未通过校验。",
            )
        )

    if normalized is None:
        items.append(_unknown_item("definition"))
    else:
        items.append(
            _readiness_item("definition", lambda: _compile_frozen_definition(version, normalized))
        )

    # The physical round's own rows read the stored surface directly, so they answer even
    # while the binding rows above are still refusing: "第一轮评分表还没填" is exactly what
    # the operator should be told at the same time as the ratios, not after them.
    try:
        first_round = _live_first_round(live_config, binding)
    except ValidationError as exc:
        items.append(_blocked_item("round_seats", _readiness_message(exc)))
    else:

        def _first_round_seats() -> None:
            """Everything the first round owns: the seat count's copies, and its grouping."""

            _live_first_round_seats(root, live_config, first_round)
            _live_first_round_groups(root, live_config, binding, first_round)

        items.append(_readiness_item("round_seats", _first_round_seats))
        items.append(_readiness_item("round_judges", lambda: _live_first_round_judges(first_round)))
        items.append(_readiness_item("rubric", lambda: _live_first_round_rubric(first_round)))

    if normalized is not None and all(item.ready for item in items if item.key in _ROUND_ROW_KEYS):
        items.append(
            _readiness_item(
                "round_contract", lambda: _validate_2026_live_contract(root, normalized)
            )
        )

    if normalized is None:
        items.append(_unknown_item("questionnaire"))
    else:
        items.append(
            _readiness_item(
                "questionnaire",
                lambda: _validate_frozen_questionnaire(version.definition, normalized),
            )
        )

    items.append(
        _readiness_item(
            "successor",
            lambda: _validate_successor_questionnaire(_prior_current_frozen(version), version),
        )
    )
    if evaluation.blocker is not None and evaluation.blocker.key == "finality":
        items.append(_blocked_item("finality", evaluation.blocker.message))
    else:
        items.append(_ready_item("finality"))
    return items


def _readiness_item(key: str, probe) -> ReadinessItem:
    """Run one validator on its own and report what it alone said."""

    try:
        probe()
    except (ValidationError, RulesetInvalidError, ValueError) as exc:
        return _blocked_item(key, _readiness_message(exc))
    return _ready_item(key)


def _ready_item(key: str) -> ReadinessItem:
    return ReadinessItem(key=key, label=READINESS_LABELS[key], state="ready")


def _blocked_item(key: str, message: str) -> ReadinessItem:
    return ReadinessItem(key=key, label=READINESS_LABELS[key], state="blocked", message=message)


def _unknown_item(key: str) -> ReadinessItem:
    return ReadinessItem(
        key=key,
        label=READINESS_LABELS[key],
        state="unknown",
        message="需要先完成上一项才能检查。",
    )


def _definition_root(version) -> dict:
    """The definition as the live-contract validators want it: a parsed mapping."""

    try:
        root = json.loads(version.definition)
    except (TypeError, ValueError):
        return {}
    return root if isinstance(root, dict) else {}


def _readiness_message(error: Exception) -> str:
    """A compile failure's first ERROR, for the checklist line."""

    report = getattr(error, "report", None)
    if report is None:
        messages = getattr(error, "messages", None)
        if messages:
            return " ".join(str(message) for message in messages)
        return str(error)
    errors = [issue.message for issue in report.issues if issue.severity.value == "error"]
    return errors[0] if errors else "赛制定义未通过校验。"


@dataclass(frozen=True)
class LiveChallengeCounts:
    """The 2026 numbers as the runtime reads them off a frozen binding.

    ``suggested_group_size`` is named that way on purpose. The stored binding key is still
    ``group_size`` — renaming it would strand the suggestion in every already-frozen binding
    and, because the binding is part of ``_authority_hash``, is not worth doing — but nothing
    validates it against anything, and a field called ``group_size`` beside the real contract
    ``group_count`` reads like a rule the actual, unequal group sizes would then violate.
    """

    participant_count: int
    seat_count: int
    group_count: int
    suggested_group_size: int
    challenge_count: int


def live_challenge_counts_from_binding(binding) -> LiveChallengeCounts:
    """Read the live counts out of a binding snapshot.

    ``group_count`` and the suggested group size are absent from every binding frozen before
    the counts became parameters. They default to the built-in 5x3 rather than being
    back-filled: the frozen binding is part of ``_authority_hash``, so rewriting one would
    invalidate every audited ``StageResult`` that already points at it.

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
        suggested_group_size=int(config.get("group_size") or LIVE_2026_GROUP_SIZE),
        challenge_count=participant_count - seat_count,
    )


def live_challenge_counts(version) -> LiveChallengeCounts:
    """Read the live counts off a ruleset version's frozen binding."""

    return live_challenge_counts_from_binding(getattr(version, "binding", None))


def _counts_if_binding_the_round(binding, contest_round):
    """The counts in ``binding``, but only when it is the one that binds this round."""

    config = (binding or {}).get("live_challenge") or {}
    if not isinstance(config, dict) or not config:
        return None
    first_round_key = str(config.get("podium_first_round_key") or LIVE_2026_FIRST_ROUND_KEY)
    bound = ((binding or {}).get("round_keys") or {}).get(first_round_key)
    if bound in (None, "") or str(bound) != str(contest_round.pk):
        return None
    return live_challenge_counts_from_binding(binding)


def live_challenge_counts_for_round(contest_round, *, require: bool = False, version=None):
    """Resolve the counts for the 2026 ruleset governing this physical round.

    The *current* frozen authority wins, and a historical caller must name its version
    explicitly. Scanning every ``FROZEN`` row for one that happens to bind this round would
    silently serve yesterday's numbers: a successor version may re-bind the same physical
    round, and ``_demote_prior_current`` only clears ``is_current`` — the superseded row stays
    ``FROZEN`` forever.

    Before the freeze the editable ``ContestRuleset`` surface carries the counts, which is the
    same fallback ``_live_group_stage_for_round`` uses.
    """

    if version is None:
        version = current_frozen_version(contest_round.activity)
    if version is not None:
        counts = _counts_if_binding_the_round(version.binding, contest_round)
        if counts is not None:
            return counts
    ruleset = ContestRuleset.objects.filter(activity_id=contest_round.activity_id).first()
    if ruleset is not None:
        pre_freeze = _bound_first_round(ruleset)
        if pre_freeze is not None and pre_freeze.pk == contest_round.pk:
            return live_challenge_counts_from_binding(_snapshot_binding(ruleset))
    if require:
        raise ValidationError("该轮次没有绑定当前已冻结的 2026 现场赛制。")
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
def apply_live_2026_counts(ruleset: ContestRuleset, version: RulesetVersion, *, operator):
    """Keep every copy of the seat count in step.

    Three facts carry it: the binding, the physical first round's ``advance_count`` (which is
    what writes ``ScoreSummary.is_advanced``, and what the challenge service reads), and the
    definition's qualifier SELECT. Leaving any one behind makes the numbers contradict each
    other, and the definition is the one that used to make a reshaped format unfreezable —
    the freeze check could only *report* that disagreement, never repair it, because
    rewriting a definition at freeze would move ``content_hash``.

    Repairing it while the version is still a DRAFT costs nothing: nothing is audited against
    a draft's hash yet.
    """

    from singer_contest.models import ContestRound

    from .services import _with_first_round_select_count, update_ruleset_definition_sections

    current_operator = require_current_staff(operator)
    lock_activity_for_action(ruleset.activity)
    locked = ContestRuleset.objects.select_for_update().get(pk=ruleset.pk)
    config = locked.live_challenge or {}
    if str(config.get("format_key") or "") != LIVE_CHALLENGE_FORMAT_KEY:
        return None
    seat_count = live_challenge_counts_from_binding(_snapshot_binding(locked)).seat_count
    first_round_key = str(config.get("podium_first_round_key") or LIVE_2026_FIRST_ROUND_KEY)

    contest_round = _bound_first_round(locked, lock=True)
    if contest_round is not None and contest_round.advance_count != seat_count:
        # A frozen authority owns its rounds' execution configuration. The frozen binding
        # keeps saying 10 seats while the round it binds advances 8, and the challenge
        # service reads the *binding* — so the venue would be told to seat ten singers the
        # round never produced, with no error until the first challenge session. A successor
        # draft re-shapes the format by binding a new round, not by moving this one.
        if contest_round.pk in current_frozen_round_ids(locked, excluding_version=version):
            raise ValidationError(
                frozen_round_configuration_message(contest_round.name or LIVE_2026_FIRST_ROUND_NAME)
            )
        if contest_round.status != ContestRound.Status.DRAFT or contest_round.is_locked:
            raise ValidationError(
                "第一轮已准备或已锁定，不能修改晋级人数。请先在轮次页面把它重置为草稿，"
                "再回到这里修改。"
            )
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

    locked_version = RulesetVersion._base_manager.select_for_update().get(pk=version.pk)
    if locked_version.status == RulesetVersion.Status.DRAFT:
        try:
            root = json.loads(locked_version.definition)
        except (TypeError, ValueError):
            root = None
        nodes = root.get("nodes") if isinstance(root, dict) else None
        if isinstance(nodes, list):
            updated = _with_first_round_select_count(nodes, first_round_key, seat_count)
            if updated is not None and updated != nodes:
                update_ruleset_definition_sections(
                    locked_version, sections={"nodes": updated}, operator=current_operator
                )
                AuditLog.objects.create(
                    operator=current_operator,
                    action_type=AuditLog.ActionType.OTHER,
                    target=f"RulesetVersion:{locked_version.pk}",
                    new_value=json.dumps({"select_count": seat_count}, ensure_ascii=False),
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
    """Create the activity's ruleset from the 2026 built-in, pre-filled — once.

    "Pre-filled" is an *arrival* property, not a reset button. Clicking the built-in again on
    an activity that already runs the 2026 format must not write the built-in's 15/5/10 back
    over the operators' 12/4/8, and must not leave a second DRAFT claiming the same shared
    ``ContestRuleset`` binding surface — an older draft built on the new numbers is exactly
    the "v2 的 definition 还写着 10" state the freeze contract later refuses.

    So the preset is applied only when the ruleset does not carry the 2026 format yet; after
    that this returns to the draft that already exists, or issues the successor of the frozen
    version if that is all there is.
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
    already_formatted = (
        str((ruleset.live_challenge or {}).get("format_key") or "") == LIVE_CHALLENGE_FORMAT_KEY
    )

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
            "live_challenge": (
                dict(current.get("live_challenge") or {})
                if already_formatted
                else live_2026_binding_preset()
            ),
        },
        operator=current_operator,
    )

    version = _arriving_or_existing_draft(
        ruleset, template=template, operator=current_operator, reuse=already_formatted
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
                "live_challenge": ("kept" if already_formatted else live_2026_binding_preset()),
            },
            ensure_ascii=False,
        ),
        note=(
            "provision_live_2026_ruleset_reuse"
            if already_formatted
            else "provision_live_2026_ruleset"
        ),
    )
    return version


def _arriving_or_existing_draft(
    ruleset: ContestRuleset, *, template, operator, reuse: bool
) -> RulesetVersion:
    """The version the operator continues on: a new one only when the format first arrives."""

    if reuse:
        draft = (
            ruleset.versions.filter(status=RulesetVersion.Status.DRAFT).order_by("-version").first()
        )
        if draft is not None:
            return draft
        frozen = (
            ruleset.versions.filter(status=RulesetVersion.Status.FROZEN)
            .order_by("-version")
            .first()
        )
        # The successor of the running authority, not a fresh copy of the built-in: the
        # operators' numbers live in the frozen definition and must come across.
        return (
            supersede_ruleset_version(frozen, created_by=operator)
            if frozen is not None
            else create_ruleset_version(
                ruleset, definition=template.definition, created_by=operator
            )
        )
    return create_ruleset_version(ruleset, definition=template.definition, created_by=operator)
